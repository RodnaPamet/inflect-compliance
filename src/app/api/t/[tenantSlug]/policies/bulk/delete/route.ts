import { NextRequest } from 'next/server';
import { bulkDeletePolicy } from '@/app-layer/usecases/policy';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkPolicyDeleteSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/policies/bulk/delete
 *
 * TWO keys, `all` mode, because `assertCanAdminPolicies` is itself a
 * conjunction: the coarse ADMIN tier AND the granular `policies.edit`
 * flag (see policy.policies.ts). Declaring both mirrors the assert
 * exactly, so the request that the usecase would refuse is refused HERE
 * — where the denial writes an AUTHZ_DENIED audit row — instead of
 * deeper, where it writes nothing. Neither key alone would do that: a
 * custom role holding `admin.manage` but not `policies.edit` would pass
 * a one-key gate and be thrown out silently by the usecase.
 *
 * The usecase assert stays. It is what protects non-HTTP callers. See #2117.
 */
export const POST = withApiErrorHandling(
    requirePermission(['admin.manage', 'policies.edit'], async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, BulkPolicyDeleteSchema);
        const result = await bulkDeletePolicy(ctx, body.policyIds);
        return jsonResponse(result);
    }),
);
