import { setTaskChecklistItem } from '@/app-layer/usecases/task';
import { SetTaskChecklistItemSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type TaskChecklistItemParams = { tenantSlug: string; taskId: string; itemId: string };

/** PATCH — tick or untick one checklist step. Gated on `tasks.edit`. */
export const PATCH = withApiErrorHandling(
    requirePermission<TaskChecklistItemParams>('tasks.edit', async (req, { params }, ctx) => {
        const { taskId, itemId } = await params;
        const body = await parseJsonBody(req, SetTaskChecklistItemSchema);
        const checklist = await setTaskChecklistItem(ctx, taskId, itemId, body.done);
        return jsonResponse({ checklist });
    }),
);
