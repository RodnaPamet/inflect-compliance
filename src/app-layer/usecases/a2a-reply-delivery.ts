/**
 * A PEER'S REPLY REACHES THE RUN THAT SENT THE TASK (#3744).
 *
 * In 4b (#3679) a peer's reply is kept as a receipted `PeerAgentMessage` and
 * the run that sent the task never sees it, so an agent cannot act on what the
 * peer returned. This is the decision half of closing that: which stored
 * replies a run may be shown, and the ledger row recording every answer.
 *
 * THE ONLY WRITER of `PeerAgentReplyDelivery`. The model-facing half —
 * capping, neutralising, the envelope — is `lib/agentic/a2a-peer-reply-input.ts`,
 * and the fencing is `flue/run-message.ts`. That is the split
 * `ad-hoc-question-input.ts` already draws between deciding and rendering.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO OF THE FOUR HARDENING ITEMS WERE ALREADY TRUE, AND SAYING SO MATTERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The issue asks that only a verified reply, to a task this run sent, from the
 * peer it was sent to, is delivered.
 *
 *   · "VERIFIED" is settled before this module sees anything. `a2a-outbound.ts`
 *     verifies the receipt header against the peer's registered key and
 *     DISCARDS an unverified answer rather than storing it — so an unverifiable
 *     reply is not merely undeliverable here, it does not exist. That is
 *     stronger than the issue asks and it is a documented invariant; do not
 *     "improve" it into a stored-but-refused row, because an unverified body is
 *     not a receipt.
 *   · "TO A TASK THIS RUN SENT" is settled at the same place: the receipt is
 *     verified with `relatesTo: messageId`, the id of our own outbound message,
 *     and the row is stored with that run's `runId`.
 *
 * So the checks below are not re-derivations of those. They are the questions
 * nobody could answer at verification time: has the run since ended, is the
 * stored linkage still coherent, and does the content survive the guard.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A REPLY NEVER RESUMES A RUN, AND THAT IS STRUCTURAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `resumeWorkflowRun` admits only `AWAITING_APPROVAL` or `PAUSED`, asserts a
 * human's `assertCanWrite`, and refuses past the approval window. A peer's
 * reply is none of those things, so nothing here can restart anything — the
 * issue's fourth item is a property of the engine rather than a check in this
 * file.
 *
 * What this file decides is narrower and is where the care goes: a run that has
 * ENDED gets a REFUSED row naming `RUN_ENDED`, and a run that is merely PARKED
 * gets NO ROW AT ALL. The distinction is the whole design. A parked run will
 * resume, and a refusal written now would mean the reply it was waiting for is
 * permanently undeliverable — recorded, immutable, and wrong. Leaving it
 * undecided is what makes "the reply is kept" true in the only sense that
 * matters: it is still deliverable.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GUARD REFUSES A REPLY; IT NEVER FAILS THE RUN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `guardUntrustedInput` is called per reply, and a block becomes a REFUSED row
 * with `GUARD_REFUSED`. It is deliberately NOT `assertGuardAllowed`, which
 * throws: a peer sending one hostile answer would otherwise abort a run that
 * was doing legitimate work, which hands a peer a denial-of-service against
 * the tenant that registered it. The reply is kept, the refusal is recorded,
 * and the step proceeds without it.
 */
import type { WorkflowRunStatus } from '@prisma/client';

import { guardUntrustedInput } from '@/app-layer/ai/guard';
import {
    A2A_PEER_REPLY_SOURCE,
    peerReplyEnvelope,
    type PeerReplyEnvelope,
} from '@/lib/agentic/a2a-peer-reply-input';
import { logger } from '@/lib/observability';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import type { PrismaTx } from '@/lib/db-context';

import type { RequestContext } from '../types';

/** The closed vocabulary pinned by `PeerAgentReplyDelivery_reason_known`. */
export type ReplyDeliveryRefusal =
    | 'RUN_ENDED'
    | 'RUN_NOT_FOUND'
    | 'RUN_MISMATCH'
    | 'PEER_MISMATCH'
    | 'GUARD_REFUSED';

/**
 * What a run's status means for a reply waiting on it.
 *
 * An exhaustive `Record` over the generated union, so a status added to
 * `WorkflowRunStatus` fails `tsc` here until somebody says what a pending
 * reply should do about it. A `switch` with a `default` would silently treat a
 * new state as whatever the default is, and both wrong answers are bad in
 * different ways: refusing makes a deliverable reply permanently undeliverable,
 * delivering feeds input to a run nobody expected to be running.
 */
const DISPOSITION: Record<WorkflowRunStatus, 'DELIVER' | 'ENDED' | 'WAIT'> = {
    RUNNING: 'DELIVER',
    // Parked, not finished. NO ROW is written — see the module docstring.
    AWAITING_APPROVAL: 'WAIT',
    PAUSED: 'WAIT',
    COMPLETED: 'ENDED',
    ABORTED: 'ENDED',
    FAILED: 'ENDED',
    EMPTY_CATALOGUE: 'ENDED',
};

export interface ClaimedReplies {
    /** Envelopes to fence into the run's next message, oldest first. */
    readonly deliver: readonly PeerReplyEnvelope[];
    /** Replies given a REFUSED row this pass, with the reason recorded. */
    readonly refused: ReadonlyArray<{
        readonly messageId: string;
        readonly reason: ReplyDeliveryRefusal;
    }>;
    /** Replies deliberately left undecided because the run is parked. */
    readonly waiting: readonly string[];
}

const EMPTY: ClaimedReplies = { deliver: [], refused: [], waiting: [] };

/**
 * Decide and record the delivery of every undecided reply for one run.
 *
 * Returns the envelopes the caller should fence. Writes exactly one ledger row
 * per decided reply; the unique on `(tenantId, messageId)` is what makes a
 * second pass a no-op rather than a double delivery, so a caller that races
 * itself loses the insert rather than showing a model the same answer twice.
 */
export async function claimPeerRepliesForRun(
    ctx: RequestContext,
    runId: string,
): Promise<ClaimedReplies> {
    return runInTenantContext(ctx, async (db) => {
        const run = await db.workflowRun.findFirst({
            where: { tenantId: ctx.tenantId, id: runId },
            select: { id: true, status: true },
        });

        // Every inbound reply bound to this run that has no decision yet. The
        // `runId` index on `PeerAgentMessage` is what makes this cheap enough to
        // ask at a step boundary.
        const pending = await db.peerAgentMessage.findMany({
            where: {
                tenantId: ctx.tenantId,
                runId,
                direction: 'INBOUND',
                // A reply, not a task the peer opened: it names one of ours.
                relatesToMessageId: { not: null },
            },
            select: {
                id: true,
                peerId: true,
                body: true,
                messageId: true,
                relatesToMessageId: true,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 20,
        });
        if (pending.length === 0) return EMPTY;

        const decided = await db.peerAgentReplyDelivery.findMany({
            where: { tenantId: ctx.tenantId, messageId: { in: pending.map((p) => p.id) } },
            select: { messageId: true },
        });
        const already = new Set(decided.map((d) => d.messageId));
        const undecided = pending.filter((p) => !already.has(p.id));
        if (undecided.length === 0) return EMPTY;

        // A run the tenant does not hold is refused rather than skipped: a
        // reply bound to a run id that resolves to nothing is a fact worth
        // recording, not a row to leave pending for ever.
        if (!run) {
            return recordAll(db, ctx, runId, undecided, 'RUN_NOT_FOUND');
        }
        const disposition = DISPOSITION[run.status];
        if (disposition === 'ENDED') {
            return recordAll(db, ctx, runId, undecided, 'RUN_ENDED');
        }
        if (disposition === 'WAIT') {
            return { deliver: [], refused: [], waiting: undecided.map((u) => u.id) };
        }

        // Which of OUR messages each reply answers has to be a message of THIS
        // run. The receipt was verified against that id at send time, so this
        // is a check on the stored linkage rather than on the peer's claim —
        // and a stored row disagreeing with itself is exactly what a ledger is
        // for noticing.
        const ourIds = await db.peerAgentMessage.findMany({
            where: {
                tenantId: ctx.tenantId,
                runId,
                direction: 'OUTBOUND',
                messageId: {
                    in: undecided
                        .map((u) => u.relatesToMessageId)
                        .filter((v): v is string => typeof v === 'string'),
                },
            },
            select: { messageId: true, peerId: true },
        });
        const ourPeerByMessage = new Map(ourIds.map((o) => [o.messageId, o.peerId]));

        // `rowId` is `PeerAgentMessage.id`, which is what the ledger keys on;
        // `envelope.messageId` is the WIRE id the peer chose. Keeping both
        // beside each other is deliberate — an earlier draft looked the row up
        // by wire id when writing the ledger, which is a join on the one field
        // a peer controls.
        const deliver: Array<{ rowId: string; peerId: string; envelope: PeerReplyEnvelope }> = [];
        const refused: Array<{ rowId: string; peerId: string; reason: ReplyDeliveryRefusal }> = [];

        for (const reply of undecided) {
            const relatesTo = reply.relatesToMessageId as string;
            const ourPeer = ourPeerByMessage.get(relatesTo);
            if (ourPeer === undefined) {
                refused.push({ rowId: reply.id, peerId: reply.peerId, reason: 'RUN_MISMATCH' });
                continue;
            }
            if (ourPeer !== reply.peerId) {
                refused.push({ rowId: reply.id, peerId: reply.peerId, reason: 'PEER_MISMATCH' });
                continue;
            }

            // Per reply, so one hostile answer refuses itself and nothing else.
            // `source` is the option's real name, and `db` reuses the open
            // tenant transaction rather than opening a nested one — the
            // option exists for exactly that.
            const outcome = await guardUntrustedInput(ctx, reply.body, {
                source: A2A_PEER_REPLY_SOURCE,
                db,
            });
            if (outcome.blocked) {
                // NOT a throw. See the module docstring: throwing would let a
                // peer abort a run by answering badly.
                logger.warn('a2a.reply_guard_refused', {
                    component: 'a2a-reply-delivery',
                    tenantId: ctx.tenantId,
                    runId,
                    ruleIds: outcome.ruleIds,
                });
                refused.push({ rowId: reply.id, peerId: reply.peerId, reason: 'GUARD_REFUSED' });
                continue;
            }

            deliver.push({
                rowId: reply.id,
                peerId: reply.peerId,
                envelope: peerReplyEnvelope({
                    messageId: reply.messageId,
                    relatesToMessageId: relatesTo,
                    peerId: reply.peerId,
                    text: reply.body,
                }),
            });
        }

        const now = new Date();
        await db.peerAgentReplyDelivery.createMany({
            data: [
                ...deliver.map((d) => ({
                    tenantId: ctx.tenantId,
                    messageId: d.rowId,
                    runId,
                    peerId: d.peerId,
                    outcome: 'DELIVERED',
                    reason: null,
                    deliveredAt: now,
                })),
                ...refused.map((r) => ({
                    tenantId: ctx.tenantId,
                    messageId: r.rowId,
                    runId,
                    peerId: r.peerId,
                    outcome: 'REFUSED',
                    reason: r.reason,
                    deliveredAt: null,
                })),
            ],
            // A concurrent pass that got there first keeps its decision. The
            // unique index is the authority; this makes losing the race a no-op
            // instead of a crash.
            skipDuplicates: true,
        });

        return {
            deliver: deliver.map((d) => d.envelope),
            refused: refused.map((r) => ({ messageId: r.rowId, reason: r.reason })),
            waiting: [],
        };
    });
}

/** Record one reason for every undecided reply, and deliver none. */
async function recordAll(
    db: PrismaTx,
    ctx: RequestContext,
    runId: string,
    replies: ReadonlyArray<{ id: string; peerId: string }>,
    reason: ReplyDeliveryRefusal,
): Promise<ClaimedReplies> {
    await db.peerAgentReplyDelivery.createMany({
        data: replies.map((r) => ({
            tenantId: ctx.tenantId,
            messageId: r.id,
            runId,
            peerId: r.peerId,
            outcome: 'REFUSED',
            reason,
            deliveredAt: null,
        })),
        skipDuplicates: true,
    });
    return {
        deliver: [],
        refused: replies.map((r) => ({ messageId: r.id, reason })),
        waiting: [],
    };
}
