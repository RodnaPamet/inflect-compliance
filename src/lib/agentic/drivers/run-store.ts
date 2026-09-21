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

export async function getRunRow(ctx: RequestContext, runId: string) {
    const run = await runInTenantContext(ctx, (db) =>
        db.workflowRun.findFirst({ where: { id: runId, tenantId: ctx.tenantId } }),
    );
    if (!run) throw notFound('Workflow run not found');
    return run;
}
