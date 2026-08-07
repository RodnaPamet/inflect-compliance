'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/* eslint-disable react-hooks/exhaustive-deps -- Various useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers/derived arrays recreated each render). The proper structural fix is wrapping parent-level callbacks in useCallback. Tracked as follow-up; existing per-line eslint-disable-next-line markers preserved. */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, Trash } from '@/components/ui/icons/nucleo';
import { ViewsMenu } from '@/components/ui/views-menu';
import { NewTaskModal } from './NewTaskModal';
import { AsidePanel } from '@/components/ui/aside-panel';
import { TaskEditPanel } from '@/components/controls-shared/TaskEditPanel';
import { AppIcon } from '@/components/icons/AppIcon';
import { useSWRConfig } from 'swr';
import { useTenantSWR, usePrefetchTenant } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { useThresholdLoadMore, useToast, useToastWithUndo } from '@/components/ui/hooks';
import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';
import { Tooltip } from '@/components/ui/tooltip';
import { DataTable, createColumns, useColumnsDropdown, sortRowsByDisplay, type SortAccessors } from '@/components/ui/table';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
    useFilterCardVisibility,
    filtersToCards,
    selectVisibleFilters,
} from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import {
    buildTaskFilters,
    TASK_FILTER_KEYS,
    taskSeverityLabels,
    taskSourceLabels,
} from './filter-defs';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { useKpiFilter, type KpiFilterDef } from '@/components/ui/kpi-filter';
import { useKpiTrends, buildKpiSparklines, buildKpiSparklineNullable, centeredSparklineDomain, assignSparklineVariants } from '@/lib/charts/kpi-trends';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { useCurrentUserId, useTenantHref } from '@/lib/tenant-context-provider';
import { BulkActionBar, type BulkActionDef } from '@/components/ui/bulk-action-bar';
import { ownerDisplayName } from '@/lib/owner-display';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { taskStatusVariant, TASK_STATUS_BADGE } from '@/lib/task-status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { useCreateQueryParam } from '@/components/ui/hooks/use-create-query-param';
import { useSsrFallback } from '@/components/ui/hooks/use-ssr-fallback';

// Status → badge tone AND label both come from the shared
// `TASK_STATUS_BADGE` map (TP-1) — tone via `taskStatusVariant`, copy via the
// map's `labelKey`. Deriving the record (rather than hand-listing statuses)
// is what stops a status from going missing: IN_REVIEW was absent here and
// rendered as a raw "IN_REVIEW" string in the list + bulk-status surfaces.
const buildStatusLabels = (t: (k: string) => string): Record<string, string> =>
    Object.fromEntries(
        Object.entries(TASK_STATUS_BADGE).map(([status, spec]) => [status, t(spec.labelKey)]),
    );
const SEVERITY_BADGE: Record<string, StatusBadgeVariant> = {
    INFO: 'neutral', LOW: 'neutral', MEDIUM: 'warning',
    HIGH: 'error', CRITICAL: 'error',
};
const buildTypeLabels = (t: (k: string) => string): Record<string, string> => ({
    AUDIT_FINDING: t('typeLabels.AUDIT_FINDING'), CONTROL_GAP: t('typeLabels.CONTROL_GAP'),
    INCIDENT: t('typeLabels.INCIDENT'), IMPROVEMENT: t('typeLabels.IMPROVEMENT'), TASK: t('typeLabels.TASK'),
});
// TP-6 — provenance labels for the Source column. These come straight
// from filter-defs' `taskSourceLabels`, the same map the Source filter
// uses. This file used to keep its own copy which had drifted (it
// predated RISK_MONITOR), so a risk-monitor task rendered the raw enum
// in the table while its filter chip read the proper label.
const buildSourceLabels = taskSourceLabels;
// Bulk status only offers ACTIVE transitions. Terminal statuses
// (CLOSED / CANCELED) require a per-task resolution note (S8), which
// the bulk bar can't collect — closing is a deliberate single-task
// action via the task detail page. RESOLVED is omitted here because it
// is retired from the PICKERS (CLOSED made it a redundant intermediate)
// — it is still a live status on existing rows, which is why the status
// FILTER continues to offer it.
const buildBulkStatusCbOptions = (statusLabels: Record<string, string>): ComboboxOption[] => ['OPEN', 'TRIAGED', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED'].map(sv => ({ value: sv, label: statusLabels[sv] || sv }));

interface TaskListItem {
    id: string;
    key: string | null;
    title: string;
    type: string;
    severity: string;
    status: string;
    // TP-6 — the work source that raised the task (universal-inbox
    // provenance column). Always present now that taskListSelect
    // returns it.
    source: string;
    dueAt: string | null;
    createdAt: string;
    updatedAt: string;
    /**
     * The FULL shape the server sends (`assignee: { select: { id, name,
     * email } }` in WorkItemRepository's list select), not just the field
     * the table column happens to render.
     *
     * This was declared as `{ name: string } | null`, which was a lie in
     * two directions: `name` is nullable, and `id`/`email` are present.
     * `assigneeOptionsFromTasks` needs both of those, so the call site
     * papered over the mismatch with an `as unknown as ...` cast — which
     * silenced exactly the check that would have caught the select and
     * the interface drifting apart. Declaring the real shape lets the
     * cast go and restores that coupling.
     */
    assignee: { id: string; name: string | null; email: string | null } | null;
    assigneeUserId: string | null;
    // TP-6 — the directly-linked control (FK), for the filter's
    // runtime-derived options.
    /**
     * Also the full server shape (`control: { select: { id, code, name,
     * annexId } }`). `annexId` was missing from this declaration and
     * `name` was marked non-null; the filter helper reads both, and the
     * removed `as unknown as` cast is what let the two drift apart.
     */
    control: {
        id: string;
        code: string | null;
        name: string | null;
        annexId: string | null;
    } | null;
    /**
     * Only populated in the Deleted view — `listDeleted` selects these
     * two extra columns, the live list does not (they would be null on
     * every row). Optional rather than nullable so the live payload,
     * which omits the keys entirely, still satisfies the type.
     */
    deletedAt?: string | null;
    deletedByUserId?: string | null;
}

// TP-7 — server-computed task metrics (getTaskMetrics). The list KPI
// strip reads these fields so the KPI values reflect the WHOLE tenant,
// not just the ≤100 SSR rows in the loaded page. Only the fields the
// KPI cards render are declared here.
export interface TaskListMetrics {
    total: number;
    byStatus: Record<string, number>;
    overdue: number;
    dueIn7d: number;
}

interface TasksClientProps {
    initialTasks: TaskListItem[];
    /**
     * Server-rendered `getTaskMetrics` snapshot — seeds the KPI strip
     * instantly and acts as SWR fallbackData for `/tasks/metrics`
     * (which returns the same usecase, so the two never diverge).
     */
    initialMetrics: TaskListMetrics;
    initialFilters?: Record<string, string>;
    tenantSlug: string;
    appPermissions: {
        tasks: { create: boolean; edit: boolean };
    };
}

/**
 * Client island for tasks — handles filters, bulk selection, optimistic mutations.
 * Data arrives pre-fetched from the server component, hydrated into React Query.
 */
export function TasksClient(props: TasksClientProps) {
    const filterCtx = useFilterContext([], TASK_FILTER_KEYS, {
        serverFilters: props.initialFilters,
    });
    return (
        <FilterProvider value={filterCtx}>
            <TasksPageInner {...props} />
        </FilterProvider>
    );
}

function TasksPageInner({
    initialTasks,
    initialMetrics,
    initialFilters,
    tenantSlug,
    appPermissions,
}: TasksClientProps) {
    const t = useTranslations('tasks');
    // Memoised on `t` so they keep a stable identity across renders —
    // `sortAccessors` below closes over them and needs them in its dep
    // array (see the note there). Rebuilding a fresh object every render
    // would make that memo recompute every render.
    const STATUS_LABELS = useMemo(() => buildStatusLabels(t), [t]);
    const TYPE_LABELS = useMemo(() => buildTypeLabels(t), [t]);
    const SOURCE_LABELS = useMemo(() => buildSourceLabels(t), [t]);
    const SEVERITY_LABELS = useMemo(() => taskSeverityLabels(t), [t]);
    const BULK_STATUS_CB_OPTIONS = buildBulkStatusCbOptions(STATUS_LABELS);
    // TP-6 — the signed-in user, for the "Assigned to me" quick filter.
    const currentUserId = useCurrentUserId();
    const apiUrl = (path: string) => `/api/t/${tenantSlug}${path}`;
    // Stable across renders — it feeds `taskColumns`' dep array, so a bare
    // arrow here would rebuild the table model mid-double-click and kill
    // row navigation (the PoliciesClient regression, #1678).
    const tenantHref = useTenantHref();
    const { mutate: swrMutate } = useSWRConfig();
    const toast = useToast();
    const triggerUndoToast = useToastWithUndo();
    const router = useRouter();
    const prefetchData = usePrefetchTenant();

    // Hydration marker — signals to E2E tests that React event handlers are attached
    const [hydrated, setHydrated] = useState(false);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { setHydrated(true); }, []);

    // Modal-form P2 — create-task modal auto-opens on `?create=1`
    // (the redirect target from `/tasks/new`). Flag stripped after
    // open so back/forward doesn't reopen the modal.
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    // Quick-view side panel — mirrors the Controls page. Single-click a task
    // TITLE (or the row pencil) opens the editable task in a non-modal
    // <AsidePanel> (docked rail ≥xl, Sheet <xl); the table stays visible so
    // clicking another task switches the panel in place. Row double-click
    // still navigates to the full detail page.
    const [selectedTask, setSelectedTask] = useState<TaskListItem | null>(null);
    const searchParams = useSearchParams();
    useCreateQueryParam(() => setIsCreateOpen(true), `/t/${tenantSlug}/tasks`);

    const filterCtx = useFilters();
    const { state, search, hasActive } = filterCtx;

    // TP-6 — "Assigned to me" quick filter. A one-click toggle that
    // pins the `assigneeUserId` filter to the current user (and clears
    // it again). Reuses the existing filter state so it flows through
    // the same query + URL sync as the assignee filter dropdown — no
    // parallel state. Active when the current user's id is the selected
    // assignee.
    const assignedToMe =
        !!currentUserId && (state.assigneeUserId ?? []).includes(currentUserId);
    const toggleAssignedToMe = useCallback(() => {
        if (!currentUserId) return;
        if (assignedToMe) filterCtx.removeAll('assigneeUserId');
        else filterCtx.set('assigneeUserId', currentUserId);
    }, [assignedToMe, currentUserId, filterCtx]);

    // Bulk selection — the <BulkActionBar> owns the action/value form state;
    // this client only tracks which rows are selected.
    const [selected, setSelected] = useState<Set<string>>(new Set());

    // ─── Query: tasks list (hydrated with server data) ───

    const fetchParams = useMemo(
        () => toApiSearchParams(state, { search }),
        [state, search],
    );
    const queryKeyFilters = useMemo(() => {
        const obj: Record<string, string> = {};
        for (const [k, v] of fetchParams) obj[k] = v;
        return obj;
    }, [fetchParams]);

    const serverHadFilters = initialFilters && Object.keys(initialFilters).length > 0;
    const filtersMatchInitial = useSsrFallback({
        queryKeyFilters,
        initialFilters,
        serverHadFilters,
        hasActive,
    });

    // Epic 69 — same SWR-first read pattern as policies / risks /
    // evidence / vendors. Filter-aware key + server-rendered
    // fallbackData (gated against filter divergence). The prior
    // `staleTime: 30_000` setting maps to SWR's
    // `dedupingInterval` — the Epic 69 hook's default is 5 s
    // already, so we bump it here to keep the previous behaviour
    // (dampens revalidation thrash during bulk-select interaction).
    // Deleted ("recycle bin") view. Bulk delete is a SOFT delete, so
    // without this the rows were recoverable in principle and
    // unreachable in practice. `?includeDeleted=true` swaps the backing
    // GET to the deleted-only set, honouring the same toolbar filters.
    const [showDeleted, setShowDeleted] = useState(false);

    const tasksKey = useMemo(() => {
        const params = new URLSearchParams(fetchParams);
        if (showDeleted) params.set('includeDeleted', 'true');
        const qs = params.toString();
        return qs ? `${CACHE_KEYS.tasks.list()}?${qs}` : CACHE_KEYS.tasks.list();
    }, [fetchParams, showDeleted]);

    // PR-9 — API returns `{ rows, truncated }` (mirrors the seven
    // other list-page entities). SSR initial wraps with
    // `truncated: false` because the SSR cap (100) is well below
    // the backfill cap (5000) — the SSR slice never trips truncation
    // by itself.
    const tasksQuery = useTenantSWR<CappedList<TaskListItem>>(tasksKey, {
        // The SSR payload only ever contains LIVE rows, so the deleted
        // view must always fetch — seeding it with `initialTasks` would
        // briefly show active tasks under a "Deleted" heading.
        fallbackData:
            filtersMatchInitial && !showDeleted
                ? { rows: initialTasks, truncated: false }
                : undefined,
        dedupingInterval: 30_000,
    });

    const tasks = tasksQuery.data?.rows ?? [];
    const truncated = tasksQuery.data?.truncated ?? false;
    const loading = tasksQuery.isLoading && !tasksQuery.data;
    // A failed list fetch leaves `rows` empty, which the table would
    // otherwise render as the "no tasks yet" empty state — telling the
    // user their register is empty when it is merely unreachable.
    // Suppressed while stale data is still on screen: SWR keeps serving
    // the last good page during a background refresh, and replacing a
    // readable table with an error card would be a downgrade.
    const listError =
        tasksQuery.error && !tasksQuery.data ? t('list.loadError') : undefined;

    // ─── Sortable headers (parity with the Controls table) ───
    // Clicking a sortable header re-orders the in-memory rows; `sortBy`
    // + `sortOrder` flow into the shared table primitive's
    // `sortableColumns` surface. Sort runs BEFORE the load-more window
    // so the visible slice reflects the chosen order.
    const [sortBy, setSortBy] = useState<string | undefined>(undefined);
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | undefined>(
        undefined,
    );
    // One accessor per sortable column id, each returning the value the
    // matching COLUMN DISPLAYS (not the raw field) so sorting groups
    // same-displayed-value rows. type → TYPE_LABELS label, status →
    // STATUS_LABELS label (both cells render the label, not the raw enum);
    // assignee mirrors its column accessorFn ('—' fallback). Sort still
    // runs BEFORE the load-more window below.
    //
    // The dep array lists the label maps these accessors close over. It
    // used to be empty, which froze them on the FIRST render's maps — so
    // after a locale change the table sorted by the previous language's
    // labels while displaying the new ones.
    const sortAccessors = useMemo<SortAccessors<TaskListItem>>(
        () => ({
            title: (t) => t.title || '',
            type: (t) => TYPE_LABELS[t.type] || t.type,
            severity: (t) => SEVERITY_LABELS[t.severity] || t.severity || '',
            status: (t) => STATUS_LABELS[t.status] || t.status,
            source: (t) => SOURCE_LABELS[t.source] || t.source,
            assignee: (t) => t.assignee?.name || '—',
            dueAt: (t) => t.dueAt || '',
            updatedAt: (t) => t.updatedAt || '',
        }),
        [TYPE_LABELS, SEVERITY_LABELS, STATUS_LABELS, SOURCE_LABELS],
    );
    const sortedTasks = useMemo(
        () => sortRowsByDisplay(tasks, sortAccessors, sortBy, sortOrder),
        [tasks, sortAccessors, sortBy, sortOrder],
    );
    const sortableColumns = useMemo(
        () => ['title', 'type', 'severity', 'status', 'source', 'assignee', 'dueAt', 'updatedAt'],
        [],
    );

    // Progressive disclosure — same org-parity "Load more" affordance
    // as the Controls table. Above the threshold the table renders the
    // first slice and the footer reveals more; below it, all rows show.
    const {
        visibleRows: visibleTasks,
        hasMore: hasMoreTasks,
        loadMore: loadMoreTasks,
    } = useThresholdLoadMore(sortedTasks);
    const tGroup = useTranslations('common.filterGroups');
    const liveFilters = useMemo(
        () =>
            buildTaskFilters(
                tasks,
                (k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [tasks, t, tGroup],
    );
    const filterCards = useMemo(() => filtersToCards(liveFilters), [liveFilters]);
    const { visibleCards, dropdown: filtersDropdown } = useFilterCardVisibility({
        storageKey: 'inflect:filter-vis:tasks',
        cards: filterCards,
    });
    const visibleFilterDefs = useMemo(
        () => selectVisibleFilters(visibleCards, liveFilters),
        [visibleCards, liveFilters],
    );

    // ─── R23-PR-E — KPI definitions for the Tasks page ───
    // Aligned to `status` + `due` filter keys (both filterable
    // server-side). "Due this week" uses the `due=next7d` pseudo-
    // enum the API already accepts.
    type TaskKpiId = 'total' | 'open' | 'overdue' | 'dueWeek';

    // TP-7 — KPI values are SERVER-computed via getTaskMetrics, not
    // counted from the loaded rows. Seeded by the SSR `initialMetrics`
    // prop and revalidated against `/tasks/metrics` (the same usecase),
    // so the KPI strip reflects the whole tenant and can never diverge
    // from the server metrics past the 100-row SSR cap (the old
    // client-row count silently under-reported once the list capped).
    const metricsQuery = useTenantSWR<TaskListMetrics>(
        CACHE_KEYS.tasks.metrics(),
        { fallbackData: initialMetrics, dedupingInterval: 30_000 },
    );
    const metrics = metricsQuery.data ?? initialMetrics;
    const totalTasks = metrics.total;
    const openTasks = metrics.byStatus.OPEN ?? 0;
    const overdueTasks = metrics.overdue;
    const dueWeekTasks = metrics.dueIn7d;

    const taskKpiDefs: ReadonlyArray<KpiFilterDef<TaskKpiId>> = useMemo(
        () => [
            {
                id: 'total',
                apply: (ctx) => ctx.clearAll(),
                isActive: (s) => Object.keys(s).length === 0,
            },
            {
                id: 'open',
                apply: (ctx) => ctx.set('status', 'OPEN'),
                isActive: (s) => (s.status ?? []).includes('OPEN'),
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                id: 'overdue',
                apply: (ctx) => ctx.set('due', 'overdue'),
                isActive: (s) => (s.due ?? []).includes('overdue'),
                clear: (ctx) => ctx.removeAll('due'),
            },
            {
                id: 'dueWeek',
                apply: (ctx) => ctx.set('due', 'next7d'),
                isActive: (s) => (s.due ?? []).includes('next7d'),
                clear: (ctx) => ctx.removeAll('due'),
            },
        ],
        [],
    );
    const { activeKpiId: activeTaskKpi, toggle: toggleTaskKpi } =
        useKpiFilter(taskKpiDefs);

    // Canonical KPI-card sparklines (shared hook). total/open/overdue are
    // always-present snapshot series; dueWeek is a forward-only nullable
    // column — empty until history accrues, never a fake ramp.
    const trendsQuery = useKpiTrends(tenantSlug);
    const taskTrends = useMemo(() => {
        const points = trendsQuery.data?.dataPoints;
        const base = buildKpiSparklines(points, (d) => d.tasksTotal, {
            total: (d) => d.tasksTotal,
            open: (d) => d.tasksOpen,
            overdue: (d) => d.tasksOverdue,
        });
        return {
            ...base,
            dueWeek: buildKpiSparklineNullable(points, (d) => d.tasksDueSoon7d),
        };
    }, [trendsQuery.data]);
    // Distinct sparkline colour per card (canonical allocator).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const sparkColors = useMemo(
        () => assignSparklineVariants(['total', 'open', 'overdue', 'dueWeek']),
        [],
    );


    // ─── Mutation: bulk actions (Epic 69 — useTenantMutation) ────
    //
    // Migrated from React Query's `useMutation` + `onMutate` /
    // `onError` rollback hooks. The hook now handles the lifecycle
    // — `optimisticUpdate` walks the cached task list and patches
    // every selected row with the new field; rollback is automatic
    // on throw via `rollbackOnError: true` (the default). After
    // success the post-mutation revalidation refreshes the
    // current filter view, and `invalidateAllTasks()` below fans
    // out to sibling filter variants so a different filter view
    // doesn't show stale state.
    const invalidateAllTasks = useCallback(() => {
        const tasksUrlPrefix = apiUrl(CACHE_KEYS.tasks.list());
        // The KPI strip reads a SEPARATE key (`/tasks/metrics`), server-
        // computed over the whole register rather than the loaded page.
        // Matching only the list prefix left every counter stale after a
        // bulk op or a quick-panel save — the table repainted, the
        // numbers above it did not.
        const metricsUrl = apiUrl(CACHE_KEYS.tasks.metrics());
        return swrMutate(
            (key) =>
                typeof key === 'string' &&
                (key === tasksUrlPrefix ||
                    key.startsWith(`${tasksUrlPrefix}?`) ||
                    key === metricsUrl ||
                    key.startsWith(`${metricsUrl}?`)),
            undefined,
            { revalidate: true },
        );
    }, [apiUrl, swrMutate]);

    interface BulkVars {
        action: string;
        value: string;
        ids: string[];
        /** Display label for `value` (assignee name) — optimistic UI only. */
        label?: string;
    }

    /**
     * What the `/tasks/bulk/*` routes return. Every route reports
     * per-id outcomes, so a bulk op can partially succeed: ids the
     * caller asked for that the server did not apply come back as
     * `not_found` (filtered out by the tenant scope, or deleted
     * between selection and apply). `count` is the applied total.
     *
     * Not written into the SWR cache — no `populateCache` is supplied,
     * so the hook revalidates instead. This type describes only what
     * `trigger()` resolves to.
     */
    interface BulkResult {
        count: number;
        results: { id: string; status: 'ok' | 'not_found' }[];
    }

    // PR-9 — cache value is `CappedList<TaskListItem>`; preserve the
    // `truncated` flag and only rewrite `rows`. Same shape change as
    // the other six SWR-backed clients (PR-5 corrective).
    const bulkMutation = useTenantMutation<CappedList<TaskListItem>, BulkVars, BulkResult>({
        key: tasksKey,
        mutationFn: async ({ action, value, ids }) => {
            let url = '';
            const body: { taskIds: string[]; assigneeUserId?: string | null; status?: string; dueAt?: string | null } = { taskIds: ids };

            if (action === 'assign') {
                url = apiUrl('/tasks/bulk/assign');
                body.assigneeUserId = value || null;
            } else if (action === 'status') {
                url = apiUrl('/tasks/bulk/status');
                body.status = value;
            } else if (action === 'due') {
                url = apiUrl('/tasks/bulk/due');
                body.dueAt = value || null;
            } else if (action === 'delete') {
                url = apiUrl('/tasks/bulk/delete');
            }

            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                // Surface the server's reason where it gave one (403
                // four-eyes / plan-limit / validation all carry a
                // message); fall back to the generic string so the
                // toast is never blank.
                const detail = await res
                    .json()
                    .then((b) => (typeof b?.error === 'string' ? b.error : null))
                    .catch(() => null);
                throw new Error(detail || t('bulk.failed'));
            }
            return res.json();
        },
        optimisticUpdate: (current, { action, value, ids, label }) => {
            if (action === 'delete') {
                return {
                    // guardrail-ignore: optimistic removal of just-deleted rows from the loaded page, not a server-data re-filter.
                    rows: (current?.rows ?? []).filter((task) => !ids.includes(task.id)),
                    truncated: current?.truncated ?? false,
                };
            }
            const rows = (current?.rows ?? []).map((task) => {
                if (!ids.includes(task.id)) return task;
                if (action === 'status') return { ...task, status: value };
                if (action === 'assign')
                    return {
                        ...task,
                        assigneeUserId: value || null,
                        // Show the picked assignee's name (not the raw user id);
                        // server revalidation reconciles the canonical value.
                        //
                        // `id` is populated, not omitted: the assignee FILTER
                        // builds its options from `assignee.id` and skips any
                        // row without one, so a name-only optimistic object
                        // made the just-assigned person disappear from the
                        // filter for the length of the revalidation. `email`
                        // is genuinely unknown here — the picker only hands
                        // back id + display name — so it is null until the
                        // server answers.
                        assignee: value
                            ? { id: value, name: label || value, email: null }
                            : null,
                    };
                if (action === 'due') return { ...task, dueAt: value || null };
                return task;
            });
            return { rows, truncated: current?.truncated ?? false };
        },
    });

    /**
     * Restore a soft-deleted task from the Deleted view.
     *
     * No undo-toast here, deliberately: restore is the UNDO. Wrapping a
     * recovery action in another 5-second "are you sure" window would be
     * noise. The row is dropped from the deleted list optimistically and
     * put back if the call fails.
     */
    const restoreTask = useCallback(
        async (taskId: string) => {
            const previous = tasksQuery.data;
            void tasksQuery.mutate(
                (cur) => {
                    if (!cur) return cur;
                    // guardrail-ignore: drops the just-restored row from the DELETED list, where it no longer belongs. Not a re-filter of server data for display — the server still owns the list query.
                    const rows = cur.rows.filter((r) => r.id !== taskId);
                    return { ...cur, rows };
                },
                { revalidate: false },
            );
            try {
                const res = await fetch(apiUrl(`/tasks/${taskId}/restore`), {
                    method: 'POST',
                });
                if (!res.ok) {
                    const detail = await res
                        .json()
                        .then((b) => (typeof b?.error === 'string' ? b.error : null))
                        .catch(() => null);
                    throw new Error(detail || t('bulk.restoreFailed'));
                }
                toast.success(t('bulk.restoredToast', { count: 1 }));
                // The restored row rejoins the LIVE list, so refresh both
                // that and the KPI counters, not just the deleted view.
                await invalidateAllTasks();
            } catch (err: unknown) {
                void tasksQuery.mutate(previous, { revalidate: false });
                toast.error(
                    err instanceof Error && err.message
                        ? err.message
                        : t('bulk.restoreFailed'),
                );
            }
        },
        [apiUrl, tasksQuery, toast, t, invalidateAllTasks],
    );

    // BulkActionBar.onApply — fire the bulk mutation; the bar clears its own
    // form once `applying` settles.
    const handleBulkApply = (action: string, value: string, label: string) => {
        if (!action || selected.size === 0) return;
        const requested = Array.from(selected);

        // Bulk delete is a SOFT delete — `Task` is in SOFT_DELETE_MODELS,
        // so the rows are recoverable (and now visible in the Deleted
        // view). That makes the Epic 67 undo-toast the right convention
        // rather than a blocking confirm: drop the rows now, fire the
        // real DELETE after the undo window, restore on Undo or failure.
        // Matches RisksClient / AssetsClient. See docs/destructive-actions.md.
        if (action === 'delete') {
            const idSet = new Set(requested);
            setSelected(new Set());
            void tasksQuery.mutate(
                (cur) => {
                    if (!cur) return cur;
                    // guardrail-ignore: optimistic-delete cache update (drops the just-deleted rows for the undo window), NOT display refiltering — the server still owns the list filter and mutate() restores on Undo/failure.
                    const rows = cur.rows.filter((r) => !idSet.has(r.id));
                    return { ...cur, rows };
                },
                { revalidate: false },
            );
            triggerUndoToast({
                message: t('bulk.deletedToast', { count: requested.length }),
                undoMessage: t('bulk.undo'),
                action: async () => {
                    const res = await fetch(apiUrl('/tasks/bulk/delete'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ taskIds: requested }),
                    });
                    if (!res.ok) throw new Error(t('bulk.failed'));
                    await invalidateAllTasks();
                },
                undoAction: () => {
                    void tasksQuery.mutate();
                },
                onError: () => {
                    toast.error(t('bulk.failed'));
                    void tasksQuery.mutate();
                },
            });
            return;
        }
        bulkMutation
            .trigger({ action, value, label, ids: requested })
            .then((result) => {
                // A bulk op can partially succeed. The optimistic update
                // already repainted EVERY selected row, and the
                // revalidation below silently reverts the ones the server
                // rejected — so without this the user watches rows snap
                // back with no explanation.
                // guardrail-ignore: counts non-ok entries in the bulk RESPONSE payload; nothing to do with filtering the rendered list.
                const missed = (result?.results ?? []).filter((r) => r.status !== 'ok').length;
                if (missed > 0) {
                    toast.warning(
                        t('bulk.partial', {
                            applied: result?.count ?? requested.length - missed,
                            missed,
                        }),
                    );
                }
            })
            .catch((err: unknown) => {
                // Rollback is already applied by the hook — but a silent
                // rollback is indistinguishable from "nothing happened".
                toast.error(
                    err instanceof Error && err.message
                        ? err.message
                        : t('bulk.failed'),
                );
            })
            .finally(() => {
                // Mirror the prior `onSettled` semantics — clear selection +
                // fan out invalidation to sibling filter variants.
                invalidateAllTasks();
                setSelected(new Set());
            });
    };

    // Canonical bulk actions for the Tasks table — Assign (people-picker),
    // Change Status (active transitions), Set Due Date.
    const taskBulkActions: BulkActionDef[] = useMemo(
        () => [
            {
                value: 'assign',
                label: t('bulk.assign'),
                renderInput: ({ value, setValue, setLabel }) => (
                    <UserCombobox
                        tenantSlug={tenantSlug}
                        selectedId={value || null}
                        onChange={(id, m) => {
                            setValue(id ?? '');
                            setLabel(ownerDisplayName(m?.name, m?.email) ?? '');
                        }}
                        forceDropdown
                        matchTriggerWidth
                        placeholder={t('bulk.assignPlaceholder')}
                        className="w-full sm:w-44"
                        id="bulk-value-input"
                    />
                ),
            },
            {
                value: 'status',
                label: t('bulk.changeStatus'),
                canApply: (v) => v !== '',
                renderInput: ({ value, setValue }) => (
                    <Combobox
                        hideSearch
                        id="bulk-value-input"
                        selected={
                            BULK_STATUS_CB_OPTIONS.find((o) => o.value === value) ??
                            null
                        }
                        setSelected={(opt) => setValue(opt?.value ?? '')}
                        options={BULK_STATUS_CB_OPTIONS}
                        placeholder={t('bulk.selectStatus')}
                        matchTriggerWidth
                        buttonProps={{ className: 'text-sm' }}
                    />
                ),
            },
            {
                value: 'due',
                label: t('bulk.setDueDate'),
                renderInput: ({ value, setValue }) => (
                    <DatePicker
                        id="bulk-value-input"
                        className="w-full sm:w-40 text-sm"
                        placeholder={t('bulk.duePlaceholder')}
                        clearable
                        align="start"
                        value={parseYMD(value)}
                        onChange={(next) => setValue(toYMD(next) ?? '')}
                        disabledDays={{ before: startOfUtcDay(new Date()) }}
                        aria-label={t('bulk.dueAria')}
                    />
                ),
            },
            // No `confirm: true` — bulk delete routes through the Epic 67
            // undo-toast in handleBulkApply (soft delete, recoverable),
            // not a blocking confirm dialog.
            { value: 'delete', label: t('bulk.delete') },
        ],
        [tenantSlug, t],
    );

    // R10-PR7 — column-visibility gear.
    const taskColumnList = useMemo(
        () => [
            { id: 'title', label: t('colVis.title') },
            { id: 'type', label: t('colVis.type') },
            { id: 'severity', label: t('colVis.severity') },
            { id: 'status', label: t('colVis.status') },
            { id: 'source', label: t('colVis.source') },
            { id: 'assignee', label: t('colVis.assignee') },
            { id: 'dueAt', label: t('colVis.dueAt') },
            { id: 'updatedAt', label: t('colVis.updated'), defaultVisible: false },
        ],
        [t],
    );
    const {
        columnVisibility,
        setColumnVisibility,
        dropdown: columnsDropdown,
        orderColumns,
    } = useColumnsDropdown({
        storageKey: 'inflect:col-vis:tasks',
        columns: taskColumnList,
    });

    // ── Column definitions ──
    // R12-PR1 — the custom square-checkbox `id: 'select'` column was
    // replaced by DataTable's built-in circular select column.
    // DataTable's selection is wired to the same local `selected` Set
    // via `onRowSelectionChange` so the bulk-action toolbar still
    // reads from `selected.size` / `selected.has(...)`.
    const taskColumns = useMemo(() => {
        const cols: ReturnType<typeof createColumns<TaskListItem>> = [];

        cols.push(
            {
                id: 'title',
                header: t('colHeaders.title'),
                accessorFn: (task) => task.title,
                // R13-PR1 — title cell uses the canonical
                // <TableTitleCell> primitive. The key prefix, Overdue
                // badge, and SLA tooltip that used to live inline here
                // pushed row height past every other page's baseline.
                // Status-tone signals are already in the dedicated
                // Status + Severity columns; key prefix can land in a
                // separate column in a follow-up.
                // Single-click the TITLE opens the quick-view side panel (a
                // <button>, so the table's isClickOnInteractiveChild() skips
                // the row's select/navigate handlers). Row double-click still
                // navigates to the full detail page.
                cell: ({ row }) => (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            setSelectedTask(row.original);
                        }}
                        className="inline-block max-w-full cursor-pointer truncate text-left align-middle rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        id={`task-link-${row.original.id}`}
                        data-testid={`task-title-${row.original.id}`}
                    >
                        <TableTitleCell tintOn="self">{row.original.title}</TableTitleCell>
                    </button>
                ),
            },
            {
                accessorKey: 'type',
                header: t('colHeaders.type'),
                cell: ({ getValue }) => <span className="text-xs text-content-muted">{TYPE_LABELS[getValue<string>()] || getValue<string>()}</span>,
            },
            {
                accessorKey: 'severity',
                header: t('colHeaders.severity'),
                cell: ({ row }) => (
                    <StatusBadge variant={SEVERITY_BADGE[row.original.severity] || 'neutral'} size="sm">
                        {SEVERITY_LABELS[row.original.severity] || row.original.severity}
                    </StatusBadge>
                ),
            },
            {
                accessorKey: 'status',
                header: t('colHeaders.status'),
                cell: ({ row }) => (
                    <StatusBadge variant={taskStatusVariant(row.original.status)} size="sm">
                        {STATUS_LABELS[row.original.status] || row.original.status}
                    </StatusBadge>
                ),
            },
            {
                id: 'source',
                header: t('colHeaders.source'),
                accessorFn: (task) => SOURCE_LABELS[task.source] || task.source,
                cell: ({ row }) => (
                    <StatusBadge variant="neutral" size="sm">
                        {SOURCE_LABELS[row.original.source] || row.original.source}
                    </StatusBadge>
                ),
            },
            {
                id: 'assignee',
                header: t('colHeaders.assignee'),
                accessorFn: (task) => task.assignee?.name || '—',
                cell: ({ getValue }) => <span className="text-xs text-content-muted">{getValue<string>()}</span>,
            },
            {
                id: 'dueAt',
                header: t('colHeaders.dueAt'),
                cell: ({ row }) => (
                    <TimestampTooltip
                        date={row.original.dueAt}
                        className="text-xs text-content-muted"
                    />
                ),
            },
            {
                id: 'updatedAt',
                header: t('colHeaders.updated'),
                cell: ({ row }) => (
                    <TimestampTooltip
                        date={row.original.updatedAt}
                        className="text-xs text-content-muted"
                    />
                ),
            },
        );

        // Quick-edit affordance — opens the row's task in the non-modal
        // quick-view side panel (same target as a title click). Gated on
        // edit permission; `stopPropagation` so it doesn't also fire the
        // row's navigate-to-detail click.
        if (appPermissions.tasks.edit) {
            cols.push({
                id: 'quick-edit',
                header: '',
                enableHiding: false,
                cell: ({ row }) => (
                    <button
                        type="button"
                        aria-label={t('list.editAria')}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`task-quick-edit-${row.original.id}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            setSelectedTask(row.original);
                        }}
                    >
                        <AppIcon name="edit" size={14} />
                    </button>
                ),
            });
        }

        return cols;

    }, [appPermissions.tasks.edit, selected, tasks.length, tenantHref, t]);

    // `orderColumns` returns a NEW array every call (it spreads `columns`),
    // so calling it inline in JSX would hand DataTable a fresh `columns`
    // identity every render even though `taskColumns` above memoises
    // correctly. Memoise the ordered result too.
    const orderedTaskColumns = useMemo(
        () => orderColumns(taskColumns),
        [orderColumns, taskColumns],
    );

    /**
     * Columns for the Deleted view: the live set, plus when/by-whom the
     * row was deleted and a Restore action.
     *
     * Kept separate rather than conditionally appended to `taskColumns`
     * so the live table's column model — and the user's saved column
     * visibility — is untouched by a temporary view switch.
     */
    const deletedTaskColumns = useMemo(
        () => [
            ...orderedTaskColumns,
            {
                id: 'deletedAt',
                header: t('list.colDeletedAt'),
                accessorFn: (row: TaskListItem) => row.deletedAt ?? '',
                cell: ({ row }: { row: { original: TaskListItem } }) => (
                    <TimestampTooltip
                        date={row.original.deletedAt}
                        className="text-xs text-content-muted"
                    />
                ),
            },
            {
                id: 'restore',
                header: '',
                cell: ({ row }: { row: { original: TaskListItem } }) => (
                    <Button
                        variant="secondary"
                        size="sm"
                        id={`restore-task-${row.original.id}`}
                        onClick={(e: React.MouseEvent) => {
                            // The row click handler navigates to the task
                            // detail page; a restore click must not.
                            e.stopPropagation();
                            void restoreTask(row.original.id);
                        }}
                    >
                        {t('list.restore')}
                    </Button>
                ),
            },
        ],
        [orderedTaskColumns, t, restoreTask],
    );

    // Stable table-model identities — see the note on `tenantHref`.
    const getTaskRowId = useCallback((task: TaskListItem) => task.id, []);
    const handleTaskRowClick = useCallback(
        (row: { original: TaskListItem }) =>
            router.push(tenantHref(`/tasks/${row.original.id}`)),
        [router, tenantHref],
    );
    const handleTaskRowPrefetch = useCallback(
        (row: { original: TaskListItem }) => {
            router.prefetch(tenantHref(`/tasks/${row.original.id}`));
            prefetchData(`/tasks/${row.original.id}`);
        },
        [router, tenantHref, prefetchData],
    );

    // Quick-view side panel. Keyed by task id so switching to another task
    // forces a fresh mount → openOnMount re-fires and TaskEditPanel re-seeds
    // from the newly-clicked row (it seeds form state on mount only). The
    // panel re-fetches full detail via GET /tasks/{id}, so a minimal seed
    // object is enough.
    const taskQuickViewAside = selectedTask ? (
        <AsidePanel
            key={`qv-task-${selectedTask.id}`}
            title={t('list.quickViewTitle')}
            surfaceKey="tasks-quickview"
            // A wide dedicated PANEL for the tabbed editor — not the narrow
            // browse/assist rail width.
            defaultWidth={520}
            openOnMount
            onClose={() => setSelectedTask(null)}
        >
            <TaskEditPanel
                tenantSlug={tenantSlug}
                task={{
                    id: selectedTask.id,
                    title: selectedTask.title,
                    status: selectedTask.status,
                    severity: selectedTask.severity,
                    key: selectedTask.key ?? undefined,
                }}
                canWrite={appPermissions.tasks.edit}
                onClose={() => setSelectedTask(null)}
                onSaved={() => void invalidateAllTasks()}
            />
        </AsidePanel>
    ) : null;

    return (
        <ListPageShell className="animate-fadeIn gap-section" data-hydrated={hydrated || undefined}>
            <ListPageShell.Header>
                {/* Header action cluster is intentionally empty — the
                    create button moved into the FilterToolbar leading slot
                    and the Dashboard nav icon into the toolbar actions slot
                    (left of the gears). */}
                <div>
                    <PageBreadcrumbs
                        items={[
                            { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                            { label: t('crumb.tasks') },
                        ]}
                        className="mb-1"
                    />
                    <Heading level={1} className="sr-only">{t('list.srTitle')}</Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('list.description')}
                    </p>
                </div>
            </ListPageShell.Header>

            <ListPageShell.Filters className="space-y-section">
                {/* R23-PR-E — KPI strip. */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                    <KpiFilterCard
                        label={t('kpi.total')}
                        value={totalTasks}
                        sparkline={taskTrends.total}
                        sparklineVariant={sparkColors.total}
                        sparklineDomain={centeredSparklineDomain(taskTrends.total)}
                        onClick={() => toggleTaskKpi('total')}
                        selected={activeTaskKpi === 'total'}
                    />
                    <KpiFilterCard
                        label={t('kpi.open')}
                        value={openTasks}
                        tone="attention"
                        sparkline={taskTrends.open}
                        sparklineVariant={sparkColors.open}
                        sparklineDomain={centeredSparklineDomain(taskTrends.open)}
                        onClick={() => toggleTaskKpi('open')}
                        selected={activeTaskKpi === 'open'}
                    />
                    <KpiFilterCard
                        label={t('kpi.overdue')}
                        value={overdueTasks}
                        tone={overdueTasks > 0 ? 'critical' : 'default'}
                        sparkline={taskTrends.overdue}
                        sparklineVariant={sparkColors.overdue}
                        sparklineDomain={centeredSparklineDomain(taskTrends.overdue)}
                        onClick={() => toggleTaskKpi('overdue')}
                        selected={activeTaskKpi === 'overdue'}
                    />
                    <KpiFilterCard
                        label={t('kpi.dueWeek')}
                        value={dueWeekTasks}
                        tone="attention"
                        sparkline={taskTrends.dueWeek}
                        sparklineVariant={sparkColors.dueWeek}
                        sparklineDomain={centeredSparklineDomain(taskTrends.dueWeek)}
                        onClick={() => toggleTaskKpi('dueWeek')}
                        selected={activeTaskKpi === 'dueWeek'}
                    />
                </div>
                <FilterToolbar
                    filters={visibleFilterDefs}
                    searchId="tasks-search"
                    searchPlaceholder={t('list.searchPlaceholder')}
                    leading={appPermissions.tasks.create ? (
                        <Button
                            variant="primary"
                            icon={<Plus className="-ml-0.5 -mr-2.5" />}
                            onClick={() => setIsCreateOpen(true)}
                            id="new-task-btn"
                        >
                            {t('list.addBtn')}
                        </Button>
                    ) : undefined}
                    actions={
                        <>
                            {/* TP-6 — "Assigned to me" quick filter. Toggles the
                                assigneeUserId filter to the current user.
                                Disabled until `currentUserId` resolves:
                                `toggleAssignedToMe` early-returns without it,
                                so the button rendered fully enabled and did
                                nothing when clicked. */}
                            <Tooltip
                                content={
                                    currentUserId
                                        ? t('list.assignedToMe')
                                        : t('list.assignedToMeUnavailable')
                                }
                            >
                                <Button
                                    variant={assignedToMe ? 'primary' : 'secondary'}
                                    size="sm"
                                    onClick={toggleAssignedToMe}
                                    aria-pressed={assignedToMe}
                                    disabled={!currentUserId}
                                    id="assigned-to-me-toggle"
                                >
                                    {t('list.assignedToMe')}
                                </Button>
                            </Tooltip>
                            {/* TP-7 — the standalone Tasks dashboard was
                                retired (merged into this list: the KPI
                                strip above is now server-computed, and
                                "My Tasks" is the "Assigned to me" toggle).
                                The dashboard nav icon is gone with it. */}
                            {/* Recycle-bin view, folded into the labelled
                                Views menu with every other secondary view.
                                Only offered to users who can edit — restore
                                is admin-gated server-side, so showing it to
                                a reader would advertise an action they'd be
                                refused.

                                The label is stateful where assets/controls
                                are static — it names the destination, so the
                                row still says what the click does. */}
                            <ViewsMenu
                                id="tasks-views-menu"
                                groups={[
                                    {
                                        id: 'views',
                                        items: [
                                            appPermissions.tasks.edit && {
                                                id: 'show-deleted-toggle',
                                                label: showDeleted ? t('list.showLive') : t('list.showDeleted'),
                                                icon: <Trash className="size-4" />,
                                                onSelect: () => {
                                                    setShowDeleted((v) => !v);
                                                    setSelected(new Set());
                                                },
                                                selected: showDeleted,
                                            },
                                        ],
                                    },
                                ]}
                            />
                            {columnsDropdown}
                            {filtersDropdown}
                        </>
                    }
                />
            </ListPageShell.Filters>

            {/* B1 (2026-06-07): the bulk-edit form moved INTO the
                DataTable's header-row selection toolbar (`selectionControls`
                below) — it pops over the column-names row on row-select.
                The toolbar owns the count + Clear; the form keeps only
                action + value + Apply. */}

            <ListPageShell.Body aside={taskQuickViewAside}>
                <TruncationBanner truncated={truncated} />
                <DataTable<TaskListItem>
                    fillBody
                    onReachEnd={hasMoreTasks ? loadMoreTasks : undefined}
                    data={visibleTasks}
                    columns={showDeleted ? deletedTaskColumns : orderedTaskColumns}
                    loading={loading}
                    getRowId={getTaskRowId}
                    sortableColumns={sortableColumns}
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSortChange={({ sortBy: nextBy, sortOrder: nextOrder }) => {
                        setSortBy(nextBy);
                        setSortOrder(nextOrder);
                    }}
                    columnVisibility={columnVisibility}
                    onColumnVisibilityChange={setColumnVisibility}
                    /*
                     * NOT bound to the viewer's permissions.
                     *
                     * The DataTable primitive gives single-click to
                     * SELECTION when selection is on, and to the row action
                     * when it is off (see the onClick/onDoubleClick pair in
                     * table.tsx). Binding `selectionEnabled` to
                     * `tasks.edit` therefore made the row's click model
                     * change with the viewer's ROLE: an editor
                     * single-clicked to select and double-clicked to
                     * navigate, while a reader single-clicked to navigate —
                     * two different interaction models for the same table,
                     * neither discoverable, on a page whose title cell
                     * meanwhile always opened the quick-view.
                     *
                     * Every other list page (risks, controls, assets,
                     * policies, evidence, vendors) omits this prop and takes
                     * the default `true`, so tasks was the lone outlier.
                     * Matching them makes the interaction identical for all
                     * roles. The bulk BAR stays permission-gated below —
                     * selection is a viewing aid; acting on it is not.
                     *
                     * `!showDeleted` remains: the Deleted view has no bulk
                     * actions, so selection there would be an affordance
                     * with nothing behind it.
                     */
                    selectionEnabled={!showDeleted}
                    selectedRows={Object.fromEntries(
                        Array.from(selected).map((id) => [id, true]),
                    )}
                    onRowSelectionChange={(rows) =>
                        setSelected(new Set(rows.map((r) => r.original.id)))
                    }
                    selectionControls={() => (
                        !appPermissions.tasks.edit ? null : <BulkActionBar
                            actions={taskBulkActions}
                            onApply={handleBulkApply}
                            applying={bulkMutation.isMutating}
                            selectedCount={selected.size}
                            entityLabel={t('list.entityLabel')}
                        />
                    )}
                    onRowClick={handleTaskRowClick}
                    onRowPrefetch={handleTaskRowPrefetch}
                    error={listError}
                    emptyState={
                        showDeleted ? (
                            <EmptyState
                                size="sm"
                                variant="no-records"
                                title={t('list.deletedEmptyTitle')}
                                description={t('list.deletedEmptyDesc')}
                            />
                        ) : hasActive ? (
                            <EmptyState
                                size="sm"
                                variant="no-results"
                                title={t('list.filterEmptyTitle')}
                                description={t('list.filterEmptyDesc')}
                                secondaryAction={{
                                    label: t('list.clearFilters'),
                                    onClick: () => filterCtx.clearAll(),
                                }}
                            />
                        ) : (
                            <EmptyState
                                size="sm"
                                variant="no-records"
                                title={t('list.emptyTitle')}
                                description={t('list.emptyDesc')}
                            />
                        )
                    }
                    resourceName={(p) => p ? t('list.entityLabel') : t('list.quickViewTitle')}
                    data-testid="tasks-table"
                    className="hover:bg-bg-muted"
                />
            </ListPageShell.Body>

            {appPermissions.tasks.create && (
                <NewTaskModal open={isCreateOpen} setOpen={setIsCreateOpen} />
            )}
        </ListPageShell>
    );
}
