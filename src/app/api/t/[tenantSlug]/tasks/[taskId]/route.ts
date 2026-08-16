import { getTask, updateTask, deleteTask } from '@/app-layer/usecases/task';
import { UpdateTaskSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type TaskDetailParams = { tenantSlug: string; taskId: string };

export const GET = withApiErrorHandling(requirePermission<TaskDetailParams>('tasks.view', async (_req, { params }, ctx) => {
    const { taskId } = await params;
    const task = await getTask(ctx, taskId);
    return jsonResponse(task);
}));

export const PATCH = withApiErrorHandling(requirePermission<TaskDetailParams>('tasks.edit', async (req, { params }, ctx) => {
    const { taskId } = await params;
    const body = await parseJsonBody(req, UpdateTaskSchema);
    const task = await updateTask(ctx, taskId, body);
    return jsonResponse(task);
}));

// `admin.manage`, not `tasks.edit`: `deleteTask` asserts `assertCanAdmin`. The
// weaker key let an EDITOR past the middleware to be denied by the usecase,
// which writes no AUTHZ_DENIED row — so the denial was invisible.
export const DELETE = withApiErrorHandling(requirePermission<TaskDetailParams>('admin.manage', async (_req, { params }, ctx) => {
    const { taskId } = await params;
    await deleteTask(ctx, taskId);
    return jsonResponse({ ok: true });
}));
