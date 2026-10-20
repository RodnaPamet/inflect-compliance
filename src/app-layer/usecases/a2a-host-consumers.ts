import { z } from 'zod';

import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { generateHostConsumerCredentials } from '@/lib/agentic/a2a/host-consumer';

import { assertOwnerInTenant } from './vendor-link-targets';

import type { RequestContext } from '@/app-layer/types';

/**
 * Creating, rotating and revoking a HOST CONSUMER (#3861).
 *
 * Gated on `admin.agent_registry` — the owner's decision, recorded in ADR 0003
 * with the reservation it accepts: a host consumer is "whom may call us", which
 * is register-shaped rather than call-shaped, so R3's own logic points at the
 * register key. The reservation is that this bundles admitting an outside
 * system with managing our own register.
 *
 * AND NEVER BY AN API KEY, as a peer credential is never issued by one. A
 * credential that admits an external system into the tenant is issued by a
 * person who can be named in the audit row, not by a token that cannot.
 */

function assertMayManage(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Managing an A2A host consumer requires admin.agent_registry');
    }
    if (ctx.apiKeyId) {
        throw forbidden('An A2A host consumer is created and revoked by a person, not by an API key');
    }
}

const CONSUMER_SELECT = {
    id: true,
    name: true,
    clientId: true,
    clientSecretPrefix: true,
    ownerUserId: true,
    receivingAgentId: true,
    workflowKeys: true,
    status: true,
    inboundMessagesPerHour: true,
    revokedAt: true,
    createdAt: true,
} as const;

const CreateHostConsumerSchema = z.object({
    name: z.string().trim().min(1).max(200),
    ownerUserId: z.string().min(1).max(64),
    receivingAgentId: z.string().min(1).max(64),
    /** Empty admits NOTHING — deny by default, as the column's CHECK implies. */
    workflowKeys: z.array(z.string().trim().min(1).max(200)).min(1).max(50),
    inboundMessagesPerHour: z.number().int().min(1).max(1000).optional(),
});

/**
 * Create a host consumer and hand back its secret ONCE.
 *
 * The secret is returned here and never again: only its SHA-256 is stored, as
 * `PeerAgentInboundCredential` and `TenantApiKey` do. An operator who loses it
 * rotates rather than recovers.
 */
export async function createHostConsumer(ctx: RequestContext, input: unknown) {
    assertMayManage(ctx);
    const parsed = CreateHostConsumerSchema.parse(input);
    const workflowKeys = [...new Set(parsed.workflowKeys.map((k) => k.trim()))];
    for (const key of workflowKeys) {
        if (!getWorkflowDefinition(key)) throw badRequest(`Unknown workflow: ${key}`);
    }
    const creds = generateHostConsumerCredentials();

    const consumer = await runInTenantContext(ctx, async (db) => {
        await assertOwnerInTenant(db, ctx, parsed.ownerUserId);
        const agent = await db.registeredAgent.findFirst({
            where: { id: parsed.receivingAgentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, status: true },
        });
        if (!agent) throw badRequest('The receiving agent does not exist in this tenant');
        if (agent.status === 'RETIRED') throw badRequest('A retired agent cannot receive A2A requests');

        const row = await db.hostConsumer.create({
            data: {
                tenantId: ctx.tenantId,
                name: parsed.name,
                clientId: creds.clientId,
                clientSecretHash: creds.secretHash,
                clientSecretPrefix: creds.secretPrefix,
                ownerUserId: parsed.ownerUserId,
                receivingAgentId: agent.id,
                workflowKeys,
                createdByUserId: ctx.userId,
                ...(parsed.inboundMessagesPerHour === undefined
                    ? {}
                    : { inboundMessagesPerHour: parsed.inboundMessagesPerHour }),
            },
            select: CONSUMER_SELECT,
        });
        await logEvent(db, ctx, {
            action: 'HOST_CONSUMER_CREATED',
            entityType: 'HostConsumer',
            entityId: row.id,
            details: `Created A2A host consumer ${row.name}`,
            detailsJson: {
                category: 'access',
                entityName: 'HostConsumer',
                operation: 'created',
                // The client id is public; the secret and its hash are never
                // written to an audit row, only the displayed prefix.
                after: {
                    hostConsumerId: row.id,
                    clientId: row.clientId,
                    clientSecretPrefix: row.clientSecretPrefix,
                    ownerUserId: row.ownerUserId,
                    receivingAgentId: row.receivingAgentId,
                    workflowKeys,
                },
            },
        });
        return row;
    });

    return { consumer, clientSecret: creds.secretPlaintext };
}

/**
 * Replace the secret, keeping the client id.
 *
 * Keeping the id is the point: a BTP destination holds both, and rotating the
 * id too would make every rotation a destination rewrite rather than a secret
 * change. The old secret stops working the moment this returns.
 */
export async function rotateHostConsumerSecret(ctx: RequestContext, hostConsumerId: string) {
    assertMayManage(ctx);
    const creds = generateHostConsumerCredentials();

    const consumer = await runInTenantContext(ctx, async (db) => {
        const before = await db.hostConsumer.findFirst({
            where: { id: hostConsumerId, tenantId: ctx.tenantId },
            select: { id: true, name: true, status: true, revokedAt: true, clientSecretPrefix: true },
        });
        if (!before) throw notFound('Host consumer not found');
        if (before.revokedAt !== null || before.status === 'RETIRED') {
            throw badRequest('A revoked host consumer cannot be rotated. Create a new one');
        }
        const row = await db.hostConsumer.update({
            where: { id: hostConsumerId },
            data: { clientSecretHash: creds.secretHash, clientSecretPrefix: creds.secretPrefix },
            select: CONSUMER_SELECT,
        });
        await logEvent(db, ctx, {
            action: 'HOST_CONSUMER_SECRET_ROTATED',
            entityType: 'HostConsumer',
            entityId: row.id,
            details: `Rotated the secret of A2A host consumer ${row.name}`,
            detailsJson: {
                category: 'access',
                entityName: 'HostConsumer',
                operation: 'updated',
                before: { clientSecretPrefix: before.clientSecretPrefix },
                after: { clientSecretPrefix: row.clientSecretPrefix },
            },
        });
        return row;
    });

    return { consumer, clientSecret: creds.secretPlaintext };
}

/**
 * Revoke a host consumer: it issues no more tokens and its live ones stop
 * working at the next request, because admission re-reads this row uncached.
 *
 * One way, as a peer's retirement is. The row is KEPT — it is the record of
 * what a host could reach and when (`data-retention.md` classes it Security
 * ephemeral), and `HostConsumerMessage` outlives even that.
 */
export async function revokeHostConsumer(ctx: RequestContext, hostConsumerId: string) {
    assertMayManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        const before = await db.hostConsumer.findFirst({
            where: { id: hostConsumerId, tenantId: ctx.tenantId },
            select: { id: true, name: true, status: true, revokedAt: true },
        });
        if (!before) throw notFound('Host consumer not found');
        if (before.revokedAt !== null) throw conflict('This host consumer is already revoked');

        const row = await db.hostConsumer.update({
            where: { id: hostConsumerId },
            data: { revokedAt: new Date(), revokedByUserId: ctx.userId, status: 'RETIRED' },
            select: CONSUMER_SELECT,
        });
        await logEvent(db, ctx, {
            action: 'HOST_CONSUMER_REVOKED',
            entityType: 'HostConsumer',
            entityId: row.id,
            details: `Revoked A2A host consumer ${row.name}`,
            detailsJson: {
                category: 'access',
                entityName: 'HostConsumer',
                operation: 'updated',
                before: { status: before.status, revokedAt: null },
                after: { status: row.status, revokedAt: row.revokedAt },
            },
        });
        return row;
    });
}

/** The tenant's host consumers. Never a secret or a hash — only the prefix. */
export async function listHostConsumers(ctx: RequestContext) {
    if (!ctx.appPermissions.admin.agent_registry && !ctx.appPermissions.admin.agent_registry_view) {
        throw forbidden('Viewing A2A host consumers requires admin.agent_registry_view');
    }
    return runInTenantContext(ctx, (db) =>
        db.hostConsumer.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 200,
            select: CONSUMER_SELECT,
        }),
    );
}
