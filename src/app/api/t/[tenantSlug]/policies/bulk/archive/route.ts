import { NextRequest } from 'next/server';
import { bulkArchivePolicy } from '@/app-layer/usecases/policy';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkPolicyArchiveSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/policies/bulk/archive
 *
 * Archiving retires a policy from the live library in bulk — an
 * ADMIN-tier lifecycle verb, which is why `bulkArchivePolicy` asserts
 * `assertCanAdminPolicies` rather than the EDITOR-level write gate its
 * `bulk/assign` sibling uses. Same two-key conjunction as `bulk/delete`,
 * for the same reason: the route key set must equal the assert or the
 * denial it exists to log is the one it cannot see. See #2117.
 */
export const POST = withApiErrorHandling(
    requirePermission(['admin.manage', 'policies.edit'], async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, BulkPolicyArchiveSchema);
        const result = await bulkArchivePolicy(ctx, body.policyIds);
        return jsonResponse(result);
    }),
);
