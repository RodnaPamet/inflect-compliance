/**
 * GET    /api/t/{slug}/admin/external-prior-state-read/{connectionId} — list them.
 * PUT    — nominate the READ that runs before a WRITE.
 * DELETE — withdraw one, which makes the write undispatchable again.
 *
 * OWNER-only, via `admin.tenant_lifecycle`. This decides what is called against a
 * customer's own system immediately before it is changed, which is authority of
 * the same class as the rung itself — and the rung route beside it uses the same
 * key for the same reason.
 *
 * ── WHY THIS SHIPS WITH THE DISPATCH, NOT AFTER IT ──────────────────────────
 *
 * The dispatch refuses a write with no pairing. Without this route an OWNER
 * cannot create one, so every write tool would refuse permanently and the only
 * way to configure it would be a hand-written request — which is defect #3 of the
 * 2026-09-26 chain exactly, and the reason `WriteLadderClient` exists.
 *
 * ── A SIBLING PATH, NOT UNDER admin/integrations ────────────────────────────
 *
 * Route-permission matching is FIRST-MATCH-WINS and `^…/admin/integrations(/.*)?$`
 * resolves to `admin.manage`. Nesting would document a WEAKER gate than the
 * handler enforces — the trap the two identity routes and the external-write
 * policy route each state in their own notes.
 */
import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import {
    listPriorStateReads,
    setPriorStateRead,
    clearPriorStateRead,
} from '@/app-layer/usecases/external-prior-state-read';

const Body = z.object({
    writeToolName: z.string().min(1),
    readToolName: z.string().min(1),
});

/** DELETE takes only the write half — the pairing is one per write. */
const DeleteBody = z.object({ writeToolName: z.string().min(1) });

/**
 * `params` is already RESOLVED — `requirePermission` awaits `routeArgs.params`
 * once and forwards the resolved object, which is why every sibling
 * dynamic-segment admin route reads `params.<id>` directly.
 */
type PairingParams = { tenantSlug: string; connectionId: string };

/**
 * THE GATE IS INLINE IN EACH EXPORT, NOT IN A NAMED CONST.
 *
 * Every sibling admin route assigns `requirePermission(...)` to a named const
 * and exports `withApiErrorHandling(thatConst)`. Written that way here, the
 * DELETE is reported by `destructive-route-denial-census` as a destructive route
 * with no route-level gate — because that guard reads the text of each
 * `export const DELETE = …` block, and the gate was one hop away in another
 * binding.
 *
 * The guard is right about what it can see and wrong about the route, which is
 * the worse of the two failures to leave standing: the fix is to put the gate
 * where a reader of the export finds it, not to declare an exemption for a route
 * that is gated. The census exists precisely because a destructive route whose
 * refusals are invisible is a hole in the artefact this product exists to
 * produce, and a route that merely LOOKS ungated to the census will be triaged as
 * one by whoever reads the list next.
 *
 * `withApiErrorHandling` stays OUTSIDE, matching every sibling: the denial must
 * be raised inside the wrapper so it becomes the standard ApiErrorResponse and
 * its AUTHZ_DENIED row is written.
 */
export const GET = withApiErrorHandling(
    requirePermission<PairingParams>('admin.tenant_lifecycle', async (_req, { params }, ctx) =>
        jsonResponse({
            connectionId: params.connectionId,
            pairings: await listPriorStateReads(ctx, params.connectionId),
        }),
    ),
);

export const PUT = withApiErrorHandling(
    requirePermission<PairingParams>('admin.tenant_lifecycle', async (req: NextRequest, _args, ctx) => {
        const body = Body.parse(await req.json());
        // The usecase validates what no constraint can: same connection, the
        // write is a write, the read is a read, and the server advertises both.
        // Not re-checked here — a second, weaker copy is how a route ends up
        // permitting more than the usecase does.
        return jsonResponse(await setPriorStateRead(ctx, body));
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<PairingParams>('admin.tenant_lifecycle', async (req: NextRequest, _args, ctx) => {
        const { writeToolName } = DeleteBody.parse(await req.json());
        await clearPriorStateRead(ctx, writeToolName);
        return jsonResponse({ writeToolName, cleared: true });
    }),
);
