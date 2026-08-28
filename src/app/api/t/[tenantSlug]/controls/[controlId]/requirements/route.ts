import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { mapRequirementToControl, unmapRequirementFromControl, listControlMappings } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { MapRequirementSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string };

// GET — framework mappings for the control (#102 item 1, Mappings tab).
export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<Params> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const mappings = await listControlMappings(ctx, params.controlId);
    return jsonResponse(mappings);
});

/**
 * Control ↔ requirement mapping, gated on `controls.edit`.
 *
 * The CONTROL side governs a mapping where a control is one end — the rule
 * settled for #2117. That matters most here: the assert is
 * `assertCanMapFramework`, whose NAME points at the framework side while its
 * body reads the coarse `permissions.canWrite`. So the code named one owner
 * and enforced neither, which is precisely the ambiguity the rule resolves.
 * `frameworks` is a real PermissionSet domain, so this was a genuine fork.
 *
 * `controls.edit` matches the coarse tier exactly for every built-in role, so
 * no built-in role loses access. The usecase asserts stay.
 *
 * Body validation uses `parseJsonBody`, not `withValidatedBody`: the wrapper
 * passes the body third and `requirePermission` passes `ctx` there, so they do
 * not compose — which is why `parseJsonBody` exists.
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, MapRequirementSchema);
        const mapping = await mapRequirementToControl(ctx, params.controlId, body.requirementId);
        return jsonResponse(mapping, { status: 201 });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, MapRequirementSchema);
        await unmapRequirementFromControl(ctx, params.controlId, body.requirementId);
        return jsonResponse({ success: true });
    }),
);
