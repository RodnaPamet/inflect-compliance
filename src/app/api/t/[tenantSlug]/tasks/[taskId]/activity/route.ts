import { getTaskActivity } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type TaskActivityParams = { tenantSlug: string; taskId: string };

/** GET — a task's audit activity feed. Read-gated on `tasks.view`. */
export const GET = withApiErrorHandling(
    requirePermission<TaskActivityParams>('tasks.view', async (_req, { params }, ctx) => {
        const { taskId } = await params;
        const activity = await getTaskActivity(ctx, taskId);
        return jsonResponse(activity);
    }),
);
