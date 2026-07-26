/**
 * Epic 49 — `GET /api/t/[tenantSlug]/calendar/upcoming-count`.
 *
 * Lightweight count of the logged-in user's tasks that NEED ATTENTION, for
 * the sidebar Calendar nav badge: tasks assigned to the caller, OVERDUE or
 * upcoming, other users' work excluded. The nav labels the scope explicitly
 * ("my tasks") because the Calendar PAGE this badge sits on is tenant-wide
 * across every deadline source. Capped at 99 (the UI renders `99+` past the
 * cap) so the badge stays scannable. Uses Prisma `count()` + `take` to
 * short-circuit heavy users.
 *
 * Query params:
 *   - `days` (optional) — cap the FORWARD window to N days. Overdue is always
 *     counted regardless: late work doesn't stop needing attention because the
 *     caller asked for a narrow horizon.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { getUpcomingDeadlineCount } from '@/app-layer/usecases/compliance-calendar';

const QuerySchema = z.object({
    days: z.coerce.number().int().min(1).max(60).optional(),
});

// The badge counts the caller's OWN open tasks (overdue + upcoming). It reads
// task data, so it gates on `tasks.view` — a scopeless API key is denied
// rather than being told "nothing needs attention".
export const GET = withApiErrorHandling(
    requirePermission('tasks.view', async (req: NextRequest, _routeArgs, ctx) => {
        const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
        const { days } = QuerySchema.parse(sp);
        const count = await getUpcomingDeadlineCount(ctx, {
            horizonDays: days,
        });
        // Return the window + scope so the badge and the tenant-wide calendar
        // page it links to can be reconciled rather than silently disagree
        // (the badge is my-open-tasks; the page is every source, tenant-wide).
        return jsonResponse({
            count,
            windowDays: days ?? null,
            scope: 'my_open_tasks',
            includesOverdue: true,
        });
    }),
);
