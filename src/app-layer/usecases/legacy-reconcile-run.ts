/**
 * Which match run the reconciliation queue opens, read under the queue's own
 * key (#5695, owner decision 2026-11-15: holding `identity_reconciliation.view`
 * is enough to open the queue).
 *
 * The page used to ask `admin/integrations/:id/executions/latest`, which takes
 * `admin.manage`, so a member who could read the queue could not find out which
 * run to read it for. This answers only that question: the connection's name
 * and its newest PASSED `legacy-mcp.reconcile` run, through the same bounded
 * read #5694 added (`getLatestExecutionForConnection`).
 *
 * Narrower than the admin read on purpose:
 *   - a LEGACY connection only — any other connection is a 404, so the view
 *     key does not become a way to read the names of a tenant's other
 *     integrations;
 *   - the run is projected to the four fields the queue uses; no error text,
 *     no control, no trigger.
 *
 * @module usecases/legacy-reconcile-run
 */
import type { RequestContext } from '../types';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { assertCanViewReconciliation } from '../policies/identity-reconciliation';
import { getLatestExecutionForConnection } from './integrations';

/** The provider a reconciliation queue belongs to. */
export const LEGACY_PROVIDER = 'legacy-mcp';
/** The automation key a legacy match run is recorded under. */
export const LEGACY_RECONCILE_AUTOMATION_KEY = 'legacy-mcp.reconcile';

export interface ReconciliationQueueRun {
    readonly connection: { readonly id: string; readonly name: string };
    /** The newest PASSED match run on the connection, or `null` when there is none. */
    readonly execution: {
        readonly id: string;
        readonly automationKey: string;
        readonly status: string;
        readonly executedAt: Date;
    } | null;
}

export async function getReconciliationQueueRun(
    ctx: RequestContext,
    connectionId: string,
): Promise<ReconciliationQueueRun> {
    assertCanViewReconciliation(ctx);

    const connection = await runInTenantContext(ctx, (db) =>
        db.integrationConnection.findFirst({
            where: { tenantId: ctx.tenantId, id: connectionId, provider: LEGACY_PROVIDER },
            select: { id: true, name: true },
        }),
    );
    if (!connection) throw notFound('This legacy connection does not exist in this workspace.');

    const run = await getLatestExecutionForConnection(ctx, connection.id, LEGACY_RECONCILE_AUTOMATION_KEY, {
        status: 'PASSED',
    });
    return {
        connection,
        execution: run
            ? { id: run.id, automationKey: run.automationKey, status: run.status, executedAt: run.executedAt }
            : null,
    };
}
