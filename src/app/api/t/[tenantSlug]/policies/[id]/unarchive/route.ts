import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { unarchivePolicy } from '@/app-layer/usecases/policy';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

// POST /api/t/[tenantSlug]/policies/[id]/unarchive — reverse an archive.
//
// Distinct from /restore, which reverses a SOFT DELETE. Archiving is a status
// transition and had no inverse, so an archived policy was unrecoverable: the
// paths that write DRAFT both refuse archived policies. The usecase gates on
// the policy admin tier and lands the policy in DRAFT rather than its prior
// status, so republishing still goes through approval.
export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; id: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const result = await unarchivePolicy(ctx, params.id);
    return jsonResponse(result);
});
