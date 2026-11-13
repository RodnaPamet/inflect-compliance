/**
 * WHAT A READER SHOWS OF A DEFERRED CALL (Step 2f of
 * `docs/claude-tool-runner-design.md`, "6. The ledger, Art 12 and the UI",
 * #5530): the run page's view of its deferral, and which proposals on the
 * queue page a run is waiting on. Reads only, never the transcript.
 *
 * Apart from the decision hook (`workflow-run-deferrals.ts`) so a page that
 * only reads loads none of the hook's queue and audit machinery.
 */
import type { RequestContext } from '../types';
import { assertCanRead } from '@/app-layer/policies/common';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { readLatestDeferral, readWaitingRunsForProposals } from '@/lib/agentic/drivers/deferral-store';

/** A run's deferral as the run page shows it: never the transcript. */
export interface RunDeferralView {
    readonly status: string;
    readonly decision: string | null;
    readonly proposalId: string;
    /** The proposal's kind, or null when the proposal cannot be read. */
    readonly proposalKind: string | null;
    readonly toolCalled: string;
    /** The seq of the deferred call's TOOL_CALL step; its checkpoint follows it. */
    readonly stepSeq: number;
    readonly parkedAt: string;
    /** The proposal's own window: the one clock the wait has. */
    readonly deadline: string | null;
    readonly decidedAt: string | null;
    readonly decidedByUserId: string | null;
}

/**
 * The run's latest deferral, for the run page (Step 2f): a parked run shows
 * as waiting for a decision, with the proposal's kind, its deadline and a link
 * to it; a decided one names who decided and when. Null for a run that never
 * deferred. Read under the run page's own gate, as the run is.
 */
export async function readRunDeferralView(ctx: RequestContext, runId: string): Promise<RunDeferralView | null> {
    assertCanRead(ctx);
    const deferral = await readLatestDeferral(ctx, runId);
    if (!deferral) return null;
    const proposal = await runInTenantContext(ctx, (db) =>
        db.agentProposal.findFirst({
            where: { id: deferral.proposalId, tenantId: ctx.tenantId },
            select: { kind: true, expiresAt: true },
        }),
    );
    return {
        status: deferral.status,
        decision: deferral.decision,
        proposalId: deferral.proposalId,
        proposalKind: proposal?.kind ?? null,
        toolCalled: deferral.toolCalled,
        stepSeq: deferral.stepSeq,
        parkedAt: deferral.parkedAt.toISOString(),
        deadline: proposal?.expiresAt ? proposal.expiresAt.toISOString() : null,
        decidedAt: deferral.decidedAt ? deferral.decidedAt.toISOString() : null,
        decidedByUserId: deferral.decidedByUserId,
    };
}

/**
 * Which of these proposals a run is WAITING on, for the proposals page: the
 * reviewer is told the decision continues work. One bounded read.
 */
export async function readProposalsRunsWaitOn(
    ctx: RequestContext,
    proposalIds: readonly string[],
): Promise<ReadonlySet<string>> {
    assertCanRead(ctx);
    const waiting = await runInTenantContext(ctx, (db) => readWaitingRunsForProposals(db, ctx, proposalIds));
    return new Set(waiting.keys());
}
