/**
 * Epic G-5 — Approve a REQUESTED exception.
 *
 *   POST /api/t/:slug/controls/:controlId/exceptions/:exceptionId/approve
 *   Body: { expiresAt: ISO string, note?: string }
 */

import { approveException } from '@/app-layer/usecases/control';
import { ApproveExceptionSchema } from '@/app-layer/schemas/control-exception.schemas';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string; exceptionId: string };

/**
 * Gated on `admin.manage` (#4387, owner decision 2026-10-27).
 *
 * `approveException` asserted `assertCanAdmin` — the coarse tier alone — and
 * this route carried no gate, so a decision could not be withheld from a
 * narrow custom role on an admin base, and a refusal wrote no `AUTHZ_DENIED`
 * row. The usecase now asserts `assertCanDecideException`, which reads this
 * same key, so route and usecase ask one question. This IS a tightening: a
 * custom role holding the admin tier without `admin.manage` loses the
 * decision.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.manage', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, ApproveExceptionSchema);
        const result = await approveException(ctx, params.exceptionId, body);
        return jsonResponse(result);
    }),
);
