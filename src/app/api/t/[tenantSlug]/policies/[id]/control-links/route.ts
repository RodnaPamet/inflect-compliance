import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { linkPolicyControls, unlinkPolicyControls } from '@/app-layer/usecases/policy-template-mapping';
import { jsonResponse } from '@/lib/api-response';

const LinkControlsSchema = z.object({
    controlIds: z.array(z.string().min(1)).min(1).max(200),
}).strip();

// POST /api/t/[tenantSlug]/policies/[id]/control-links — explicit
type Params = { tenantSlug: string; id: string };

/**
 * Both handlers gate on `controls.edit`, not `policies.edit`.
 *
 * The CONTROL side governs a mapping where a control is one end — the rule
 * settled for #2117. The usecase asserts a coarse `assertCanWrite`, which
 * cannot say which side owns the link; that ambiguity is why this route sat
 * unmigrated. `controls.edit` matches the coarse tier exactly for every
 * built-in role, so no built-in role loses access. The usecase asserts stay.
 */
// confirm-and-link of suggested (or any tenant) controls to a policy.
// The ONLY write path for template-driven PolicyControlLinks.
export const POST = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, LinkControlsSchema);
        const result = await linkPolicyControls(ctx, params.id, body.controlIds);
        return jsonResponse(result, { status: 201 });
    }),
);

// DELETE /api/t/[tenantSlug]/policies/[id]/control-links — unlink one or more
// controls from a policy (the inverse of POST). controlIds in the JSON body.
export const DELETE = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, LinkControlsSchema);
        const result = await unlinkPolicyControls(ctx, params.id, body.controlIds);
        return jsonResponse(result);
    }),
);
