/**
 * GET /api/t/{slug}/admin/flue-wiring — which of the six terms a Flue run
 * needs are satisfied, and which one is blocking.
 *
 * This route is OWNER-only, through `admin.tenant_lifecycle`. That is the key
 * that CHANGES the driver (`PUT /admin/agent-driver`), not the `admin.view`
 * that reading the driver takes. The response is the owner's checklist for
 * wiring a Flue run. It holds the driver gate's facts plus two counts over the
 * agent register, and the AI features page shows it beside the control only an
 * owner can use. An ADMIN reads the gate itself from the agent-driver GET.
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
