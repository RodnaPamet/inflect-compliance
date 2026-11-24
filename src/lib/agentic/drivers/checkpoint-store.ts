/**
 * THE CHECKPOINT STORE (#5854 item 3; owner decision 2026-11-24).
 *
 * The engine's reads and writes of `WorkflowRunCheckpoint`, as
 * `deferral-store.ts` is for the deferral and `step-recorder.ts` for the
 * ledger, so no engine module holds a Prisma call. This file is the table's
 * ONLY writer (`tests/guards/workflow-run-checkpoint-single-write-seam.test.ts`).
 *
 * Two things live on the row, one per run:
 *
 *   • THE CONVERSATION a Tool Runner run continues from when its segment is
 *     retried or taken over by another worker: the request through the last
 *     reply that asked for tools (`transcriptJson`), the results of that
 *     reply's calls as they settle (`resultsJson`), and the call executing
 *     right now (`inFlightToolUseId`). Byte-faithful and sealed as the
 *     deferral transcript is (`tool-runner/transcript.ts`); this file stores
 *     strings and never parses, sanitises or re-serialises them.
 *   • THE SEGMENT ANCHOR, engine-neutral: which queued segment the run's
 *     attempts execute, and where its first attempt began in the ledger, so a
 *     retry on an engine that cannot continue a conversation can tell it is a
 *     retry.
 *
 * EVERY WRITE IS FENCED ON THE RUN LEASE (#5854 finding 2): a worker that lost
 * the run writes nothing here, as it writes no step. The transcript is written
 * inside the transaction that records the reply's MODEL_CALL step
 * (`recordStep`'s `alsoInTx`, which runs after the step recorder's own fence);
 * every other write takes the fence itself.
 *
 * A checkpoint exists only for a run executed under a lease: only such a run
 * is retried or taken over. A context with no lease (an inline run, a unit
 * test) writes and reads nothing here, and costs no query.
 */
import type { RequestContext } from '@/app-layer/types';
import type { PrismaTx } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { holdsRunLeaseInTx } from '@/lib/agentic/run-lease';
import { appendAuditEntry } from '@/lib/audit';

import { recordStep } from './step-recorder';

/** Does this execution keep a checkpoint? Only a leased one: only it is retried or taken over. */
export function keepsCheckpoint(ctx: RequestContext): boolean {
    return ctx.runLeaseToken !== undefined;
}

/** An OPEN checkpoint, as the continuation reads it. */
export interface StoredCheckpoint {
    readonly transcriptJson: string;
    readonly transcriptHash: string;
    readonly resultsJson: string | null;
    readonly resultsHash: string | null;
    readonly inFlightToolUseId: string | null;
    readonly atSeq: number;
    readonly elapsedMs: number;
    readonly costTokens: number;
}

/**
 * The run's open checkpoint, or null when it has nothing to continue from (no
 * row, a cleared row, a settled row, or an execution that keeps none). A row
 * whose transcript is present but whose companions are not reads as
 * `UNREADABLE`, which the engine settles rather than starting afresh.
 */
export async function readCheckpoint(ctx: RequestContext, runId: string): Promise<StoredCheckpoint | 'UNREADABLE' | null> {
    if (!keepsCheckpoint(ctx)) return null;
    const row = await runInTenantContext(ctx, (db) =>
        db.workflowRunCheckpoint.findFirst({
            where: { tenantId: ctx.tenantId, runId, settledAt: null },
            select: {
                transcriptJson: true,
                transcriptHash: true,
                resultsJson: true,
                resultsHash: true,
                inFlightToolUseId: true,
                atSeq: true,
                elapsedMs: true,
                costTokens: true,
            },
        }),
    );
    if (!row || row.transcriptJson === null) return null;
    if (row.transcriptHash === null || row.atSeq === null || row.elapsedMs === null || row.costTokens === null) {
        return 'UNREADABLE';
    }
    return {
        transcriptJson: row.transcriptJson,
        transcriptHash: row.transcriptHash,
        resultsJson: row.resultsJson,
        resultsHash: row.resultsHash,
        inFlightToolUseId: row.inFlightToolUseId,
        atSeq: row.atSeq,
        elapsedMs: row.elapsedMs,
        costTokens: row.costTokens,
    };
}

/** What a turn's checkpoint writes. */
export interface TurnCheckpoint {
    readonly transcriptJson: string;
    readonly transcriptHash: string;
    readonly resultsJson: string;
    readonly resultsHash: string;
    /** The MODEL_CALL step's seq. */
    readonly atSeq: number;
    readonly elapsedMs: number;
    readonly costTokens: number;
}

/** Write the run's row: update the open one, or create it. Never a settled one. */
async function writeOpenRow(db: PrismaTx, ctx: RequestContext, runId: string, data: Record<string, unknown>): Promise<boolean> {
    const updated = await db.workflowRunCheckpoint.updateMany({
        where: { tenantId: ctx.tenantId, runId, settledAt: null },
        data,
    });
    if (updated.count > 0) return true;
    const existing = await db.workflowRunCheckpoint.findFirst({
        where: { tenantId: ctx.tenantId, runId },
        select: { id: true },
    });
    // A settled row is never written again (the trigger holds it too).
    if (existing) return false;
    await db.workflowRunCheckpoint.create({ data: { tenantId: ctx.tenantId, runId, ...data } });
    return true;
}

/**
 * THE TURN'S CHECKPOINT, inside the transaction that records the reply's
 * MODEL_CALL step: the reply is in the ledger exactly when it is in the
 * checkpoint. Its results start empty and no call is in flight.
 */
export function writeTurnCheckpointInTx(
    ctx: RequestContext,
    runId: string,
    turn: TurnCheckpoint,
): (db: PrismaTx) => Promise<void> {
    return async (db) => {
        await writeOpenRow(db, ctx, runId, {
            transcriptJson: turn.transcriptJson,
            transcriptHash: turn.transcriptHash,
            resultsJson: turn.resultsJson,
            resultsHash: turn.resultsHash,
            inFlightToolUseId: null,
            atSeq: turn.atSeq,
            elapsedMs: turn.elapsedMs,
            costTokens: turn.costTokens,
        });
    };
}

/** One fenced write in a transaction of its own. False when this worker no longer holds the run. */
async function fencedWrite(ctx: RequestContext, runId: string, write: (db: PrismaTx) => Promise<boolean>): Promise<boolean> {
    if (!keepsCheckpoint(ctx)) return true;
    return runInTenantContext(ctx, async (db) => {
        if (!(await holdsRunLeaseInTx(db, ctx, runId))) return false;
        return write(db);
    });
}

/**
 * A WHOLE CHECKPOINT in a fenced transaction of its own: the conversation
 * after a compaction, whose rebuilt list replaces the one the reply's step
 * wrote. A failure leaves the earlier checkpoint, which is longer, never wrong.
 */
export async function writeCheckpoint(ctx: RequestContext, runId: string, turn: TurnCheckpoint): Promise<boolean> {
    return fencedWrite(ctx, runId, async (db) => {
        await writeTurnCheckpointInTx(ctx, runId, turn)(db);
        return true;
    });
}

/**
 * Name the call about to execute, BEFORE it reaches the funnel. If the worker
 * dies while it runs, the continuation answers it `TOOL_CALL_OUTCOME_UNKNOWN`
 * rather than running it again. False when the write could not be fenced: the
 * caller then does not run the call.
 */
export async function markCallInFlight(ctx: RequestContext, runId: string, toolUseId: string): Promise<boolean> {
    return fencedWrite(ctx, runId, async (db) => {
        const moved = await db.workflowRunCheckpoint.updateMany({
            where: { tenantId: ctx.tenantId, runId, settledAt: null, transcriptJson: { not: null } },
            data: { inFlightToolUseId: toolUseId },
        });
        return moved.count > 0;
    });
}

/**
 * Keep the reply's results as they now stand, and clear the in-flight call:
 * one call settled, or the whole turn answered (the SDK's own message). The
 * caller holds the results in memory and writes them whole.
 */
export async function keepCallResults(
    ctx: RequestContext,
    runId: string,
    results: { readonly json: string; readonly hash: string },
): Promise<boolean> {
    return fencedWrite(ctx, runId, async (db) => {
        const moved = await db.workflowRunCheckpoint.updateMany({
            where: { tenantId: ctx.tenantId, runId, settledAt: null, transcriptJson: { not: null } },
            data: { resultsJson: results.json, resultsHash: results.hash, inFlightToolUseId: null },
        });
        return moved.count > 0;
    });
}

/**
 * CLEAR the conversation, keeping the row open: the run parked on a deferral
 * (whose transcript takes over) or is held for a person, who decides whether
 * it goes on. The hashes are kept. The anchor is kept too: it names the
 * segment, which a clear does not end.
 */
export async function clearCheckpointInTx(db: PrismaTx, tenantId: string, runId: string): Promise<void> {
    await db.workflowRunCheckpoint.updateMany({
        where: { tenantId, runId, settledAt: null },
        data: { transcriptJson: null, resultsJson: null, inFlightToolUseId: null },
    });
}

/**
 * SETTLE the checkpoint: the run ended. The conversation and the anchor are
 * cleared, `settledAt` is stamped and the row never changes again (trigger).
 * The hashes are kept, so what the run last checkpointed stays provable.
 */
export async function settleCheckpointInTx(db: PrismaTx, tenantId: string, runId: string): Promise<void> {
    await db.workflowRunCheckpoint.updateMany({
        where: { tenantId, runId, settledAt: null },
        data: {
            transcriptJson: null,
            resultsJson: null,
            inFlightToolUseId: null,
            segmentKey: null,
            segmentFromSeq: null,
            settledAt: new Date(),
        },
    });
}

/** The run statuses in which a run may still be continued: its checkpoint is kept. */
export const CHECKPOINT_KEEPING_STATUSES: ReadonlySet<string> = new Set(['RUNNING', 'PAUSED']);

/** The run status in which a person decides whether the run goes on: its checkpoint is cleared, not settled. */
export const CHECKPOINT_CLEARING_STATUSES: ReadonlySet<string> = new Set(['AWAITING_APPROVAL']);

/**
 * Clear or settle the checkpoint by the status the run's row NOW holds, read
 * in the same transaction: a run still RUNNING (an attempt that threw, which
 * BullMQ retries) or PAUSED (the SIGTERM drain) keeps it; AWAITING_APPROVAL
 * clears it; every other status settles it. Unfenced on purpose: it runs after
 * the run's settlement, and clearing tenant content is never a write a lost
 * worker can do harm with. Returns what it did.
 */
export async function closeCheckpointForRun(
    ctx: RequestContext,
    runId: string,
): Promise<'KEPT' | 'CLEARED' | 'SETTLED' | 'NO_RUN'> {
    return runInTenantContext(ctx, async (db) => {
        const run = await db.workflowRun.findFirst({ where: { id: runId, tenantId: ctx.tenantId }, select: { status: true } });
        if (!run) return 'NO_RUN';
        if (CHECKPOINT_KEEPING_STATUSES.has(run.status)) return 'KEPT';
        if (CHECKPOINT_CLEARING_STATUSES.has(run.status)) {
            await clearCheckpointInTx(db, ctx.tenantId, runId);
            return 'CLEARED';
        }
        await settleCheckpointInTx(db, ctx.tenantId, runId);
        return 'SETTLED';
    });
}

/**
 * THE SEGMENT ANCHOR. The first attempt of a queued segment records which
 * segment it is and where in the ledger it began; a later attempt of the SAME
 * segment (a BullMQ retry, a stalled-job redelivery, a lease takeover) finds
 * its own key and learns it is a retry, and where its segment began. A key is
 * compared for equality only, never as a clock. `LEASE_LOST` when this worker
 * no longer holds the run.
 */
export async function anchorSegment(
    ctx: RequestContext,
    runId: string,
    segmentKey: string,
    fromSeq: number,
): Promise<{ retry: false } | { retry: true; segmentFromSeq: number } | 'LEASE_LOST'> {
    let outcome: { retry: false } | { retry: true; segmentFromSeq: number } = { retry: false };
    const held = await fencedWrite(ctx, runId, async (db) => {
        const row = await db.workflowRunCheckpoint.findFirst({
            where: { tenantId: ctx.tenantId, runId },
            select: { segmentKey: true, segmentFromSeq: true, settledAt: true },
        });
        if (row?.segmentKey === segmentKey && row.segmentFromSeq !== null) {
            outcome = { retry: true, segmentFromSeq: row.segmentFromSeq };
            return true;
        }
        if (row?.settledAt) return true;
        await writeOpenRow(db, ctx, runId, { segmentKey, segmentFromSeq: fromSeq });
        return true;
    });
    return held ? outcome : 'LEASE_LOST';
}

/**
 * Has the run recorded a tool call, or a model call (which on Managed Agents
 * precedes the calls it asks for), at or after `fromSeq`? The question a retry
 * asks of its own segment.
 */
export async function segmentMadeCalls(ctx: RequestContext, runId: string, fromSeq: number): Promise<boolean> {
    const found = await runInTenantContext(ctx, (db) =>
        db.workflowStep.findFirst({
            where: { tenantId: ctx.tenantId, runId, seq: { gte: fromSeq }, kind: { in: ['TOOL_CALL', 'MODEL_CALL'] } },
            select: { id: true },
        }),
    );
    return found !== null;
}

/** The label of the checkpoint a retried segment pauses at (#5854 item 3). */
export const RETRY_PAUSED_LABEL = 'retry-paused';

/** Why a retried segment paused: it had already made calls, and its engine cannot continue its conversation. */
export const RETRY_AFTER_CALLS = 'RETRY_AFTER_CALLS';

/** Raised inside the pause's transaction when the run is no longer RUNNING, so nothing is written. */
class RunNoLongerRunning extends Error {
    constructor() {
        super('the run is no longer RUNNING');
    }
}

/**
 * PAUSE A RETRIED SEGMENT FOR A PERSON (#5854 item 3), in ONE transaction, as
 * the deferral's park is written: a PENDING `HUMAN_CHECKPOINT` step labelled
 * `retry-paused`, naming the reason, the engine and where the segment began,
 * and the run's conditional move RUNNING → PAUSED. A person's resume closes
 * the step and starts a new segment, which on this engine starts again from
 * its opening message: that is the person's decision to make, never a
 * retry's. An operator's ABORTED stands: then nothing is written and this
 * returns `ABORTED`; a worker that lost the run writes nothing and gets
 * `LEASE_LOST`. `WORKFLOW_RUN_RETRY_PAUSED` is audited after the commit.
 */
export async function pauseRetriedSegment(
    ctx: RequestContext,
    runId: string,
    input: { readonly checkpointSeq: number; readonly segmentFromSeq: number; readonly engine: string },
): Promise<'PAUSED' | 'NOT_RUNNING' | 'LEASE_LOST'> {
    let written = false;
    try {
        await recordStep(
            ctx,
            runId,
            input.checkpointSeq,
            'HUMAN_CHECKPOINT',
            {
                status: 'PENDING',
                label: RETRY_PAUSED_LABEL,
                input: { reason: RETRY_AFTER_CALLS, engine: input.engine, segmentFromSeq: input.segmentFromSeq },
            },
            undefined,
            async (db) => {
                const moved = await db.workflowRun.updateMany({
                    where: { id: runId, tenantId: ctx.tenantId, status: 'RUNNING' },
                    data: { status: 'PAUSED', stepCount: input.checkpointSeq + 1 },
                });
                if (moved.count === 0) throw new RunNoLongerRunning();
                written = true;
            },
        );
    } catch (err) {
        if (err instanceof RunNoLongerRunning) return 'NOT_RUNNING';
        throw err;
    }
    // `recordStep` returns quietly when the fence refused the write.
    if (!written) return 'LEASE_LOST';
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: ctx.apiKeyId ? 'API_KEY' : 'USER',
        entity: 'WorkflowRun',
        entityId: runId,
        action: 'WORKFLOW_RUN_RETRY_PAUSED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            // The literal, not the constant: a value the logging rule can read.
            reason: 'RETRY_AFTER_CALLS',
            engine: input.engine,
            segmentFromSeq: input.segmentFromSeq,
            stepSeq: input.checkpointSeq,
        },
    }).catch(() => undefined);
    return 'PAUSED';
}
