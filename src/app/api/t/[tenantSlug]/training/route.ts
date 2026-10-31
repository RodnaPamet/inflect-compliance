import { listTrainingAssignments, assignTraining, AssignTrainingSchema } from '@/app-layer/usecases/training';
import { TRAINING_LIST_CAP } from '@/lib/training-list';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/** PR-6 — training assignments. List (personnel.view) + assign (personnel.manage). */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('personnel.view', async (_req, _a, ctx) => {
        const all = await listTrainingAssignments(ctx);
        return jsonResponse({ assignments: all.slice(0, TRAINING_LIST_CAP), truncated: all.length > TRAINING_LIST_CAP });
    }),
);
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('personnel.manage', async (req, _a, ctx) => {
        const body = await parseJsonBody(req, AssignTrainingSchema);
        return jsonResponse(await assignTraining(ctx, body), { status: 201 });
    }),
);
