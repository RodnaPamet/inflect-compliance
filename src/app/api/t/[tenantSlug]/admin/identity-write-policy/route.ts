/**
 * GET  /api/t/{slug}/admin/identity-write-policy — read both directions.
 * PUT  /api/t/{slug}/admin/identity-write-policy — set one direction's mode.
 *
 * OWNER-only, via `admin.tenant_lifecycle`. That key is deliberately the same
 * one that guards tenant deletion and DEK rotation: this setting decides whether
 * the product may disable or create accounts in the customer's own identity
 * directory, which is authority of the same class — and ADMIN explicitly does
 * not hold it (`getPermissionsForRole('ADMIN').admin.tenant_lifecycle` is false
 * by type).
 *
 * `requirePermission` rather than a hand-rolled role check, so a denial writes an
 * `AUTHZ_DENIED` audit row. A 403 nobody can find later is not a gate.
 */
import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import {
    getIdentityWritePolicy,
    setIdentityWriteMode,
    describeRefusal,
    DRY_RUN_MIN_DAYS,
} from '@/app-layer/usecases/identity-write-policy';
import { LEAVER_MAX_MODE } from '@/app-layer/usecases/identity-leaver-pass';
import { JOINER_MAX_MODE } from '@/app-layer/usecases/identity-joiner-pass';
import { DIRECTION_IMPLEMENTED, LADDER } from '@/lib/identity/write-ladder';

/**
 * `LADDER`, not a hand-written list of the same strings.
 *
 * WHAT THIS BODY ACCEPTS AND WHY IT REJECTS THE RETIRED RUNG. `PROPOSE` was
 * removed from the ladder in #2241 and is NOT accepted here: a PUT naming it is
 * a 400 whose zod error names the three modes that exist. The alternative —
 * accept it and coerce to DRY_RUN, the way a stored value is coerced on read —
 * was rejected. Coercing a READ translates a value nobody can change now;
 * coercing a WRITE would store a different rung than the caller asked for and
 * would silently restart the seven-day dry-run clock as a side effect, which is
 * a decision no caller made. A 400 that names the valid modes tells an old
 * client exactly what happened.
 *
 * No UI sends it: `WriteLadderClient` only ever PUTs `nextMode` (computed from
 * `LADDER` below) or the rung immediately below the current one.
 */
const Body = z.object({
    direction: z.enum(['leaver', 'joiner']),
    mode: z.enum(LADDER),
});

const getHandler = requirePermission('admin.tenant_lifecycle', async (_req, _ctx, requestCtx) => {
    const policy = await getIdentityWritePolicy(requestCtx);
    const now = new Date();

    // Return the refusal reason for each direction's NEXT rung alongside the
    // current state, so the UI can explain why a control is unavailable instead
    // of only disabling it. "Greyed out with no reason" is how an operator
    // concludes the feature is broken.
    return jsonResponse({
        directions: Object.fromEntries(
            (['leaver', 'joiner'] as const).map((d) => {
                // `LADDER`, not a fourth copy of it. This literal was exactly the
                // duplication the shared module was created to end — the module's
                // own docstring named the two copies it replaced and missed this
                // one, which is how a route can go on offering a rung the ladder
                // no longer has.
                const next = LADDER[Math.min(LADDER.indexOf(policy[d].mode) + 1, LADDER.length - 1)];
                return [
                    d,
                    {
                        mode: policy[d].mode,
                        dryRunSince: policy[d].dryRunSince,
                        nextMode: next === policy[d].mode ? null : next,
                        blockedReason: next === policy[d].mode ? null : describeRefusal(d, policy[d], next, now),
                    },
                ];
            }),
        ),
        dryRunMinDays: DRY_RUN_MIN_DAYS,
        // WHAT THE RUNTIME WILL ACTUALLY HONOUR, which is not the same as what
        // this policy will accept — and the difference is invisible without it.
        //
        // The ladder is a statement of intent stored on the tenant; the PASS
        // enforces its own clamp. For the LEAVER the two now agree: #2187 raised
        // the clamp to AUTOMATIC and #2241 deleted the rung that ran but decided
        // nothing, so every rung this route will accept is one the pass acts on.
        // The joiner's ceiling is now the joiner pass's own constant too, and
        // BOTH values here are imported for the same reason (#2638).
        //
        // It used to be a hand-typed `'DISABLED' as const` on this line while
        // the leaver's came from its pass — and that literal-versus-import
        // difference is precisely what `write-ladder.ts` warned the joiner would
        // fall into. Flip `DIRECTION_IMPLEMENTED.joiner` with the literal still
        // here and the gate stops refusing while this response keeps reporting a
        // DISABLED ceiling: `isAboveClamp` is then true for every rung above
        // off, the client renders the aboveClamp banner, and nothing clamps
        // anything — settable-and-inert again, just differently worded.
        //
        // With the import there is no second value to drift. `JOINER_MAX_MODE`
        // is the rung `planJoinerPass` enforces at its own gate 1, so what an
        // operator is told the runtime will honour is the thing the runtime
        // honours, by construction rather than by review.
        //
        // `implemented` is READ from `DIRECTION_IMPLEMENTED`, not restated here.
        // It used to be a literal `false` in this block and the only thing that
        // consulted it was this JSON, so the write path let a tenant climb the
        // joiner to AUTOMATIC while this same response called it unbuilt.
        // `describeRefusal` now reads the same constant, so the reason the UI
        // prints and the refusal the PUT raises cannot drift apart. It is still
        // false for the joiner, and #2687 narrowed the reason to ONE: a planner
        // exists AND a dispatcher and a schedule now call it, but
        // decision 10's map now HAS somewhere to live (#2713 —
        // `IdentityDepartmentGroupRule` plus the singular fallback on
        // `TenantSecuritySettings`). Somewhere to live is not somewhere to be
        // PUT: there is no write path for either half (#2839), so no tenant
        // can configure it and every pass still refuses `NO_DEPARTMENT_MAP`.
        // The create VERB is also still missing (#2714), which is why
        // `DIRECTION_IMPLEMENTED.joiner` stays false: #2713 closed neither
        // conjunct outright.
        honoured: {
            leaver: { maxMode: LEAVER_MAX_MODE, implemented: DIRECTION_IMPLEMENTED.leaver },
            joiner: { maxMode: JOINER_MAX_MODE, implemented: DIRECTION_IMPLEMENTED.joiner },
        },
    });
});

const putHandler = requirePermission('admin.tenant_lifecycle', async (req: NextRequest, _ctx, requestCtx) => {
    const { direction, mode } = Body.parse(await req.json());
    const state = await setIdentityWriteMode(requestCtx, direction, mode);
    return jsonResponse({ direction, ...state });
});

// `withApiErrorHandling` OUTSIDE `requirePermission`, matching
// tenant-dek-rotation: the permission denial must be raised inside the wrapper
// so it becomes the standard ApiErrorResponse (and its AUTHZ_DENIED audit row
// is written) rather than escaping as an unhandled throw.
export const GET = withApiErrorHandling(getHandler);
export const PUT = withApiErrorHandling(putHandler);
