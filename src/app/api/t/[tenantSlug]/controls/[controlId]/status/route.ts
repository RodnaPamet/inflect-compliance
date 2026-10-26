import { setControlStatus } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { SetControlStatusSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string };

/**
 * Gated on `controls.edit`, the key `setControlStatus` already asserts
 * (`assertCanUpdateControl`: the coarse write tier AND `controls.edit`), so no
 * role gains or loses anything. The gate is what makes a refusal write a
 * hash-chained AUTHZ_DENIED row; the usecase's throw records nothing (#4387).
 * The usecase assert stays.
 *
 * The body is parsed inline rather than through `withValidatedBody`: that
 * wrapper and `requirePermission` both claim the third handler argument.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, SetControlStatusSchema);
        const control = await setControlStatus(ctx, params.controlId, body.status);
        return jsonResponse(control);
    }),
);
