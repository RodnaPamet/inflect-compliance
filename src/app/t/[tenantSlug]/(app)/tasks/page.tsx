import { getTenantCtx } from '@/app-layer/context';
import { listTasks, getTaskMetrics } from '@/app-layer/usecases/task';
import { cachedSsrPayload } from '@/lib/cache/ssr-cache';
import { TasksClient } from './TasksClient';

export const dynamic = 'force-dynamic';

// SSR fetch is capped at the most-recent SSR_PAGE_LIMIT rows so the
// initial HTML payload + DB query stay bounded as tenants accumulate
// tasks. The Epic 69 SWR client immediately fetches the unbounded
// list in the background (the existing API GET path), and SWR's
// keepPreviousData swaps it in transparently. UX is "first 100
// instantly, rest within ~500 ms" — never a blank flash. We use
// `listTasks` (priority-asc, createdAt-desc) rather than
// `listTasksPaginated` (createdAt-desc, id-desc) so SSR + SWR share
// the same ordering and the row order doesn't reshuffle mid-load.
const SSR_PAGE_LIMIT = 100;

/**
 * Tasks — Server Component.
 * Fetches task list server-side (with URL filters applied),
 * delegates all interaction to client island.
 */
export default async function TasksPage({
    params,
    searchParams,
}: {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { tenantSlug } = await params;
    const sp = await searchParams;
    const ctx = await getTenantCtx({ tenantSlug });

    // Build filters from searchParams for server-side data fetch. The
    // whitelist mirrors the live filter keys (filter-defs) so a bookmarked
    // deep link (e.g. ?source=…, ?assigneeUserId=…, ?controlId=…) restores
    // the filtered view + its chips on SSR, not just q/status/type/severity/due.
    // (`priority` is intentionally absent — it's in TaskQuerySchema but is not
    // an actual filter chip, so there's nothing to restore.)
    const filters: Record<string, string> = {};
    for (const key of ['q', 'status', 'type', 'severity', 'source', 'due', 'assigneeUserId', 'awaitingReviewBy', 'controlId']) {
        const val = sp[key];
        if (typeof val === 'string' && val) filters[key] = val;
    }

    // SSR payload cache — unfiltered load only; filtered bypasses (list-cache covers it).
    const fetchTasks = () =>
        listTasks(ctx, Object.keys(filters).length > 0 ? filters : undefined, { take: SSR_PAGE_LIMIT });
    const [tasks, metrics] = await Promise.all([
        Object.keys(filters).length > 0
            ? fetchTasks()
            : cachedSsrPayload({ tenantId: ctx.tenantId, route: 'tasks', ttlSeconds: 30, compute: fetchTasks }),
        // TP-7 — the list KPI strip is SERVER-computed (getTaskMetrics)
        // rather than counted from the SSR row slice, so the KPI values
        // stay correct past the 100-row SSR cap. The client feeds this
        // as SWR fallbackData and revalidates against /tasks/metrics
        // (which returns the SAME usecase) — the two can never diverge.
        getTaskMetrics(ctx),
    ]);

    return (
        <TasksClient
            initialTasks={JSON.parse(JSON.stringify(tasks))}
            initialMetrics={JSON.parse(JSON.stringify(metrics))}
            initialFilters={filters}
            tenantSlug={tenantSlug}
            appPermissions={{
                tasks: ctx.appPermissions.tasks,
            }}
        />
    );
}
