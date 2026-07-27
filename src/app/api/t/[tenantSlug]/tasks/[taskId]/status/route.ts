import { setTaskStatus } from '@/app-layer/usecases/task';
import { SetTaskStatusSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type TaskStatusParams = { tenantSlug: string; taskId: string };

/** POST — advance a task's status. Gated on `tasks.edit`. */
export const POST = withApiErrorHandling(
    requirePermission<TaskStatusParams>('tasks.edit', async (req, { params }, ctx) => {
        const { taskId } = await params;
        const body = await parseJsonBody(req, SetTaskStatusSchema);
        const task = await setTaskStatus(ctx, taskId, body.status, body.resolution);
        return jsonResponse(task);
    }),
);
