import { listTaskLinks, addTaskLink } from '@/app-layer/usecases/task';
import { AddTaskLinkSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type TaskLinksParams = { tenantSlug: string; taskId: string };

/** GET — list a task's cross-entity links. Read-gated on `tasks.view`. */
export const GET = withApiErrorHandling(
    requirePermission<TaskLinksParams>('tasks.view', async (_req, { params }, ctx) => {
        const { taskId } = await params;
        const links = await listTaskLinks(ctx, taskId);
        return jsonResponse(links);
    }),
);

/** POST — link the task to another entity. Gated on `tasks.edit`. */
export const POST = withApiErrorHandling(
    requirePermission<TaskLinksParams>('tasks.edit', async (req, { params }, ctx) => {
        const { taskId } = await params;
        const body = await parseJsonBody(req, AddTaskLinkSchema);
        const link = await addTaskLink(
            ctx,
            taskId,
            body.entityType,
            body.entityId,
            body.relation,
        );
        return jsonResponse(link, { status: 201 });
    }),
);
