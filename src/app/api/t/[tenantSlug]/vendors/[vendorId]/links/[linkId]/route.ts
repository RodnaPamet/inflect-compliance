import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { removeVendorLink } from '@/app-layer/usecases/vendor';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const DELETE = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; vendorId: string; linkId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    await removeVendorLink(ctx, params.linkId, params.vendorId);
    return jsonResponse({ deleted: true });
});
