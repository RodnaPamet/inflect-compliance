import { NextRequest } from 'next/server';
import { requireAnyPermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { CALENDAR_BASELINE_PERMISSIONS } from '@/app-layer/usecases/compliance-calendar';
import {
    listCalendarConnections,
    isCalendarProviderId,
} from '@/app-layer/usecases/user-calendar-connection';
import { disconnectCalendar } from '@/app-layer/usecases/calendar-push-person';
import {
    calendarConnectionStateOf,
    readCalendarConnectability,
} from '@/app-layer/usecases/calendar-connectability';

/**
 * C7 — a user's own calendar connections: read them, and disconnect.
 *
 * ═══ THE GATE, AND WHY IT IS NOT A NEW PERMISSION KEY ═══
 *
 * `requireAnyPermission(CALENDAR_BASELINE_PERMISSIONS, …)` — exactly the gate
 * on `calendar/route.ts`, and for the same reason. That constant is DERIVED
 * from the 19 sources' own per-source permission keys, not hand-maintained, so
 * it cannot drift from what the calendar actually shows.
 *
 * Adding a bespoke `calendar.connect` key was the obvious alternative and is
 * wrong twice over. It would mean editing `PermissionSet`, `PERMISSION_SCHEMA`,
 * all five role branches of `getPermissionsForRole`, a DUPLICATED
 * `PERMISSION_SCHEMA` in the admin roles page, five test files that build the
 * admin bag as an exact literal, and a job — for a capability that is not a
 * distinct authority at all. Holding none of the calendar's view permissions
 * already means there is nothing to push; a separate key would let a role be
 * granted "connect" while having nothing to connect ABOUT.
 *
 * `requireAnyPermission` delegates to `requirePermission`, so denials still
 * emit AUTHZ_DENIED via `auditPermissionDenied`. That matters: a gate that
 * refuses without auditing is an UNLOGGED gate, and the whole point of
 * declaring the right tier is that the refusal is visible.
 *
 * ═══ NO ROUTE_PERMISSIONS ENTRY, DELIBERATELY ═══
 *
 * `calendar` is not one of the 13 `PRIVILEGED_ROOTS`, so the coverage guardrail
 * does not scan here. Adding a `ROUTE_PERMISSIONS` rule WITHOUT also adding
 * `calendar` to `PRIVILEGED_ROOTS` in the same diff makes the rule an orphan
 * and turns CI red — the guardrail iterates its rules and requires each to
 * match a file discovered from those roots. Neither edit is made, matching the
 * existing `calendar/route.ts`.
 *
 * ═══ CONNECT LIVES ELSEWHERE ═══
 *
 * Starting a connection is `POST /calendar/connect` (it returns the provider's
 * authorize URL) and finishing it is the callback outside the tenant tree.
 * This route reads and disconnects; its GET also reports whether each provider
 * CAN be connected (`readCalendarConnectability`), the same rule the connect
 * route refuses with — the consent model is the owner's decision of 2026-11-25
 * (docs/calendar-push-design.md).
 */
export const GET = withApiErrorHandling(
    requireAnyPermission<{ tenantSlug: string }>(
        CALENDAR_BASELINE_PERMISSIONS,
        async (_req: NextRequest, _routeArgs, ctx) => {
            // Keyed off ctx.userId — never a userId parameter. One user must
            // not be able to read another's connection state, and the surest
            // way to guarantee that is to give the route no way to name one.
            //
            // `providers` (#5937 step 4) says, per provider, whether a connect
            // would be accepted and why not — the same rule the connect route
            // refuses with, so the Connect control never computes it itself
            // and never offers a button that would fail.
            const [connections, providers] = await Promise.all([
                listCalendarConnections(ctx),
                readCalendarConnectability(ctx),
            ]);
            // `state` is the connection as the control words it; only the
            // server can tell a person's disconnect from a refused token.
            return Response.json({
                connections: connections.map((c) => ({ ...c, state: calendarConnectionStateOf(c) })),
                providers,
            });
        },
    ),
);

export const DELETE = withApiErrorHandling(
    requireAnyPermission<{ tenantSlug: string }>(
        CALENDAR_BASELINE_PERMISSIONS,
        async (req: NextRequest, _routeArgs, ctx) => {
            const provider = req.nextUrl.searchParams.get('provider') ?? '';
            if (!isCalendarProviderId(provider)) {
                throw badRequest('A known calendar provider is required');
            }
            // The pushed events are removed FIRST and the token dropped AFTER
            // (#5937 step 2). Revoking first would strand the events in the
            // person's calendar with no credential left to remove them.
            //
            // 204: every pushed event is gone and the token with them.
            // 202: some are still there; the connection keeps its token while
            //      the nightly run removes them, for at most
            //      DISCONNECT_RETRY_DAYS, then drops it anyway.
            const result = await disconnectCalendar(ctx, provider);
            if (result.status === 'disconnected') return new Response(null, { status: 204 });
            return Response.json(result, { status: 202 });
        },
    ),
);
