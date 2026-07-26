import { removeTaskLink } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type TaskLinkParams = { tenantSlug: string; taskId: string; linkId: string };

/**
 * DELETE — remove one cross-entity link. Gated on `tasks.edit`.
 *
 * `taskId` is passed through to the usecase so the delete is scoped to
 * THIS task; previously the param was accepted and ignored, which let any
 * link in the tenant be deleted from any task's URL.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<TaskLinkParams>('tasks.edit', async (_req, { params }, ctx) => {
        const { taskId, linkId } = await params;
        await removeTaskLink(ctx, taskId, linkId);
        return jsonResponse({ success: true });
    }),
);
