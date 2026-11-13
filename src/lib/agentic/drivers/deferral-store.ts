/**
 * THE DEFERRAL STORE (Step 2f of `docs/claude-tool-runner-design.md`, #5530).
 *
 * The engine's reads and writes of `WorkflowRunDeferral`, as `run-store.ts`
 * and `step-recorder.ts` are for the run and its ledger, so no engine module
 * holds a Prisma call. The table has exactly two writers, this file and
 * `usecases/workflow-run-deferrals.ts` (the decision hook), and
 * `tests/guards/workflow-run-deferral-single-write-seam.test.ts` holds them.
 *
 * A deferral is a proposal the run waits on. Its row moves one way (a trigger
 * holds it): WAITING while the proposal is undecided, DECIDED once a person
 * decides it in the queue, RESUMED when the run's next segment has sent its
 * first request from the transcript, or SETTLED when the run ended without
 * resuming. The transcript is cleared, and its hash kept, on RESUMED and
 * SETTLED (owner decision 3 of 2026-11-13).
 *
 * The transcript itself is read here as the string it was stored as, and
 * nothing in this file parses, sanitises or re-serialises it: its bytes are
 * what a thinking block's signature binds (`tool-runner/transcript.ts`).
 */
import type { RequestContext } from '@/app-layer/types';
import type { PrismaTx } from '@/lib/db-context';
import { runInTenantContext } from '@/lib/db/rls-middleware';

/** The statuses in which a deferral still holds its run: it has not resumed or settled. */
export const OPEN_DEFERRAL_STATUSES = ['WAITING', 'DECIDED'] as const;

/** A decision a PERSON took in the proposal queue, the three a run resumes on. */
export const PERSON_DECISIONS = ['ACCEPTED', 'EDITED', 'REJECTED'] as const;
export type PersonDecision = (typeof PERSON_DECISIONS)[number];

export function isPersonDecision(value: string | null | undefined): value is PersonDecision {
    return (PERSON_DECISIONS as readonly string[]).includes(value ?? '');
}

/** What a reader shows of one deferral: never its transcript. */
export interface DeferralView {
    readonly id: string;
    readonly runId: string;
    readonly stepSeq: number;
    readonly toolCalled: string;
    readonly proposalId: string;
    readonly status: string;
    readonly decision: string | null;
    readonly parkedAt: Date;
    readonly decidedAt: Date | null;
    readonly decidedByUserId: string | null;
    readonly resumedAt: Date | null;
    readonly settledAt: Date | null;
}

const VIEW_SELECT = {
    id: true,
    runId: true,
    stepSeq: true,
    toolCalled: true,
    proposalId: true,
    status: true,
    decision: true,
    parkedAt: true,
    decidedAt: true,
    decidedByUserId: true,
    resumedAt: true,
    settledAt: true,
} as const;

/**
 * The run's most recent deferral, whatever its status, for the run page; null
 * when the run never deferred. A run can defer more than once (it resumes and
 * defers again), and the latest is the one that holds it, if any does.
 */
export async function readLatestDeferral(ctx: RequestContext, runId: string): Promise<DeferralView | null> {
    return runInTenantContext(ctx, (db) =>
        db.workflowRunDeferral.findFirst({
            where: { tenantId: ctx.tenantId, runId },
            orderBy: { stepSeq: 'desc' },
            select: VIEW_SELECT,
        }),
    );
}

/** The run's WAITING deferral, or null: a run that waits on a proposal no generic resume may continue. */
export async function readWaitingDeferral(ctx: RequestContext, runId: string): Promise<DeferralView | null> {
    return runInTenantContext(ctx, (db) =>
        db.workflowRunDeferral.findFirst({
            where: { tenantId: ctx.tenantId, runId, status: 'WAITING' },
            select: VIEW_SELECT,
        }),
    );
}

/**
 * Which of these runs wait on a proposal, and on which (the runs list offers
 * "Open proposal" in place of Resume). One bounded read for a page of runs.
 */
export async function readWaitingDeferralsForRuns(
    db: PrismaTx,
    ctx: RequestContext,
    runIds: readonly string[],
): Promise<Map<string, string>> {
    if (runIds.length === 0) return new Map();
    const rows = await db.workflowRunDeferral.findMany({
        where: { tenantId: ctx.tenantId, runId: { in: [...runIds] }, status: 'WAITING' },
        select: { runId: true, proposalId: true },
        take: runIds.length,
    });
    return new Map(rows.map((r) => [r.runId, r.proposalId]));
}

/**
 * Which of these proposals a run is WAITING on, and which run (the proposals
 * page marks them, so the reviewer knows the decision continues work).
 */
export async function readWaitingRunsForProposals(
    db: PrismaTx,
    ctx: RequestContext,
    proposalIds: readonly string[],
): Promise<Map<string, string>> {
    if (proposalIds.length === 0) return new Map();
    const rows = await db.workflowRunDeferral.findMany({
        where: { tenantId: ctx.tenantId, proposalId: { in: [...proposalIds] }, status: 'WAITING' },
        select: { runId: true, proposalId: true },
        take: proposalIds.length,
    });
    return new Map(rows.map((r) => [r.proposalId, r.runId]));
}

/** A DECIDED deferral, as the resumed segment reads it: the transcript and the decision. */
export interface DecidedDeferral {
    readonly id: string;
    readonly stepSeq: number;
    readonly toolUseId: string;
    readonly toolCalled: string;
    readonly proposalId: string;
    readonly decision: PersonDecision;
    readonly transcriptJson: string;
    readonly transcriptHash: string;
    readonly model: string;
    readonly elapsedMsAtPark: number;
}

/**
 * The run's DECIDED deferral, or null when it has none: then the segment opens
 * as every segment does. A row whose decision is not a person's, or whose
 * transcript is gone, cannot be resumed from and reads as `UNREADABLE`, which
 * the engine settles rather than starting the conversation afresh.
 */
export async function readDecidedDeferral(
    ctx: RequestContext,
    runId: string,
): Promise<DecidedDeferral | 'UNREADABLE' | null> {
    const row = await runInTenantContext(ctx, (db) =>
        db.workflowRunDeferral.findFirst({
            where: { tenantId: ctx.tenantId, runId, status: 'DECIDED' },
            orderBy: { stepSeq: 'desc' },
            select: {
                id: true,
                stepSeq: true,
                toolUseId: true,
                toolCalled: true,
                proposalId: true,
                decision: true,
                transcriptJson: true,
                transcriptHash: true,
                model: true,
                elapsedMsAtPark: true,
            },
        }),
    );
    if (!row) return null;
    if (!isPersonDecision(row.decision) || row.transcriptJson === null) return 'UNREADABLE';
    return { ...row, decision: row.decision, transcriptJson: row.transcriptJson };
}

/** The proposal a resumed segment reports to the model, read from the queue's own row. */
export async function readDeferredProposal(
    ctx: RequestContext,
    proposalId: string,
): Promise<{ kind: string; operation: string; status: string; createdEntityId: string | null } | null> {
    return runInTenantContext(ctx, (db) =>
        db.agentProposal.findFirst({
            where: { id: proposalId, tenantId: ctx.tenantId },
            select: { kind: true, operation: true, status: true, createdEntityId: true },
        }),
    );
}

/**
 * DECIDED → RESUMED, clearing the transcript, inside the transaction that
 * records the resumed segment's first step (`recordStep`'s `alsoInTx`). So
 * either the first request's step is in the ledger and the transcript is gone,
 * or neither: a retry never resends a conversation whose continuation was
 * already recorded. Conditional, so an abort that settled the row first keeps
 * its settlement; the step still lands and the abort stops the run at its
 * next check.
 */
export function markDeferralResumedInTx(ctx: RequestContext, deferralId: string): (db: PrismaTx) => Promise<void> {
    return async (db) => {
        await db.workflowRunDeferral.updateMany({
            where: { id: deferralId, tenantId: ctx.tenantId, status: 'DECIDED' },
            data: { status: 'RESUMED', resumedAt: new Date(), transcriptJson: null },
        });
    };
}

/**
 * Settle every OPEN deferral of a run that ended without resuming from it:
 * WAITING (nobody decided, or the run was aborted) settles `NOT_RESUMED`;
 * DECIDED keeps the person's decision, which stands on the proposal. Both
 * clear the transcript. Called in the abort's own transaction, and after any
 * settlement that is not a park. Returns how many rows it settled.
 */
export async function settleOpenDeferralsInTx(db: PrismaTx, ctx: RequestContext, runId: string): Promise<number> {
    const now = new Date();
    const waiting = await db.workflowRunDeferral.updateMany({
        where: { tenantId: ctx.tenantId, runId, status: 'WAITING' },
        data: { status: 'SETTLED', decision: 'NOT_RESUMED', settledAt: now, transcriptJson: null },
    });
    const decided = await db.workflowRunDeferral.updateMany({
        where: { tenantId: ctx.tenantId, runId, status: 'DECIDED' },
        data: { status: 'SETTLED', settledAt: now, transcriptJson: null },
    });
    return waiting.count + decided.count;
}

/** `settleOpenDeferralsInTx` in a transaction of its own. */
export async function settleOpenDeferrals(ctx: RequestContext, runId: string): Promise<number> {
    return runInTenantContext(ctx, (db) => settleOpenDeferralsInTx(db, ctx, runId));
}
