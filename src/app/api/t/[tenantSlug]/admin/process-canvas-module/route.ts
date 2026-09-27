/**
 * GET  /api/t/{slug}/admin/process-canvas-module — is the module on?
 * PUT  /api/t/{slug}/admin/process-canvas-module — turn it on or off.
 *
 * OWNER-only, via `admin.tenant_lifecycle` — the same key that guards tenant
 * deletion, DEK rotation and the identity write ladder. Granting or removing a
 * whole product surface belongs in that class, and ADMIN explicitly does not
 * hold it (`getPermissionsForRole('ADMIN').admin.tenant_lifecycle` is false by
 * type).
 *
 * `requirePermission` rather than a hand-rolled role check, so a denial writes
 * an `AUTHZ_DENIED` audit row. A 403 nobody can find later is not a gate.
 */
import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import {
    isProcessCanvasEnabled,
    setProcessCanvasEnabled,
} from '@/app-layer/usecases/process-canvas-module';

/**
 * `enabled` is REQUIRED and strictly boolean.
 *
 * Not `.optional()` and not coerced. A PUT that omits the field would otherwise
 * read as `undefined` and disable the module, which is the wrong direction for
 * a missing value to fail in: the surface would vanish for a tenant because a
 * client forgot a key.
 */
const Body = z.object({ enabled: z.boolean() });

const getHandler = requirePermission(
    'admin.tenant_lifecycle',
    async (_req: NextRequest, _ctx, requestCtx) => {
        return jsonResponse({ enabled: await isProcessCanvasEnabled(requestCtx) });
    },
);

const putHandler = requirePermission(
    'admin.tenant_lifecycle',
    async (req: NextRequest, _ctx, requestCtx) => {
        const { enabled } = Body.parse(await req.json());
        const state = await setProcessCanvasEnabled(requestCtx, enabled);
        // `changed` travels to the client so the UI can tell "you turned it on"
        // from "it was already on" without re-reading. The usecase declines to
        // audit a no-op, and a caller that could not see the difference would
        // have to guess whether a row exists.
        return jsonResponse(state);
    },
);

// `withApiErrorHandling` OUTSIDE `requirePermission`, matching
// identity-write-policy and tenant-dek-rotation: the permission denial must be
// raised inside the wrapper so it becomes the standard ApiErrorResponse (and
// its AUTHZ_DENIED audit row is written) rather than escaping as an unhandled
// throw.
export const GET = withApiErrorHandling(getHandler);
export const PUT = withApiErrorHandling(putHandler);
