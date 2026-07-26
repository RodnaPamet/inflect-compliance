import { unlinkTaskEvidence } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type TaskEvidenceItemParams = {
    tenantSlug: string;
    taskId: string;
    evidenceId: string;
};

/**
 * DELETE — detach an evidence row from the task (clears Evidence.taskId;
 * the evidence survives in the library). Gated on `tasks.edit`.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<TaskEvidenceItemParams>('tasks.edit', async (_req, { params }, ctx) => {
        const { taskId, evidenceId } = await params;
        const result = await unlinkTaskEvidence(ctx, taskId, evidenceId);
        return jsonResponse(result);
    }),
);
