import { NextRequest } from 'next/server';

import { listUnsettledWrites } from '@/app-layer/usecases/identity-write-journal';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

/**
 * GET /api/t/:tenantSlug/admin/identity-write-journal/unsettled
 *
 * The writes that never reported an outcome — PENDING because this product
 * crashed before it could settle the row, INDETERMINATE because the directory
 * call did not report back. They mean the same thing to a human: go and look at
 * the account, because we do not know whether it changed.
 *
 * ═══ WHY THIS ROUTE DID NOT EXIST ═══
 *
 * `listUnsettledWrites` had no caller in `src/` (#2877 f52). It was written,
 * tested, and bounded, and the only thing that ever consulted it was a metrics
 * counter — so the backlog it exists to surface was counted and never shown.
 * A number on a dashboard tells an operator that N accounts are in an unknown
 * state; it cannot tell them WHICH.
 *
 * ═══ THE AGE FLOOR IS A PARAMETER WITH A DEFAULT, NOT A CONSTANT ═══
 *
 * A write that has not settled in the last few seconds is almost certainly a
 * pass still running, and listing those would make the page flicker with rows
 * that resolve themselves. The default excludes anything younger than an hour;
 * `?minutes=` narrows or widens it for an operator working an incident, who
 * legitimately wants to see what is in flight right now.
 *
 * Clamped rather than rejected. A malformed or absent value falls back to the
 * default, for the same reason the sibling index clamps `limit`: a request that
 * plainly meant "no opinion" should get the ordinary answer, not a 400.
 *
 * GATED `admin.tenant_lifecycle`, inherited from the prefix rule over
 * `admin/identity-write-journal` — OWNER-only, the same key as the reads beside
 * it. A row here names a change made to one of a customer's people's accounts.
 */

/** An hour. Long enough that a pass in flight is not a backlog. */
const DEFAULT_MINUTES = 60;
/** A month. Beyond this the age filter stops meaning anything useful. */
const MAX_MINUTES = 60 * 24 * 31;

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.tenant_lifecycle', async (req: NextRequest, _routeArgs, ctx) => {
        const url = new URL(req.url);
        // EMPTY IS ABSENT, NOT ZERO. `Number('')` is 0 and finite, so a bare
        // `?minutes=` — which plainly means "no opinion" — would otherwise ask
        // for everything unsettled as of this instant, including the pass
        // currently running. The sibling index route guards its `limit` against
        // the identical trap and says so; an explicit `?minutes=0` still means
        // zero, because that is somebody asking on purpose.
        const raw = url.searchParams.get('minutes');
        const parsed = raw === null || raw.trim() === '' ? NaN : Number(raw);
        const minutes =
            Number.isFinite(parsed) && parsed >= 0
                ? Math.min(Math.trunc(parsed), MAX_MINUTES)
                : DEFAULT_MINUTES;

        const provider = url.searchParams.get('provider') ?? undefined;
        const olderThan = new Date(Date.now() - minutes * 60_000);

        const writes = await listUnsettledWrites(ctx, olderThan, provider);
        // The cutoff travels with the answer. Without it a page showing an
        // empty list cannot tell an operator whether there is no backlog or
        // whether it asked about the wrong window.
        return jsonResponse({ writes, olderThan: olderThan.toISOString(), minutes });
    }),
);
