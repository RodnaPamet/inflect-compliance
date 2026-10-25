/**
 * GET  /api/t/{slug}/admin/agent-driver — which engine this tenant's agentic
 *      runs execute on, and which one they WOULD execute on.
 * PUT  /api/t/{slug}/admin/agent-driver — set the tenant's half of the gate.
 *
 * The GET is `admin.view`, so every admin can read it. The PUT is
 * `admin.tenant_lifecycle`, so only an OWNER can change it (owner decision
 * 2026-10-25, #4139).
 *
 * The read is open because the AI features page shows the gate to everyone who
 * can reach it. Before, an ADMIN could not see why the tenant ran on the engine
 * it did, and a gate nobody can read looks exactly like a broken one.
 *
 * The write keeps the key that guards tenant deletion and DEK rotation. The
 * identity write-policy route makes the same argument: switching to FLUE hands
 * an external agent runtime the decision of what to TRY against this tenant's
 * compliance data. `runReadTool` still decides what is permitted, so no
 * register control moves, but deciding that is tenant-lifecycle authority, and
 * ADMIN deliberately does not hold it.
 *
 * `requirePermission` rather than a hand-rolled role check, so a denial writes
 * an `AUTHZ_DENIED` audit row. A 403 nobody can find later is not a gate.
 */
import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { jsonResponse } from '@/lib/api-response';
import {
    getAgentDriverSetting,
    setAgentDriverSetting,
} from '@/app-layer/usecases/agent-driver-setting';
import { withApiErrorHandling } from '@/lib/errors/api';
import { AGENT_DRIVER_MODES } from '@/lib/agentic/agent-driver';
import { requirePermission } from '@/lib/security/permission-middleware';

/**
 * `AGENT_DRIVER_MODES`, not a hand-written copy of the same two strings. The
 * enum is the one place the vocabulary lives, and a literal here is how a
 * route goes on accepting a mode the resolver has stopped recognising — the
 * exact drift the identity route's own Body schema was rewritten to avoid.
 */
const Body = z.object({ mode: z.enum(AGENT_DRIVER_MODES) });

const getHandler = requirePermission('admin.view', async (_req, _ctx, requestCtx) =>
    // The response carries all three terms, not just the stored one. A tenant
    // set to FLUE in a deployment whose switch is off runs on the static
    // engine, and a surface that reported only `mode` would show FLUE while
    // every run went elsewhere — settable-and-inert, reported as working.
    jsonResponse(await getAgentDriverSetting(requestCtx)),
);

const putHandler = requirePermission(
    'admin.tenant_lifecycle',
    async (req: NextRequest, _ctx, requestCtx) => {
        const { mode } = Body.parse(await req.json());
        return jsonResponse(await setAgentDriverSetting(requestCtx, mode));
    },
);

// `withApiErrorHandling` OUTSIDE `requirePermission`, matching the identity
// write-policy route and tenant-dek-rotation: the permission denial must be
// raised inside the wrapper so it becomes the standard ApiErrorResponse (and
// its AUTHZ_DENIED audit row is written) rather than escaping as an unhandled
// throw.
export const GET = withApiErrorHandling(getHandler);
export const PUT = withApiErrorHandling(putHandler);
