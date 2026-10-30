import { NextRequest } from 'next/server';
import { bulkSetVendorStatus } from '@/app-layer/usecases/vendor';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkVendorStatusSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/vendors/bulk/status
 *
 * `vendors.edit` — the flag `assertCanManageVendors` reads, so the caller set
 * is unchanged. The route used to build its context with `getTenantCtx` and
 * leave the refusal to the usecase, which writes no AUTHZ_DENIED row.
 *
 * The body is parsed inside the gate, so a refused caller is answered 403
 * before anything they sent is read.
 */
export const POST = withApiErrorHandling(
    requirePermission('vendors.edit', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, BulkVendorStatusSchema);
        const result = await bulkSetVendorStatus(ctx, body.vendorIds, body.status);
        return jsonResponse(result);
    }),
);
