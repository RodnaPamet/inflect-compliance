import { setControlOwner } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { SetControlOwnerSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string };

/**
 * Gated on `controls.edit`, the key `setControlOwner` already asserts
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
        const body = await parseJsonBody(req, SetControlOwnerSchema);
        const control = await setControlOwner(ctx, params.controlId, body.ownerUserId);
        return jsonResponse(control);
    }),
);
