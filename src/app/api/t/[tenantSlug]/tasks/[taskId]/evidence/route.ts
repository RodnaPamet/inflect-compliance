import { getTaskEvidenceTab, linkTaskEvidence } from '@/app-layer/usecases/task';
import { LinkTaskEvidenceSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type TaskEvidenceParams = { tenantSlug: string; taskId: string };

/**
 * GET — task Evidence-tab payload `{ links, evidence }`, mirroring the
 * control evidence tab so the shared <EvidenceSubTable> renders it.
 * Read-gated on `tasks.view`.
 */
export const GET = withApiErrorHandling(
    requirePermission<TaskEvidenceParams>('tasks.view', async (_req, { params }, ctx) => {
        const { taskId } = await params;
        const data = await getTaskEvidenceTab(ctx, taskId);
        return jsonResponse(data);
    }),
);

/**
 * POST — attach a URL as evidence on the task. File uploads go through the
 * multipart /evidence/uploads endpoint with a taskId. Gated on `tasks.edit`.
 */
export const POST = withApiErrorHandling(
    requirePermission<TaskEvidenceParams>('tasks.edit', async (req, { params }, ctx) => {
        const { taskId } = await params;
        const body = await parseJsonBody(req, LinkTaskEvidenceSchema);
        const evidence = await linkTaskEvidence(ctx, taskId, body);
        return jsonResponse(evidence, { status: 201 });
    }),
);
