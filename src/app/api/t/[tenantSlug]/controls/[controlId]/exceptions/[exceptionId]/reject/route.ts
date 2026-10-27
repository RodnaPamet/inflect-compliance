/**
 * Epic G-5 — Reject a REQUESTED exception.
 *
 *   POST /api/t/:slug/controls/:controlId/exceptions/:exceptionId/reject
 *   Body: { reason: string }
 */

import { rejectException } from '@/app-layer/usecases/control';
import { RejectExceptionSchema } from '@/app-layer/schemas/control-exception.schemas';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string; exceptionId: string };

/**
 * Same key as approving — a rejection is the same decision (#4387).
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, RejectExceptionSchema);
        const result = await rejectException(ctx, params.exceptionId, body);
        return jsonResponse(result);
    }),
);
