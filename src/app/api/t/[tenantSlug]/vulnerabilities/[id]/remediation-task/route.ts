import { createVulnerabilityRemediationTask } from '@/app-layer/usecases/vulnerability';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string };

/**
 * Spawn a remediation Task for a vulnerability (triage flow) via the existing
 * createTask usecase, linked to the affected asset, and pin it onto the
 * vulnerability's remediationTaskId.
 *
 * Three keys, all required (#4465): `assets.edit` for the pin on the
 * vulnerability, and `tasks.create` + `tasks.edit` — what `createTask` and
 * `addTaskLink` each assert. Asking all three BEFORE the task is created is
 * the point: a caller holding `tasks.create` without `tasks.edit` used to get
 * the task committed and then a refusal at the link, leaving a task the row
 * never pointed at, and a retry made another.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>(['assets.edit', 'tasks.create', 'tasks.edit'], async (_req, { params }, ctx) => {
        const task = await createVulnerabilityRemediationTask(ctx, params.id);
        return jsonResponse(task, { status: 201 });
    }),
);
