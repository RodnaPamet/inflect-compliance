import { restoreTask } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type TaskRestoreParams = { tenantSlug: string; taskId: string };

// Restore reverses a soft-delete. Gated on `admin.manage`, the key the task
// DELETE it undoes takes, and the predicate `restoreEntity`'s `assertCanAdmin`
// applies underneath (same shape as the asset / risk / policy restore
// routes), so a denial audits cleanly through the Epic C.1 permission guard.
// It was `tasks.edit`, which an EDITOR holds: the route admitted them, the
// usecase refused them, and the refusal wrote no AUTHZ_DENIED row (#5303).
export const POST = withApiErrorHandling(
    requirePermission<TaskRestoreParams>(
        'admin.manage',
        async (_req, { params }, ctx) => {
            const { taskId } = await params;
            const result = await restoreTask(ctx, taskId);
            return jsonResponse(result);
        },
    ),
);
