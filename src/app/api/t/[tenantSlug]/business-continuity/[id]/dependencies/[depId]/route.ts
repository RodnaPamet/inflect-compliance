import { removeBiaDependency } from '@/app-layer/usecases/business-impact-analysis';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; id: string; depId: string };

/**
 * DELETE — detach a dependency from this BIA.
 *
 * Gated at the route (#2197) so the refusal is RECORDED: `assertCanWrite` in
 * `removeBiaDependency` refused correctly and wrote nothing, and
 * `AUTHZ_DENIED` comes from `requirePermission` alone. `continuity.edit`
 * mirrors that assert — TRUE for exactly OWNER / ADMIN / EDITOR.
 */
export const DELETE = withApiErrorHandling(
    requirePermission<Params>('continuity.edit', async (_req, { params }, ctx) => {
        return jsonResponse(await removeBiaDependency(ctx, params.id, params.depId));
    }),
);
