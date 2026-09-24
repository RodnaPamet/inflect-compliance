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
        db.workflowRun.findFirst({ where: { id: runId, tenantId: ctx.tenantId } }),
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
