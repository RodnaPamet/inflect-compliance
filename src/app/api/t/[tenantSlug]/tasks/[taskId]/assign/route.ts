import { assignTask } from '@/app-layer/usecases/task';
import { AssignTaskSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type TaskAssignParams = { tenantSlug: string; taskId: string };

/** POST — (re)assign a task. Gated on the dedicated `tasks.assign` key. */
export const POST = withApiErrorHandling(
    requirePermission<TaskAssignParams>('tasks.assign', async (req, { params }, ctx) => {
        const { taskId } = await params;
        const body = await parseJsonBody(req, AssignTaskSchema);
        const task = await assignTask(ctx, taskId, body.assigneeUserId);
        return jsonResponse(task);
    }),
);
