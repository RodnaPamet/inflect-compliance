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
            where: { runId, tenantId: ctx.tenantId, kind: 'PROPOSE', status: 'DONE' },
            select: { inputJson: true },
            // A run cannot execute more steps than the engine's step cap, so
            // this is the tightest honest bound rather than a round number.
            take: ENGINE_RUN_CAPS.STEPS,
        }),
    );
    let total = 0;
    for (const step of steps) total += proposedItemCount(step.inputJson);
    return total;
}

/** The `{ count }` a PROPOSE step recorded, or 0 when it cannot be read. */
function proposedItemCount(inputJson: string | null): number {
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
