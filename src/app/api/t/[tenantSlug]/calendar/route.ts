/**
 * Epic 49 — `GET /api/t/[tenantSlug]/calendar` route.
 *
 * Returns the unified compliance-calendar event stream for the given
 * date range. Powers the heatmap, monthly grid, and Gantt views.
 *
 * Query params (validated by `CalendarQuerySchema`):
 *   - `from` (required) — ISO date / datetime
 *   - `to`   (required) — ISO date / datetime
 *   - `types`      (optional) — comma-separated CalendarEventType list
 *   - `categories` (optional) — comma-separated CalendarEventCategory list
 *
 * Response: `CalendarResponse` (events + counts + range).
 *
 * Tenant safety: `getTenantCtx(params, req)` resolves the slug → ctx,
 * verifies membership, and the underlying usecase always filters on
 * `tenantId: ctx.tenantId`.
 */

import { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireAnyPermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import {
    getComplianceCalendarEvents,
    CALENDAR_BASELINE_PERMISSIONS,
} from '@/app-layer/usecases/compliance-calendar';
import { CalendarQuerySchema } from '@/app-layer/schemas/calendar.schemas';

// The calendar aggregates 19 sources (17 at Epic 49; asset-vulnerability and
// audit were added when the projection-completeness guard found them missing). Authorization is PER-SOURCE inside the
// usecase (each loader gates on its domain `.view`); this baseline denies a
// caller who holds NONE of those view permissions — notably a scopeless API
// key (e.g. `mcp:read`, which maps to no PermissionSet flags) that would
// otherwise read the whole tenant deadline stream. Denials emit AUTHZ_DENIED.
export const GET = withApiErrorHandling(
    requireAnyPermission(CALENDAR_BASELINE_PERMISSIONS, async (req: NextRequest, _routeArgs, ctx) => {
        const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
        const query = CalendarQuerySchema.parse(sp);

        const response = await getComplianceCalendarEvents(ctx, {
            from: query.fromDate,
            to: query.toDate,
            types: query.types,
            categories: query.categories,
        });

        return jsonResponse(response);
    }),
);
