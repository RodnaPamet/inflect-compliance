import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, forbidden, notFound } from '@/lib/errors/types';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { logEvent } from '../events/audit';
import { assertAgentGovernanceWrite } from '../policies/agent-governance.policies';

/**
 * A kill per HOST CONSUMER (#3861) — threat-model R11 for the second inbound
 * principal, mirroring `a2a-peer-kill` exactly.
 *
 * This is not a convenience. It is the term that makes a STATELESS access token
 * acceptable (R26): there is no way to revoke one token individually, so the
 * ability to stop a consumer at once — and have that stop its live tokens on
 * their next request — is what stands in for per-token revocation. Admission
 * and the token endpoint both read this UNCACHED on every call, and R26 says
 * in as many words that caching either read turns it from closed back to open.
 */

const KILL_SELECT = {
    id: true,
    hostConsumerId: true,
    reason: true,
    engagedByUserId: true,
    engagedAt: true,
    liftedAt: true,
    liftedByUserId: true,
    liftReason: true,
} as const;

function requireReason(raw: unknown, field: string): string {
    if (typeof raw !== 'string') throw badRequest(`\`${field}\` is required.`);
    const reason = sanitizePlainText(raw).trim();
    if (reason.length === 0) throw badRequest(`\`${field}\` is required.`);
    if (reason.length > 2000) throw badRequest(`\`${field}\` must be 2000 characters or fewer.`);
    return reason;
}

function inForce(tenantId: string, hostConsumerId: string) {
    return { tenantId, hostConsumerId, liftedAt: null };
}

/** Is a kill in force? Read UNCACHED, on every inbound request and token mint. */
export async function resolveHostConsumerKill(
    ctx: RequestContext,
    hostConsumerId: string,
): Promise<{ switchId: string; engagedAt: Date } | null> {
    const row = await runInTenantContext(ctx, (db) =>
        db.hostConsumerKillSwitch.findFirst({
            where: inForce(ctx.tenantId, hostConsumerId),
            select: { id: true, engagedAt: true },
        }),
    );
    return row ? { switchId: row.id, engagedAt: row.engagedAt } : null;
}

export async function engageHostConsumerKill(
    ctx: RequestContext,
    hostConsumerId: string,
    input: { reason?: unknown },
) {
    assertAgentGovernanceWrite(ctx, 'agent_kill_switch');
    const reason = requireReason(input.reason, 'reason');
    return runInTenantContext(ctx, async (db) => {
        const consumer = await db.hostConsumer.findFirst({
            where: { id: hostConsumerId, tenantId: ctx.tenantId },
            select: { id: true },
        });
        if (!consumer) throw notFound('Host consumer not found');

        // Idempotent: an operator pressing stop twice during an incident is
        // told it is stopped rather than given a conflict. The partial unique
        // index is the authority — at most one kill in force per consumer.
        const existing = await db.hostConsumerKillSwitch.findFirst({
            where: inForce(ctx.tenantId, hostConsumerId),
            select: KILL_SELECT,
        });
        if (existing) return { ...existing, alreadyInForce: true as const };

        const row = await db.hostConsumerKillSwitch.create({
            data: { tenantId: ctx.tenantId, hostConsumerId, reason, engagedByUserId: ctx.userId },
            select: KILL_SELECT,
        });
        await logEvent(db, ctx, {
            action: 'HOST_CONSUMER_KILL_ENGAGED',
            entityType: 'HostConsumer',
            entityId: hostConsumerId,
            details: `Kill engaged on A2A host consumer ${hostConsumerId}`,
            detailsJson: {
                category: 'access',
                entityName: 'HostConsumerKillSwitch',
                operation: 'create',
                // The reason is tenant free text, encrypted at rest, and stays
                // on the switch row rather than being copied into the trail.
                after: { switchId: row.id, hostConsumerId, engagedByUserId: ctx.userId },
            },
        });
        return { ...row, alreadyInForce: false as const };
    });
}

export async function liftHostConsumerKill(
    ctx: RequestContext,
    hostConsumerId: string,
    input: { liftReason?: unknown },
) {
    assertAgentGovernanceWrite(ctx, 'agent_kill_switch');
    // Lifted only by a person, as a peer's kill is: restoring traffic from an
    // outside system is a decision someone is answerable for.
    if (ctx.apiKeyId) throw forbidden('A host-consumer kill is lifted by a person, not by an API key');
    const liftReason = requireReason(input.liftReason, 'liftReason');
    return runInTenantContext(ctx, async (db) => {
        const existing = await db.hostConsumerKillSwitch.findFirst({
            where: inForce(ctx.tenantId, hostConsumerId),
            select: { id: true },
        });
        if (!existing) throw notFound('No kill is in force for this host consumer');

        const row = await db.hostConsumerKillSwitch.update({
            where: { id: existing.id },
            data: { liftedAt: new Date(), liftedByUserId: ctx.userId, liftReason },
            select: KILL_SELECT,
        });
        await logEvent(db, ctx, {
            action: 'HOST_CONSUMER_KILL_LIFTED',
            entityType: 'HostConsumer',
            entityId: hostConsumerId,
            details: `Kill lifted on A2A host consumer ${hostConsumerId}`,
            detailsJson: {
                category: 'access',
                entityName: 'HostConsumerKillSwitch',
                operation: 'update',
                after: { switchId: row.id, hostConsumerId, liftedByUserId: ctx.userId },
            },
        });
        return row;
    });
}

/** Every kill this tenant has engaged on a host consumer, newest first. */
export async function listHostConsumerKills(ctx: RequestContext, hostConsumerId?: string) {
    assertAgentGovernanceWrite(ctx, 'agent_kill_switch');
    return runInTenantContext(ctx, (db) =>
        db.hostConsumerKillSwitch.findMany({
            where: { tenantId: ctx.tenantId, ...(hostConsumerId ? { hostConsumerId } : {}) },
            orderBy: { engagedAt: 'desc' },
            take: 200,
            select: KILL_SELECT,
        }),
    );
}
