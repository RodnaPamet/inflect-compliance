/**
 * GET /api/t/{slug}/admin/flue-wiring — which of the six terms a Flue run
 * needs are satisfied, and which one is blocking.
 *
 * OWNER-only via `admin.tenant_lifecycle`, the SAME key as the driver toggle
 * this sits beside. The response is strictly a superset of that route's facts
 * — the tenant's mode, the env switch, the build flag, the workflow term, plus
 * two counts over the register — so gating it any lower would make a narrower
 * key a way to read what the wider one guards.
 *
 * READ-ONLY on purpose. Every term is fixed on the surface that owns it: the
 * tenant's half through `PUT /admin/agent-driver`, the register through
 * `/admin/agents`, the credential through the API-keys page. A second write
 * path to any of them would be a second place to audit.
 *
 * `withApiErrorHandling` OUTSIDE `requirePermission`, matching the sibling
 * route: the denial must be raised inside the wrapper so it becomes the
 * standard ApiErrorResponse and its AUTHZ_DENIED row is written.
 */
import { jsonResponse } from '@/lib/api-response';
import { getFlueWiringState } from '@/app-layer/usecases/flue-wiring';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

const getHandler = requirePermission('admin.tenant_lifecycle', async (_req, _ctx, requestCtx) =>
    jsonResponse(await getFlueWiringState(requestCtx)),
);

export const GET = withApiErrorHandling(getHandler);
