import { removeTrustCenterDocument } from '@/app-layer/usecases/trust-center-documents';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; documentId: string };

/**
 * #4824 — admin: remove a document on request from the trust center. Its
 * access requests, and every link issued for it, go with it; the uploaded file
 * stays in the evidence library.
 */
export const DELETE = withApiErrorHandling(requirePermission<Params>('admin.manage', async (_req, { params }, ctx) => {
    const { documentId } = await params;
    return jsonResponse(await removeTrustCenterDocument(ctx, documentId));
}));
