/**
 * GET  /api/t/{slug}/admin/external-write-policy/{connectionId} — read the rung.
 * PUT  /api/t/{slug}/admin/external-write-policy/{connectionId} — set it.
 *
 * OWNER-only, via `admin.tenant_lifecycle` — the same key that guards tenant
 * deletion and DEK rotation, and the same one the identity write policy uses.
 * This setting decides whether the product may CHANGE a configuration in a
 * system that is not ours, which is authority of that class; ADMIN explicitly
 * does not hold it.
 *
 * `requirePermission` rather than a hand-rolled role check, so a denial writes an
 * `AUTHZ_DENIED` audit row. A 403 nobody can find later is not a gate.
 *
 * ── WHY THIS IS A SIBLING AND NOT UNDER admin/integrations/{id}/ ─────────────
 *
 * Route-permission matching is FIRST-MATCH-WINS, and
 * `^…/admin/integrations(/.*)?$` resolves to `admin.manage`. Nesting this under
 * that prefix would document a WEAKER gate than the handler enforces — the trap
 * `admin/identity-leaver-passes` and `admin/identity-write-journal` each state in
 * their own notes, having been made siblings for exactly this reason. The
 * connection id is a path segment here instead, so the rule for this path is the
 * one that matches it.
 */
import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import {
    getExternalWritePolicy,
    setExternalWriteMode,
} from '@/app-layer/usecases/external-write-policy';
import {
    EXTERNAL_MAX_MODE,
    LADDER,
    MODE_MIN_DAYS,
    MODE_MIN_EVIDENCE,
} from '@/lib/integrations/external-write-ladder';

/**
 * `LADDER`, not a hand-written list of the same four strings.
 *
 * The identity route's own docstring explains what this avoids: a literal copy is
 * how a route goes on offering a rung the ladder no longer has. `RETIRED_MODES`
 * is empty today, so nothing is currently rejected by this that used to be
 * accepted — but when a rung is retired, a PUT naming it becomes a 400 whose zod
 * error names the rungs that exist, rather than being coerced. Coercing a READ
 * translates a value nobody can change now; coercing a WRITE would store a
 * different rung than the caller asked for and restart the dwell as a side
 * effect, which is a decision no caller made.
 */
const Body = z.object({ mode: z.enum(LADDER) });

/**
 * `params` is already RESOLVED by the time a handler sees it — `requirePermission`
 * awaits `routeArgs.params` once and forwards the resolved object, which is why
 * every sibling dynamic-segment admin route reads `params.<id>` directly rather
 * than awaiting it again.
 */
type PolicyParams = { tenantSlug: string; connectionId: string };

const getHandler = requirePermission<PolicyParams>(
    'admin.tenant_lifecycle',
    async (_req, { params }, requestCtx) => {
        const { connectionId } = params;
        const policy = await getExternalWritePolicy(requestCtx, connectionId);

        return jsonResponse({
            ...policy,
            // WHAT THE RUNTIME WILL ACTUALLY HONOUR, which is not the same as what
            // the ladder can express — and the difference is invisible without it.
            //
            // `maxMode` is whatever `EXTERNAL_MAX_MODE` says and this comment no
            // longer quotes a value, because the one it used to quote — `DRY_RUN`,
            // "because no dispatch reads this rung yet" — had been wrong through
            // two raises (`PROPOSE_ONLY` 2026-10-01, `AUTOMATIC` 2026-10-06) while
            // sitting on the file that publishes the ceiling. A comment stating a
            // ceiling is a second copy of it with no ratchet, which is the same
            // defect as the hand-typed literal the next sentence is about.
            //
            // The identity route learned the cost of hand-typing this value instead
            // of importing it: a literal here and an imported clamp in the usecase
            // drift the moment one is raised, and the failure is silent in the
            // dangerous direction — the gate stops refusing while the surface goes
            // on reporting the old ceiling. One constant, imported by both.
            honoured: {
                maxMode: EXTERNAL_MAX_MODE,
                // Stated so a surface can say WHY the rungs above are unavailable,
                // rather than only greying them out. "Disabled with no reason" is
                // how an operator concludes the feature is broken.
                //
                // DERIVED, and it was a hand-typed `dispatchImplemented: false`
                // until 2026-10-02 — one line below the comment above warning
                // that exactly this drifts the moment the clamp is raised. It
                // did: steps 1-3 of #2861 shipped the dispatch and step 6 raised
                // the ceiling to PROPOSE_ONLY, and this field went on telling
                // operators "no external write is dispatched by this build yet"
                // while the build dispatched them. A literal cannot be kept true
                // by review; a derivation cannot be false.
                //
                // What the notice actually means is "the ceiling is below the
                // top rung", which is the question the surface asks — so that is
                // what it is named and how it is computed.
                ceilingBelowTopRung: EXTERNAL_MAX_MODE !== LADDER[LADDER.length - 1],
                minDays: MODE_MIN_DAYS,
                minEvidence: MODE_MIN_EVIDENCE,
            },
        });
    },
);

const putHandler = requirePermission<PolicyParams>(
    'admin.tenant_lifecycle',
    async (req: NextRequest, { params }, requestCtx) => {
        const { connectionId } = params;
        const { mode } = Body.parse(await req.json());
        // The SAME constant published as `honoured.maxMode` above. Passed rather
        // than imported inside the usecase, so the published ceiling and the
        // enforced ceiling are one value by construction rather than by review —
        // and so the usecase's `clamp` parameter stays REQUIRED, which is what
        // makes forgetting it a compile error instead of a missing check.
        const policy = await setExternalWriteMode(requestCtx, connectionId, mode, EXTERNAL_MAX_MODE);
        return jsonResponse(policy);
    },
);

// `withApiErrorHandling` OUTSIDE `requirePermission`, matching the identity
// write-policy route: the permission denial must be raised inside the wrapper so
// it becomes the standard ApiErrorResponse (and its AUTHZ_DENIED audit row is
// written) rather than escaping as an unhandled throw.
export const GET = withApiErrorHandling(getHandler);
export const PUT = withApiErrorHandling(putHandler);
