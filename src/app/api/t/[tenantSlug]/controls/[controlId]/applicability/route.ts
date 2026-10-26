import { setControlApplicability } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { SetControlApplicabilitySchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string };

/**
 * Gated on `controls.edit`, the key `setControlApplicability` already asserts
 * (`assertCanSetApplicability`: the coarse write tier AND `controls.edit`), so
 * no role gains or loses anything. The gate is what makes a refusal write a
 * hash-chained AUTHZ_DENIED row; the usecase's throw records nothing (#4387).
 * The usecase assert stays.
 *
 * The body is parsed inline rather than through `withValidatedBody`: that
 * wrapper and `requirePermission` both claim the third handler argument.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, SetControlApplicabilitySchema);
        const control = await setControlApplicability(
            ctx,
            params.controlId,
            body.applicability,
            body.justification ?? null,
        );
        return jsonResponse(control);
    }),
);
