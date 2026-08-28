import { linkAssetToControl, unlinkAssetFromControl } from '@/app-layer/usecases/control';
import { parseJsonBody } from '@/lib/validation/route';
import { MapControlAssetSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; controlId: string };

/**
 * Control ↔ asset mapping, gated on `controls.edit`.
 *
 * Both handlers mirror `assertCanUpdateControl`, which reads the coarse
 * `permissions.canWrite` despite its control-specific name. `controls.edit`
 * matches it exactly for every built-in role, so no built-in role's access
 * moves; what changes is that a custom role denying `controls.edit` is now
 * honoured, where `canWrite` ignored it. The usecase assert stays.
 *
 * BODY VALIDATION uses `parseJsonBody`, not `withValidatedBody`. The wrapper
 * passes the body as a third argument and `requirePermission` passes `ctx`
 * there, so the two do not compose — which is exactly why `parseJsonBody`
 * exists, and its docblock says so. 58 routes already pair them this way; the
 * semantics are identical (malformed JSON → `badRequest`, schema failure →
 * ZodError → 400 VALIDATION_ERROR via `withApiErrorHandling`).
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, MapControlAssetSchema);
        const link = await linkAssetToControl(ctx, params.controlId, body.assetId);
        return jsonResponse(link, { status: 201 });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('controls.edit', async (req, { params }, ctx) => {
        const body = await parseJsonBody(req, MapControlAssetSchema);
        const result = await unlinkAssetFromControl(ctx, params.controlId, body.assetId);
        return jsonResponse(result);
    }),
);
