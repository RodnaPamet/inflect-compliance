/**
 * The keys a tenant trusts to sign harness reports (#3665).
 *
 * Registering one is the decision about whose reports count, so it takes
 * `admin.agent_registry` — the authority that admits agents — and never the
 * scanner's own `agent_harness_ingest`. A scanner that could register its own
 * key could vouch for any report it liked.
 *
 * Each key belongs to one registered agent, the scanner. A key is identified by
 * the SHA-256 of its SPKI form, so the hex and base64 spellings of one key are
 * one key. A revoked key verifies nothing from then on; its row stays, because
 * the scans it signed name it.
 */
import { z } from 'zod';

import type { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { isAgentRetiredDbRefusal, RETIREMENT_KEY_ID_CAP } from '@/lib/agentic/agent-retirement';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';

export const AddHarnessScannerKeySchema = z
    .object({
        agentId: z.string().min(1).max(64),
        publicKey: z.string().min(1).max(256),
    })
    .strict();

const RETIRED_SCANNER_MESSAGE = 'A retired agent cannot be given a scanner key';

function assertMayManageKeys(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Managing harness scanner keys requires admin.agent_registry');
    }
}

export async function addHarnessScannerKey(ctx: RequestContext, input: z.infer<typeof AddHarnessScannerKeySchema>) {
    assertMayManageKeys(ctx);
    const fingerprint = harnessKeyFingerprint(input.publicKey);
    if (!fingerprint) throw badRequest('publicKey is not an Ed25519 public key (raw 32 bytes, hex or base64)');

    return runInTenantContext(ctx, async (db) => {
        const agent = await db.registeredAgent.findFirst({
            where: { id: input.agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, status: true },
        });
        if (!agent) throw notFound('Registered agent not found');
        if (agent.status === 'RETIRED') throw badRequest(RETIRED_SCANNER_MESSAGE);

        const existing = await db.agentHarnessScannerKey.findFirst({
            where: { tenantId: ctx.tenantId, keyFingerprint: fingerprint },
            select: { id: true },
        });
        if (existing) throw conflict('This key is already registered for this tenant');

        // The status read above is unlocked; a retirement committing after it
        // would otherwise leave this key unrevoked behind the cascade, still
        // verifying reports. The insert trigger takes FOR SHARE on the agent row
        // and refuses once it reads RETIRED (#3698) — mapped to the same answer.
        let key;
        try {
            key = await db.agentHarnessScannerKey.create({
                data: {
                    tenantId: ctx.tenantId,
                    agentId: agent.id,
                    publicKey: input.publicKey.trim(),
                    keyFingerprint: fingerprint,
                    createdByUserId: ctx.userId,
                },
                select: { id: true, agentId: true, keyFingerprint: true, createdAt: true },
            });
        } catch (err) {
            if (isAgentRetiredDbRefusal(err)) throw badRequest(RETIRED_SCANNER_MESSAGE);
            throw err;
        }
        await logEvent(db, ctx, {
            action: 'AGENT_HARNESS_SCANNER_KEY_ADDED',
            entityType: 'AgentHarnessScannerKey',
            entityId: key.id,
            details: `Trusted a harness scanner key for agent ${agent.id}`,
            detailsJson: {
                category: 'access',
                entityName: 'AgentHarnessScannerKey',
                operation: 'created',
                after: { agentId: agent.id, keyFingerprint: key.keyFingerprint },
            },
        });
        return key;
    });
}

export async function listHarnessScannerKeys(ctx: RequestContext) {
    assertMayManageKeys(ctx);
    return runInTenantContext(ctx, (db) =>
        db.agentHarnessScannerKey.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { createdAt: 'desc' },
            take: 200,
            select: {
                id: true,
                agentId: true,
                keyFingerprint: true,
                createdByUserId: true,
                createdAt: true,
                revokedAt: true,
                revokedByUserId: true,
            },
        }),
    );
}

/**
 * Revoke every scanner key bound to one agent, inside a transaction the caller
 * already holds — retirement's scanner-key effect (#3698).
 *
 * Here rather than in the cascade module because this file is the one write
 * seam for `AgentHarnessScannerKey` (`agent-harness-single-write-seam`), and a
 * second writer is the hole that guard exists to keep shut. A retired scanner's
 * key would otherwise go on verifying harness reports: ingest trusts every
 * unrevoked key the tenant registered, whatever became of the scanner.
 *
 * No gate and no audit row of its own. The caller is the retirement cascade,
 * gated on `admin.agent_registry` — the key this file's own verbs take — and it
 * writes the audit row for the effect, alongside the others, after every write.
 */
export async function revokeScannerKeysForAgentInTx(
    db: PrismaTx,
    ctx: RequestContext,
    agentId: string,
    now: Date,
): Promise<{ count: number; ids: string[] }> {
    const live = await db.agentHarnessScannerKey.findMany({
        where: { tenantId: ctx.tenantId, agentId, revokedAt: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        // The ids are for the audit row; the write below is unbounded.
        take: RETIREMENT_KEY_ID_CAP + 1,
    });
    const revoked = await db.agentHarnessScannerKey.updateMany({
        where: { tenantId: ctx.tenantId, agentId, revokedAt: null },
        data: { revokedAt: now, revokedByUserId: ctx.userId },
    });
    return { count: revoked.count, ids: live.map((k) => k.id) };
}

export async function revokeHarnessScannerKey(ctx: RequestContext, input: { keyId: string }) {
    assertMayManageKeys(ctx);
    return runInTenantContext(ctx, async (db) => {
        const revoked = await db.agentHarnessScannerKey.updateMany({
            where: { id: input.keyId, tenantId: ctx.tenantId, revokedAt: null },
            data: { revokedAt: new Date(), revokedByUserId: ctx.userId },
        });
        if (revoked.count === 0) throw notFound('Active scanner key not found');
        await logEvent(db, ctx, {
            action: 'AGENT_HARNESS_SCANNER_KEY_REVOKED',
            entityType: 'AgentHarnessScannerKey',
            entityId: input.keyId,
            details: `Revoked harness scanner key ${input.keyId}`,
            detailsJson: { category: 'access', entityName: 'AgentHarnessScannerKey', operation: 'revoked' },
        });
        return { id: input.keyId, revoked: true };
    });
}
