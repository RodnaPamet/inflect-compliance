import { listTaskComments, addTaskComment } from '@/app-layer/usecases/task';
import { AddTaskCommentSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type TaskCommentsParams = { tenantSlug: string; taskId: string };

/** GET — list a task's comments. Read-gated on `tasks.view`. */
export const GET = withApiErrorHandling(
    requirePermission<TaskCommentsParams>('tasks.view', async (_req, { params }, ctx) => {
        const { taskId } = await params;
        const comments = await listTaskComments(ctx, taskId);
        return jsonResponse(comments);
    }),
);

/** POST — add a comment. Gated on `tasks.edit`. */
export const POST = withApiErrorHandling(
    requirePermission<TaskCommentsParams>('tasks.edit', async (req, { params }, ctx) => {
        const { taskId } = await params;
        const body = await parseJsonBody(req, AddTaskCommentSchema);
        const comment = await addTaskComment(ctx, taskId, body.body);
        return jsonResponse(comment, { status: 201 });
    }),
);
