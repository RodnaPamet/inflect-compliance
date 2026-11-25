/**
 * The keys a tenant trusts to sign probe reports (`scanent-probes/1`; active
 * flavour, step 8a) — the ONLY writer of `AgentProberKey`.
 *
 * The twin of `agent-harness-scanner-keys.ts`, in a register of its own by the
 * owner's decision (2026-11-25): a probe report is signed by a PROBER key, and
 * a scanner key never vouches for one. Registering a key is the decision about
 * whose probe reports count, so it takes `admin.agent_registry` — the authority
 * that admits agents — and never the prober's own `agent_probes_ingest`: a
 * prober that could register its own key could vouch for any report it liked.
 *
 * Each key belongs to one registered agent, the prober. A key is identified by
 * the SHA-256 of its SPKI form (`harnessKeyFingerprint`), so the hex and base64
 * spellings of one key are one key. A key live in the approver register is
 * refused here, and the reverse (`probe_key_registers_disjoint()`): the party
 * that runs probes never authorises them. A revoked key verifies nothing from
 * then on; its row stays, because the runs it signed name it.
 */
import { z } from 'zod';

import type { RequestContext } from '../types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { isAgentRetiredDbRefusal, RETIREMENT_KEY_ID_CAP } from '@/lib/agentic/agent-retirement';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';

export const AddAgentProberKeySchema = z
    .object({
        agentId: z.string().min(1).max(64),
        publicKey: z.string().min(1).max(256),
    })
    .strict();

const RETIRED_PROBER_MESSAGE = 'A retired agent cannot be given a prober key';
export const PROBE_KEY_IN_OTHER_REGISTER = 'PROBE_KEY_IN_OTHER_REGISTER';
const IN_APPROVER_REGISTER_MESSAGE =
    'This key is registered as a probe approver key: the party that runs probes never authorises them';

/** The registers' disjointness trigger refused the insert. */
export function isProbeKeyOverlapDbRefusal(err: unknown): boolean {
    return err instanceof Error && err.message.includes(`${PROBE_KEY_IN_OTHER_REGISTER}:`);
}

function assertMayManageKeys(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Managing prober keys requires admin.agent_registry');
    }
}

export async function addAgentProberKey(ctx: RequestContext, input: z.infer<typeof AddAgentProberKeySchema>) {
    assertMayManageKeys(ctx);
    const fingerprint = harnessKeyFingerprint(input.publicKey);
    if (!fingerprint) throw badRequest('publicKey is not an Ed25519 public key (raw 32 bytes, hex or base64)');

    return runInTenantContext(ctx, async (db) => {
        const agent = await db.registeredAgent.findFirst({
            where: { id: input.agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, status: true },
        });
        if (!agent) throw notFound('Registered agent not found');
        if (agent.status === 'RETIRED') throw badRequest(RETIRED_PROBER_MESSAGE);

        const existing = await db.agentProberKey.findFirst({
            where: { tenantId: ctx.tenantId, keyFingerprint: fingerprint },
            select: { id: true },
        });
        if (existing) throw conflict('This key is already registered as a prober key for this tenant');
        const approver = await db.probeApproverKey.findFirst({
            where: { tenantId: ctx.tenantId, keyFingerprint: fingerprint, revokedAt: null },
            select: { id: true },
        });
        if (approver) throw conflict(IN_APPROVER_REGISTER_MESSAGE);

        // The reads above are unlocked. The insert triggers take FOR SHARE on
        // the agent row (a retirement committing meanwhile) and a per-tenant
        // lock before looking at the approver register (a registration of the
        // same key there meanwhile); each refusal maps to the answer above.
        let key;
        try {
            key = await db.agentProberKey.create({
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
            if (isAgentRetiredDbRefusal(err)) throw badRequest(RETIRED_PROBER_MESSAGE);
            if (isProbeKeyOverlapDbRefusal(err)) throw conflict(IN_APPROVER_REGISTER_MESSAGE);
            throw err;
        }
        await logEvent(db, ctx, {
            action: 'AGENT_PROBER_KEY_ADDED',
            entityType: 'AgentProberKey',
            entityId: key.id,
            details: `Trusted a prober key for agent ${agent.id}`,
            detailsJson: {
                category: 'access',
                entityName: 'AgentProberKey',
                operation: 'created',
                after: { agentId: agent.id, keyFingerprint: key.keyFingerprint },
            },
        });
        return key;
    });
}

export async function listAgentProberKeys(ctx: RequestContext) {
    assertMayManageKeys(ctx);
    return runInTenantContext(ctx, (db) =>
        db.agentProberKey.findMany({
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
 * Revoke every prober key bound to one agent, inside a transaction the caller
 * already holds — retirement's prober-key effect.
 *
 * Here rather than in the cascade module because this file is the one write
 * seam for `AgentProberKey` (`agent-harness-single-write-seam`). A retired
 * prober's key would otherwise go on verifying probe reports: ingest trusts
 * every unrevoked key the tenant registered, whatever became of the prober.
 *
 * No gate and no audit row of its own. The caller is the retirement cascade,
 * gated on `admin.agent_registry` — the key this file's own verbs take — and it
 * writes the audit row for the effect, alongside the others, after every write.
 */
export async function revokeProberKeysForAgentInTx(
    db: PrismaTx,
    ctx: RequestContext,
    agentId: string,
    now: Date,
): Promise<{ count: number; ids: string[] }> {
    const live = await db.agentProberKey.findMany({
        where: { tenantId: ctx.tenantId, agentId, revokedAt: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        // The ids are for the audit row; the write below is unbounded.
        take: RETIREMENT_KEY_ID_CAP + 1,
    });
    const revoked = await db.agentProberKey.updateMany({
        where: { tenantId: ctx.tenantId, agentId, revokedAt: null },
        data: { revokedAt: now, revokedByUserId: ctx.userId },
    });
    return { count: revoked.count, ids: live.map((k) => k.id) };
}

export async function revokeAgentProberKey(ctx: RequestContext, input: { keyId: string }) {
    assertMayManageKeys(ctx);
    return runInTenantContext(ctx, async (db) => {
        const revoked = await db.agentProberKey.updateMany({
            where: { id: input.keyId, tenantId: ctx.tenantId, revokedAt: null },
            data: { revokedAt: new Date(), revokedByUserId: ctx.userId },
        });
        if (revoked.count === 0) throw notFound('Active prober key not found');
        await logEvent(db, ctx, {
            action: 'AGENT_PROBER_KEY_REVOKED',
            entityType: 'AgentProberKey',
            entityId: input.keyId,
            details: `Revoked prober key ${input.keyId}`,
            detailsJson: { category: 'access', entityName: 'AgentProberKey', operation: 'revoked' },
        });
        return { id: input.keyId, revoked: true };
    });
}
