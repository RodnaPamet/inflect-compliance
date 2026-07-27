import { restoreTask } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type TaskRestoreParams = { tenantSlug: string; taskId: string };

// Restore reverses a soft-delete. Gated on `tasks.edit` to match the
// DELETE handler it undoes (same shape as the asset / risk / policy
// restore routes) so a denial audits cleanly through the Epic C.1
// permission guard. `restoreEntity` applies its own `assertCanAdmin`
// underneath — the route gate is the outer, auditable layer.
export const POST = withApiErrorHandling(
    requirePermission<TaskRestoreParams>(
        'tasks.edit',
        async (_req, { params }, ctx) => {
            const { taskId } = await params;
            const result = await restoreTask(ctx, taskId);
            return jsonResponse(result);
        },
    ),
);
