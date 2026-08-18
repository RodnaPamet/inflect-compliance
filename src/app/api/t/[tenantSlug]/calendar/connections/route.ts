import { NextRequest } from 'next/server';
import { requireAnyPermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { CALENDAR_BASELINE_PERMISSIONS } from '@/app-layer/usecases/compliance-calendar';
import {
    listCalendarConnections,
    revokeCalendarConnection,
    isCalendarProviderId,
} from '@/app-layer/usecases/user-calendar-connection';

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
 * ═══ WHY THESE TWO VERBS AND NOT connect/callback ═══
 *
 * Starting consent needs a provider authorize URL, and the Microsoft half of
 * that is blocked on an unresolved product decision: in any Entra tenant using
 * Microsoft's RECOMMENDED consent policy, per-user self-service consent to
 * `Calendars.ReadWrite` is refused, because the policy allows user consent only
 * for verified publishers AND only for permissions an admin has classified
 * low-impact — and there is no default low-impact set. Those users would hit
 * "Approval required", which reads to us as low adoption rather than a blocked
 * gate. Building the authorize URL before deciding whether there is also an
 * admin-consent path would mean rewriting the consent flow after it is tested.
 */
export const GET = withApiErrorHandling(
    requireAnyPermission<{ tenantSlug: string }>(
        CALENDAR_BASELINE_PERMISSIONS,
        async (_req: NextRequest, _routeArgs, ctx) => {
            // Keyed off ctx.userId — never a userId parameter. One user must
            // not be able to read another's connection state, and the surest
            // way to guarantee that is to give the route no way to name one.
            const connections = await listCalendarConnections(ctx);
            return Response.json({ connections });
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
            // ORDERING NOTE for when C5's event mapping lands: the pushed
            // remote events must be deleted BEFORE this call. Revoking first
            // destroys the token, and the events are then stranded in the
            // user's personal calendar with no credential left to remove them.
            await revokeCalendarConnection(ctx, provider, 'disconnected by user');
            return new Response(null, { status: 204 });
        },
    ),
);
