/**
 * Reads of the `WorkflowRun` row that BOTH the driver and the usecases need.
 *
 * Extracted for one reason: `getRunRow` is the only helper the static driver
 * shares with the exported usecases (`abortWorkflowRun` reads it directly, and
 * `loadRunAndDef` reads it on the resume path). Leaving it in the usecase file
 * would have made the driver import from `app-layer`, and moving it into the
 * driver would have made a usecase import its run-row read from a driver — one
 * inverts the layering, the other is merely confusing. A small shared module is
 * neither.
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { notFound } from '@/lib/errors/types';
import { ENGINE_RUN_CAPS } from '@/lib/agentic/run-caps';
import { isProposeTool, proposedItemCount } from '@/lib/mcp/tools/propose-tools';

export async function getRunRow(ctx: RequestContext, runId: string) {
    const run = await runInTenantContext(ctx, (db) =>
        db.workflowRun.findFirst({
            where: { id: runId, tenantId: ctx.tenantId },
            // WITHOUT `driver` (#4241). The row is read whole, and a whole row
            // carrying an engine this build's enum does not know — a later image
            // started the run, production rolled back to this one — fails the
            // read before any of our code sees it: the driver could not read its
            // own run, so it could neither continue it nor settle it. Nothing
            // here needs the column; a reader that does asks
            // `readRecordedRunDrivers` for it as text.
            omit: { driver: true },
        }),
    );
    if (!run) throw notFound('Workflow run not found');
    return run;
}

/**
 * How many items this run has ALREADY proposed, across every segment.
 *
 * Read from the append-only step ledger rather than accumulated in memory,
 * because `executeFrom` is re-entered after every human checkpoint: a counter
 * seeded at zero would hand a run with three checkpoints four proposal budgets,
 * which is the exact defect `resolveMcpInvocation`'s `actionsAlready` comment
 * already records for the card's per-run budget.
 *
 * An unreadable or absent count reads as ZERO, not as the cap. A run whose
 * PROPOSE steps predate the recorded count would otherwise halt on resume
 * having done nothing wrong — the same direction `highestRecordedContextSeq`
 * takes for its own missing lower bound.
 */
export async function proposedItemsSoFar(ctx: RequestContext, runId: string): Promise<number> {
    const steps = await runInTenantContext(ctx, (db) =>
        db.workflowStep.findMany({
            // BOTH ENGINES, because they record a proposal differently and
            // this is the only reader.
            //
            // The static driver writes `kind: 'PROPOSE'` with
            // `input: { count: items.length }`. The Flue driver writes every
            // tool call — propose tools included — as `kind: 'TOOL_CALL'`
            // with the model's raw ARGS, because the run timeline is built
            // from those two kinds. Filtering on 'PROPOSE' alone therefore
            // matched nothing a Flue run had ever written, so the seed was
            // always 0 and the PROPOSALS cap restarted from empty on every
            // resume: a run could queue its whole cap, pause at a checkpoint
            // or a guard flag, and queue it again on approval.
            where: {
                runId,
                tenantId: ctx.tenantId,
                status: 'DONE',
                OR: [{ kind: 'PROPOSE' }, { kind: 'TOOL_CALL' }],
            },
            select: { kind: true, toolCalled: true, inputJson: true },
            // A run cannot execute more steps than the engine's step cap, so
            // this is the tightest honest bound rather than a round number.
            take: ENGINE_RUN_CAPS.STEPS,
        }),
    );
    let total = 0;
    for (const step of steps) {
        if (step.kind === 'PROPOSE') {
            total += recordedProposalCount(step.inputJson);
            continue;
        }
        // A TOOL_CALL counts only if it was a propose tool, decided by the
        // registry's own predicate — the same one the Flue driver charges on.
        // A second way of deciding "is this a propose tool" is a way for the
        // charge and the seed to disagree about the same call.
        if (step.toolCalled && isProposeTool(step.toolCalled)) {
            total += argsProposalCount(step.inputJson);
        }
    }
    return total;
}

/**
 * The item count carried by a Flue TOOL_CALL step's recorded ARGS.
 *
 * Reads the args with the funnel's own counter rather than a second reading of
 * the same shape, so a malformed propose call costs one here exactly as it
 * cost one when it was charged.
 */
function argsProposalCount(inputJson: string | null): number {
    if (inputJson === null) return 0;
    try {
        return proposedItemCount(JSON.parse(inputJson));
    } catch {
        // Unreadable args read as ZERO for the same reason the recorded count
        // does: a run whose steps predate the record must not halt having done
        // nothing wrong.
        return 0;
    }
}

/** The `{ count }` a static-driver PROPOSE step recorded, or 0 when unreadable. */
function recordedProposalCount(inputJson: string | null): number {
    if (inputJson === null) return 0;
    try {
        const parsed: unknown = JSON.parse(inputJson);
        if (typeof parsed !== 'object' || parsed === null) return 0;
        const count = (parsed as { count?: unknown }).count;
        return typeof count === 'number' && Number.isFinite(count) && count > 0
            ? Math.floor(count)
            : 0;
    } catch {
        return 0;
    }
}

/**
 * WHAT A COMPACTION'S RUN-STATE BLOCK IS BUILT FROM (Step 2g of
 * `docs/claude-tool-runner-design.md`, #5531): this run's ledger rows from
 * `fromSeq`, in seq order, and every proposal it made.
 *
 * Both reads are bounded and read ONE PAST the bound, so a truncated read is a
 * fact the caller holds rather than one it cannot see: `complete` is false and
 * the caller does not compact. A block built from a partial read could drop a
 * pending proposal, which is the one thing it exists to keep.
 */
export async function readCompactionRecord(
    ctx: RequestContext,
    runId: string,
    fromSeq: number,
): Promise<{
    complete: boolean;
    steps: Array<{
        seq: number;
        kind: string;
        toolCalled: string | null;
        status: string;
        subagentName: string | null;
        guardVerdict: string | null;
        inputJson: string | null;
        outputJson: string | null;
    }>;
    proposals: Array<{ id: string; kind: string; status: string; stepSeq: number | null }>;
}> {
    const stepBound = ENGINE_RUN_CAPS.STEPS;
    const proposalBound = ENGINE_RUN_CAPS.PROPOSALS;
    const [steps, proposals] = await runInTenantContext(ctx, async (db) => [
        await db.workflowStep.findMany({
            where: { runId, tenantId: ctx.tenantId, seq: { gte: fromSeq } },
            orderBy: { seq: 'asc' },
            select: {
                seq: true,
                kind: true,
                toolCalled: true,
                status: true,
                subagentName: true,
                guardVerdict: true,
                inputJson: true,
                outputJson: true,
            },
            take: stepBound + 1,
        }),
        await db.agentProposal.findMany({
            where: { runId, tenantId: ctx.tenantId },
            orderBy: [{ stepSeq: 'asc' }, { id: 'asc' }],
            select: { id: true, kind: true, status: true, stepSeq: true },
            take: proposalBound + 1,
        }),
    ] as const);
    return {
        complete: steps.length <= stepBound && proposals.length <= proposalBound,
        steps: steps.slice(0, stepBound),
        proposals: proposals.slice(0, proposalBound),
    };
}
