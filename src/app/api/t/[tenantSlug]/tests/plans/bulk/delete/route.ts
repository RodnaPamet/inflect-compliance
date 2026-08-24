import { NextRequest } from 'next/server';
import { bulkDeleteTestPlan } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkTestPlanDeleteSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/tests/plans/bulk/delete
 *
 * `admin.manage` is the SAME predicate the usecase asserts:
 * `assertCanBulkManageTestPlans` reads `ctx.appPermissions.admin.manage`
 * directly, so the route gate and the usecase gate agree exactly — there
 * is no role for which one admits and the other refuses. The assert stays
 * for non-HTTP callers; the route gate is what makes a refusal show up in
 * the audit trail. See #2117.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, BulkTestPlanDeleteSchema);
        const result = await bulkDeleteTestPlan(ctx, body.planIds);
        return jsonResponse(result);
    }),
);
