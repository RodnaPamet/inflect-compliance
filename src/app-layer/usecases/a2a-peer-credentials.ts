/**
 * THE INBOUND A2A CREDENTIAL, per peer (#3679; threat-model R5, R6, I2 S/E).
 *
 * The ONLY writer of `PeerAgentInboundCredential`
 * (`tests/guards/agent-harness-single-write-seam.test.ts`).
 *
 * ## What a credential is, and what it is not
 *
 * It says three things: WHICH peer presents it, WHICH ONE registered agent a
 * task from that peer becomes a run for, and WHICH workflows the peer may ask
 * that agent to run. All three narrow. None grants: the run is the receiving
 * agent's own, under the peer's accountable owner as principal, through the
 * agent's own tool grants and policy card — the chain every run already passes
 * (`docs/a2a-mapping.md`, "No second authority model"). There is no scope,
 * permission or rung on this row, and there must never be one.
 *
 * ## Whose authority
 *
 * Issuing and revoking take `admin.agent_registry`, the key the owner chose for
 * deciding whom the tenant talks to (2026-10-18, R3), and a PERSON: an API key
 * never issues one, for the reason it never approves a card pin. The token is
 * shown once, stored as SHA-256, and at most one is live per peer.
 *
 * ## Retirement takes it away
 *
 * Retiring the receiving agent revokes every live credential bound to it, in
 * the retirement cascade's own transaction (`revokePeerInboundCredentialsForAgentInTx`,
 * owner decision 2026-10-19), so the next inbound message fails at the
 * credential check — not one step later on `AGENT_NOT_ACTIVE`. An issue in
 * flight at that moment is refused by a trigger that takes `FOR SHARE` on the
 * agent row, the retirement migration's own pattern.
 */
import { z } from 'zod';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors/types';
import type { PrismaTx } from '@/lib/db-context';
import { logEvent } from '../events/audit';
import { getWorkflowDefinition } from '@/lib/agentic/workflow-registry';
import { isAgentRetiredDbRefusal } from '@/lib/agentic/agent-retirement';
import { mintPeerInboundToken, peerTokenMatches } from '@/lib/agentic/a2a/credential';
import { inflectA2aIdentity } from '@/lib/agentic/a2a/send-tool';
import { currentTenantA2aPublicKey } from './a2a-signing-key';

export const IssuePeerInboundCredentialSchema = z
    .object({
        receivingAgentId: z.string().min(1).max(64),
        workflowKeys: z.array(z.string().min(1).max(128)).min(1).max(16),
    })
    .strict();

const CREDENTIAL_SELECT = {
    id: true,
    peerId: true,
    receivingAgentId: true,
    workflowKeys: true,
    keyPrefix: true,
    createdByUserId: true,
    createdAt: true,
    revokedAt: true,
    revokedByUserId: true,
} as const;

function assertMayManage(ctx: RequestContext): void {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Managing an A2A peer credential requires admin.agent_registry');
    }
    if (ctx.apiKeyId) throw forbidden('An A2A peer credential is issued and revoked by a person, not by an API key');
}

/**
 * What an operator hands the peer's organisation, beside the token: where to
 * send, whom to address, and the key this tenant's answers are signed with.
 * None of it is secret. A `null` key means the tenant has no signing key yet,
 * and every message would be refused `NO_SIGNING_KEY` until an OWNER makes one.
 */
async function peerHandover(ctx: RequestContext, peerId: string) {
    const key = await currentTenantA2aPublicKey(ctx);
    return {
        inflectIdentity: inflectA2aIdentity(ctx.tenantId, peerId),
        endpointPath: ctx.tenantSlug ? `/api/a2a/${ctx.tenantSlug}/peers/${peerId}` : null,
        inflectSigningPublicKey: key?.publicKey ?? null,
        inflectSigningKeyFingerprint: key?.fingerprint ?? null,
    };
}

export async function getPeerInboundCredential(ctx: RequestContext, peerId: string) {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Reading an A2A peer credential requires admin.agent_registry');
    }
    const { live, revoked } = await runInTenantContext(ctx, async (db) => {
        const peer = await db.peerAgent.findFirst({ where: { id: peerId, tenantId: ctx.tenantId }, select: { id: true } });
        if (!peer) throw notFound('Peer agent not found');
        const live = await db.peerAgentInboundCredential.findFirst({
            where: { tenantId: ctx.tenantId, peerId, revokedAt: null },
            select: CREDENTIAL_SELECT,
        });
        // The revoked ones too, newest first and bounded: who held access, and
        // who took it away, without opening the audit log.
        const revoked = await db.peerAgentInboundCredential.findMany({
            where: { tenantId: ctx.tenantId, peerId, revokedAt: { not: null } },
            orderBy: { revokedAt: 'desc' },
            take: 20,
            select: CREDENTIAL_SELECT,
        });
        return { live, revoked };
    });
    return { credential: live, revoked, ...(await peerHandover(ctx, peerId)) };
}

export async function issuePeerInboundCredential(ctx: RequestContext, peerId: string, input: unknown) {
    assertMayManage(ctx);
    const parsed = IssuePeerInboundCredentialSchema.parse(input);
    const workflowKeys = [...new Set(parsed.workflowKeys.map((k) => k.trim()))];
    for (const key of workflowKeys) {
        if (!getWorkflowDefinition(key)) throw badRequest(`Unknown workflow: ${key}`);
    }
    const minted = mintPeerInboundToken();

    const credential = await runInTenantContext(ctx, async (db) => {
        const peer = await db.peerAgent.findFirst({
            where: { id: peerId, tenantId: ctx.tenantId },
            select: { id: true, status: true },
        });
        if (!peer) throw notFound('Peer agent not found');
        if (peer.status === 'RETIRED') throw badRequest('A retired peer agent cannot be issued a credential');
        const agent = await db.registeredAgent.findFirst({
            where: { id: parsed.receivingAgentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, status: true },
        });
        if (!agent) throw badRequest('The receiving agent does not exist in this tenant');
        if (agent.status === 'RETIRED') throw badRequest('A retired agent cannot receive A2A tasks');
        const live = await db.peerAgentInboundCredential.findFirst({
            where: { tenantId: ctx.tenantId, peerId, revokedAt: null },
            select: { id: true },
        });
        if (live) throw conflict('This peer already holds a live credential. Revoke it before issuing another');

        let row;
        try {
            row = await db.peerAgentInboundCredential.create({
                data: {
                    tenantId: ctx.tenantId,
                    peerId,
                    receivingAgentId: agent.id,
                    workflowKeys,
                    keyHash: minted.keyHash,
                    keyPrefix: minted.keyPrefix,
                    createdByUserId: ctx.userId,
                },
                select: CREDENTIAL_SELECT,
            });
        } catch (err) {
            // The agent was retired between the read above and this insert.
            if (isAgentRetiredDbRefusal(err)) throw badRequest('A retired agent cannot receive A2A tasks');
            throw err;
        }
        await logEvent(db, ctx, {
            action: 'PEER_AGENT_INBOUND_CREDENTIAL_ISSUED',
            entityType: 'PeerAgent',
            entityId: peerId,
            details: `Issued an inbound A2A credential to peer agent ${peerId}`,
            detailsJson: {
                category: 'access',
                entityName: 'PeerAgentInboundCredential',
                operation: 'created',
                // Never the token and never its hash.
                after: { credentialId: row.id, keyPrefix: row.keyPrefix, receivingAgentId: row.receivingAgentId, workflowKeys },
            },
        });
        return row;
    });
    return { credential, token: minted.token, ...(await peerHandover(ctx, peerId)) };
}

export async function revokePeerInboundCredential(ctx: RequestContext, peerId: string) {
    assertMayManage(ctx);
    return runInTenantContext(ctx, async (db) => {
        const live = await db.peerAgentInboundCredential.findFirst({
            where: { tenantId: ctx.tenantId, peerId, revokedAt: null },
            select: { id: true },
        });
        if (!live) throw notFound('This peer holds no live credential');
        const claimed = await db.peerAgentInboundCredential.updateMany({
            where: { id: live.id, tenantId: ctx.tenantId, revokedAt: null },
            data: { revokedAt: new Date(), revokedByUserId: ctx.userId },
        });
        if (claimed.count !== 1) throw conflict('The credential was revoked by somebody else first');
        await logEvent(db, ctx, {
            action: 'PEER_AGENT_INBOUND_CREDENTIAL_REVOKED',
            entityType: 'PeerAgent',
            entityId: peerId,
            details: `Revoked the inbound A2A credential of peer agent ${peerId}`,
            detailsJson: {
                category: 'access',
                entityName: 'PeerAgentInboundCredential',
                operation: 'updated',
                after: { credentialId: live.id, revokedByUserId: ctx.userId },
            },
        });
        return db.peerAgentInboundCredential.findFirst({ where: { id: live.id, tenantId: ctx.tenantId }, select: CREDENTIAL_SELECT });
    });
}

/**
 * The live credential this peer holds, if `token` is it. Read on EVERY inbound
 * message — revocation takes effect on the next one — and compared in constant
 * time. `null` covers "no live credential" and "not this one" alike: the caller
 * refuses either way and records which in its audit row, never in its answer.
 */
export async function matchPeerInboundCredential(ctx: RequestContext, peerId: string, token: string) {
    const live = await runInTenantContext(ctx, (db) =>
        db.peerAgentInboundCredential.findFirst({
            where: { tenantId: ctx.tenantId, peerId, revokedAt: null },
            select: { id: true, keyHash: true, receivingAgentId: true, workflowKeys: true },
        }),
    );
    if (!live) return null;
    if (!peerTokenMatches(token, live.keyHash)) return null;
    return { id: live.id, receivingAgentId: live.receivingAgentId, workflowKeys: live.workflowKeys };
}

/**
 * Revoke every live credential bound to an agent being RETIRED, inside the
 * retirement cascade's transaction (`agent-retirement-cascade.ts`). Writes no
 * audit row: the cascade writes its rows LAST, after every effect, so none can
 * survive a rollback. Ids are bounded for that row; the write is not, so "no
 * live credential binds a retired agent" holds of the table.
 */
export async function revokePeerInboundCredentialsForAgentInTx(
    db: PrismaTx,
    ctx: RequestContext,
    agentId: string,
    now: Date,
    idCap: number,
): Promise<{ count: number; ids: string[] }> {
    const where = { tenantId: ctx.tenantId, receivingAgentId: agentId, revokedAt: null };
    const rows = await db.peerAgentInboundCredential.findMany({
        where,
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: idCap + 1,
    });
    const revoked = await db.peerAgentInboundCredential.updateMany({
        where,
        data: { revokedAt: now, revokedByUserId: ctx.userId },
    });
    return { count: revoked.count, ids: rows.map((r) => r.id) };
}
