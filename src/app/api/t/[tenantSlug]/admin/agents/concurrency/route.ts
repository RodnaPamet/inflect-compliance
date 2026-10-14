/**
 * `/api/t/:slug/admin/agents/concurrency` — the per-tenant cap on how many
 * agentic runs may execute AT ONCE (#3484).
 *
 * The second axis beside the monthly token budget. The budget bounds spend
 * over a month and cannot express simultaneity: ten runs at once cost it the
 * same as ten runs over ten hours, so a tenant well inside its budget could
 * start runs until the shared worker pool was the limit.
 *
 * `admin.agent_registry` and not `admin.agent_kill_switch`, even though a cap
 * of 0 stops a tenant's agents. The two controls answer different questions
 * and leave different evidence: a kill switch is an emergency statement that
 * also stops tool calls inside runs ALREADY going, carries a reason, and is
 * lifted by name; a cap is a standing configuration that bounds how much new
 * work may start and stops nothing already running. Folding the cap into the
 * kill-switch key would mean a tenant could not delegate capacity planning
 * without also delegating the emergency stop.
 *
 * The gate is at the ROUTE, not one layer deeper: a `requirePermission` denial
 * writes a hash-chained `AUTHZ_DENIED` row where a usecase throw records
 * nothing — the whole of Epic D.3. Its rule must sit ABOVE the generic
 * `admin/agents(/.*)?` entry in `ROUTE_PERMISSIONS`, which matches first-wins.
 *
 * ## Why PATCH, and why `null` is a value in the body
 *
 * PATCH because the row is `TenantSecuritySettings`, which carries many other
 * settings; this writes one field of it. `cap: null` CLEARS the cap and
 * `cap: 0` sets "no agentic run may start" — two different instructions, so
 * the body distinguishes them rather than treating a missing field as either.
 * A DELETE for "clear" would have been a second way to say one thing.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';

import {
    setConcurrencyCap,
    evaluateConcurrencyForRun,
    inFlightRunCount,
} from '@/lib/agentic/run-concurrency-policy';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

const Body = z.object({
    /**
     * `null` clears the cap. `0` is legal and means no run may start.
     *
     * The upper bound is a sanity rail rather than a policy: a cap of ten
     * thousand is indistinguishable from no cap at all, and a typo that large
     * is worth refusing at the door. `int()` refuses a fractional cap here
     * rather than letting `normaliseCap` floor it silently — an operator who
     * typed 2.5 should be told, not rounded.
     */
    cap: z.number().int().min(0).max(1000).nullable(),
});

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, _routeArgs, ctx) => {
            // The REAL in-flight count, not the verdict's.
            // `evaluateConcurrencyForRun` short-circuits before counting when
            // no cap is set — correct on the run-start hot path, and a FALSE
            // ZERO as a reported figure, which is exactly the caveat
            // `spentThisMonth` carries about its own short circuit.
            const [verdict, inFlight] = await Promise.all([
                evaluateConcurrencyForRun(ctx),
                inFlightRunCount(ctx),
            ]);
            return jsonResponse({ cap: verdict.cap, inFlight });
        },
    ),
);

export const PATCH = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = Body.parse(await req.json());
            return jsonResponse(await setConcurrencyCap(ctx, body.cap));
        },
    ),
);
