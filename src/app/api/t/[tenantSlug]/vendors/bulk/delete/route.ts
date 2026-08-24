import { NextRequest } from 'next/server';
import { bulkDeleteVendor } from '@/app-layer/usecases/vendor';
import { parseJsonBody } from '@/lib/validation/route';
import { BulkVendorDeleteSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/**
 * POST /api/t/[tenantSlug]/vendors/bulk/delete
 *
 * `admin.manage`, NOT the `vendors.edit` its `bulk/status` and
 * `bulk/assign` siblings sit behind: `bulkDeleteVendor` was raised to
 * `assertCanAdmin` so that deleting the vendor register matches every peer
 * register. Declaring `vendors.edit` here would be the weak-gate shape —
 * an EDITOR would pass the middleware and be refused by the usecase, and a
 * usecase refusal writes no AUTHZ_DENIED row. See #2117.
 */
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, BulkVendorDeleteSchema);
        const result = await bulkDeleteVendor(ctx, body.vendorIds);
        return jsonResponse(result);
    }),
);
