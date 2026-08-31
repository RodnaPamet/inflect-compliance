import { unmapAssetFromRisk } from '@/app-layer/usecases/traceability';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string; riskId: string };

/**
 * DELETE — break an Asset ↔ Risk mapping.
 *
 * Gated on `assets.edit` so the refusal is auditable (#2117); the usecase
 * assert stays for non-HTTP callers.
 *
 * The assert here is NOT the usual `assertCanWrite` — `unmapAssetFromRisk`
 * calls a file-local `assertCanManage` that tests `ctx.role` against the
 * literal list `['OWNER', 'ADMIN', 'EDITOR']`. That is the same population
 * `assets.edit` carries, so the built-in caller set is unchanged; it is worth
 * naming because a reader checking this gate against `assertCanWrite` would not
 * find one, and a `ctx.role` list is blind to custom roles in a way the flag is
 * not.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<Params>('assets.edit', async (_req, { params }, ctx) => {
        await unmapAssetFromRisk(ctx, params.id, params.riskId);
        return jsonResponse({ ok: true });
    }),
);
