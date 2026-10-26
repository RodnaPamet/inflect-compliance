import { z } from 'zod';
import { setRequirementLinkApplicability } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string; requirementId: string };

// null applicability clears the per-framework override (revert to inherit).
const Schema = z.object({
    applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE']).nullable(),
    justification: z.string().max(2000).optional().nullable(),
}).strip();

/**
 * Set (or clear) the per-framework applicability override on a control's
 * mapping to one requirement.
 *
 * Gated on `controls.edit`, the key `setRequirementLinkApplicability` already
 * asserts (`assertCanSetApplicability`: the coarse write tier AND
 * `controls.edit`) and the key of the map and unmap routes beside it
 * (`../../route.ts`), so no role gains or loses anything. The gate is what
 * makes a refusal write a hash-chained AUTHZ_DENIED row; the usecase's throw
 * records nothing (#4387). The usecase assert stays.
 *
 * The body is parsed inline rather than through `withValidatedBody`: that
 * wrapper and `requirePermission` both claim the third handler argument.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, Schema);
        const updated = await setRequirementLinkApplicability(
            ctx,
            params.controlId,
            params.requirementId,
            body.applicability,
            body.justification ?? null,
        );
        return jsonResponse(updated);
    }),
);
