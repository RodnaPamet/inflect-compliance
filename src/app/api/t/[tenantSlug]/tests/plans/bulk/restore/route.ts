import { NextRequest } from 'next/server';
import { bulkRestoreTestPlan } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkTestPlanRestoreSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/tests/plans/bulk/restore
 *
 * The undo counterpart to `bulk/delete`, and gated identically because
 * `bulkRestoreTestPlan` asserts the same `assertCanBulkManageTestPlans`.
 * Keeping the two keys equal is deliberate: a restore that is easier to
 * reach than the delete it undoes would let a lesser role resurrect a test
 * programme an admin retired. See #2117.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, BulkTestPlanRestoreSchema);
        const result = await bulkRestoreTestPlan(ctx, body.planIds);
        return jsonResponse(result);
    }),
);
