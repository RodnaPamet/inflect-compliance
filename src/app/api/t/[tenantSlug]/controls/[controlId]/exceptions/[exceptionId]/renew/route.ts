/**
 * Epic G-5 — Renew an exception.
 *
 *   POST /api/t/:slug/controls/:controlId/exceptions/:exceptionId/renew
 *   Body: optional { justification?, compensatingControlId?,
 *                    riskAcceptedByUserId?, expiresAt? }
 *   → creates a NEW exception linked to the supplied id; prior is
 *     untouched.
 */

import { renewException } from '@/app-layer/usecases/control';
import { RenewExceptionSchema } from '@/app-layer/schemas/control-exception.schemas';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string; exceptionId: string };

/**
 * Gated on `controls.edit` (#4387). `renewException` asserted `assertCanWrite`,
 * the coarse tier alone; it now asserts `assertCanUpdateControl`, which reads
 * this key. Renewing extends a control write, so it asks what requesting asks.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, RenewExceptionSchema);
        const result = await renewException(ctx, params.exceptionId, body);
        return jsonResponse(result, { status: 201 });
    }),
);
