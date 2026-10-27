
import { z } from 'zod';

import { setRequirementLinkApplicability } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

// null applicability clears the per-framework override (revert to inherit).
const Schema = z.object({
    applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE']).nullable(),
    justification: z.string().max(2000).optional().nullable(),
}).strip();

/** Set (or clear) the per-framework applicability override on a control's
 *  mapping to one requirement. */
/**
 * `setRequirementLinkApplicability` asserts `assertCanSetApplicability`
 * (`canWrite` + `controls.edit`) and this route carried no gate, so the
 * refusal happened inside the usecase and wrote no `AUTHZ_DENIED` row. Same
 * key, so no role moves (#4387).
 */
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; controlId: string; requirementId: string }>(
        'controls.edit',
        async (req, { params }, ctx) => {
            const body = await parseJsonBody(req, Schema);
            const updated = await setRequirementLinkApplicability(
                ctx,
                params.controlId,
                params.requirementId,
                body.applicability,
                body.justification ?? null,
            );
            return jsonResponse(updated);
        },
    ),
);
