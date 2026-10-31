import { denyTrustCenterAccessRequest } from '@/app-layer/usecases/trust-center-documents';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; requestId: string };

/** #4824 — admin: deny an access request that is still waiting. No link is issued. */
export const POST = withApiErrorHandling(requirePermission<Params>('admin.manage', async (_req, { params }, ctx) => {
    const { requestId } = await params;
    return jsonResponse(await denyTrustCenterAccessRequest(ctx, requestId));
}));
