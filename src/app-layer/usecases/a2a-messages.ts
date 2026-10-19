/**
 * A2A RECEIPTS, KEPT (#3679; `docs/a2a-threat-model.md` "Receipts on both
 * sides", R12).
 *
 * The ONLY writer of `PeerAgentMessage`
 * (`tests/guards/agent-harness-single-write-seam.test.ts`). Two kinds of row
 * arrive here, and neither is written before it has earned it:
 *
 *   INBOUND   a peer's TASK or RESULT, written only AFTER its signature
 *             verified against the peer's registered key and its statement met
 *             every expectation (recipient, digest, clock, what it answers).
 *   OUTBOUND  Inflect's TASK or RESULT, written as it is signed and BEFORE it
 *             leaves, so a crash between the send and the answer still leaves
 *             the record of what was sent.
 *
 * The body is kept verbatim (encrypted at rest) because the statement's digest
 * covers its exact bytes, and the row keeps the public key it verifies under,
 * bound by the fingerprint it names, so `verifyStoredA2aReceipt` re-derives the
 * whole chain from the row alone — after a key rotation, and after the peer and
 * the tenant's key table are gone in a purge that retains the receipt. Rows are
 * write-once (trigger, and no UPDATE grant).
 *
 * ## Replay
 *
 * An INBOUND message whose id this tenant has already recorded from this peer
 * fails the unique constraint, and `A2aReplayError` is how the caller learns
 * it. The insert IS the check: a read-then-write would let two copies of one
 * message race through.
 */
import { z } from 'zod';

import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden, internal, notFound } from '@/lib/errors/types';
import {
    canonicalStatement,
    rawEd25519PublicKeyHex,
    verifyStoredA2aReceipt,
    type SignedA2aReceipt,
} from '@/lib/agentic/a2a/receipt';
import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';
import { tenantA2aPublicKeysByFingerprint } from './a2a-signing-key';

export class A2aReplayError extends Error {
    constructor() {
        super('a2a: this message id has already been received from this peer');
        this.name = 'A2aReplayError';
    }
}

export interface A2aMessageRecord {
    readonly peerId: string;
    readonly direction: 'INBOUND' | 'OUTBOUND';
    readonly receipt: SignedA2aReceipt;
    readonly signerKeyFingerprint: string;
    /** The public key it verified (INBOUND) or was signed (OUTBOUND) under. */
    readonly signerPublicKey: string;
    /** The exact body the receipt's digest covers. */
    readonly body: string;
    readonly agentId?: string | null;
    readonly runId?: string | null;
    readonly journalId?: string | null;
}

export async function recordA2aMessage(ctx: RequestContext, rec: A2aMessageRecord): Promise<{ id: string }> {
    const s = rec.receipt.statement;
    const signerPublicKey = rawEd25519PublicKeyHex(rec.signerPublicKey);
    // The key and its id must agree, or the row would name one key and keep another.
    if (!signerPublicKey || harnessKeyFingerprint(signerPublicKey) !== rec.signerKeyFingerprint) {
        throw internal('a2a: a receipt must keep the key its fingerprint names');
    }
    try {
        return await runInTenantContext(ctx, (db) =>
            db.peerAgentMessage.create({
                data: {
                    tenantId: ctx.tenantId,
                    peerId: rec.peerId,
                    direction: rec.direction,
                    kind: s.kind,
                    method: s.method,
                    messageId: s.messageId,
                    relatesToMessageId: s.relatesTo,
                    receiptJson: canonicalStatement(s),
                    signature: rec.receipt.signature,
                    signerKeyFingerprint: rec.signerKeyFingerprint,
                    signerPublicKey,
                    bodyDigest: s.bodyDigest,
                    body: rec.body,
                    agentId: rec.agentId ?? null,
                    runId: rec.runId ?? null,
                    journalId: rec.journalId ?? null,
                },
                select: { id: true },
            }),
        );
    } catch (err) {
        if ((err as { code?: unknown } | null)?.code === 'P2002') throw new A2aReplayError();
        throw err;
    }
}

/** Inbound TASK messages from one peer since `since`: the per-peer quota's count. */
export async function countInboundTasksSince(ctx: RequestContext, peerId: string, since: Date): Promise<number> {
    return runInTenantContext(ctx, (db) =>
        db.peerAgentMessage.count({
            where: { tenantId: ctx.tenantId, peerId, direction: 'INBOUND', kind: 'TASK', createdAt: { gte: since } },
        }),
    );
}

export const ListPeerMessagesSchema = z
    .object({ take: z.coerce.number().int().min(1).max(200).optional() })
    .strict();

/**
 * The receipts exchanged with one peer, newest first, each RE-VERIFIED from
 * the stored row against the key its fingerprint names — never against a key
 * the row supplies for itself:
 *
 *   INBOUND   the peer's registered key, whose fingerprint is immutable;
 *   OUTBOUND  the tenant's signing key by fingerprint, in force OR retired, so
 *             a receipt signed before a rotation still verifies after it.
 *
 * `verifies` is `null` only when no key with that id is held here, which says
 * "cannot check here", not "forged". No body is returned.
 */
export async function listPeerMessages(ctx: RequestContext, peerId: string, input: unknown = {}) {
    if (!ctx.appPermissions.admin.agent_registry) {
        throw forbidden('Reading A2A receipts requires admin.agent_registry');
    }
    const { take } = ListPeerMessagesSchema.parse(input ?? {});
    const { peer, rows } = await runInTenantContext(ctx, async (db) => {
        const peer = await db.peerAgent.findFirst({
            where: { id: peerId, tenantId: ctx.tenantId },
            select: { id: true, signingPublicKey: true, signingKeyFingerprint: true },
        });
        if (!peer) throw notFound('Peer agent not found');
        const rows = await db.peerAgentMessage.findMany({
            where: { tenantId: ctx.tenantId, peerId },
            orderBy: { createdAt: 'desc' },
            take: take ?? 50,
        });
        return { peer, rows };
    });
    const ownKeys = await tenantA2aPublicKeysByFingerprint(
        ctx,
        rows.filter((r) => r.direction === 'OUTBOUND').map((r) => r.signerKeyFingerprint),
    );
    return rows.map((r) => {
        const key =
            r.direction === 'INBOUND'
                ? r.signerKeyFingerprint === peer.signingKeyFingerprint ? peer.signingPublicKey : null
                : ownKeys.get(r.signerKeyFingerprint) ?? null;
        return {
            id: r.id,
            direction: r.direction,
            kind: r.kind,
            method: r.method,
            messageId: r.messageId,
            relatesToMessageId: r.relatesToMessageId,
            receipt: JSON.parse(r.receiptJson) as unknown,
            signature: r.signature,
            signerKeyFingerprint: r.signerKeyFingerprint,
            bodyDigest: r.bodyDigest,
            agentId: r.agentId,
            runId: r.runId,
            journalId: r.journalId,
            createdAt: r.createdAt,
            verifies: key === null ? null : verifyStoredA2aReceipt(r, key, r.signerKeyFingerprint),
        };
    });
}
