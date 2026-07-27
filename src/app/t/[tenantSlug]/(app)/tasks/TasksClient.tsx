'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/* eslint-disable react-hooks/exhaustive-deps -- Various useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers/derived arrays recreated each render). The proper structural fix is wrapping parent-level callbacks in useCallback. Tracked as follow-up; existing per-line eslint-disable-next-line markers preserved. */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from '@/components/ui/icons/nucleo';
import { NewTaskModal } from './NewTaskModal';
import { AsidePanel } from '@/components/ui/aside-panel';
import { TaskEditPanel } from '@/app/t/[tenantSlug]/(app)/controls/TaskEditPanel';
import { AppIcon } from '@/components/icons/AppIcon';
import { useSWRConfig } from 'swr';
import { useTenantSWR, usePrefetchTenant } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { useThresholdLoadMore, useToast } from '@/components/ui/hooks';
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
// TP-6 — provenance labels for the Source column. Mirrors the filter's
// `taskSourceLabels` (filter-defs) but keyed off the same
// `filterEnums.source.*` copy so the column + filter never drift.
// Source labels come from filter-defs — the same map the Source filter
// uses. This file used to keep its own copy, which had drifted (it
// predated RISK_MONITOR), so a risk-monitor task rendered the raw enum
// in the table while its filter chip read the proper label.
const buildSourceLabels = taskSourceLabels;
// Bulk status only offers ACTIVE transitions. Terminal statuses
// (CLOSED / CANCELED) require a per-task resolution note (S8), which
// the bulk bar can't collect — closing is a deliberate single-task
// action via the task detail page. RESOLVED is retired everywhere.
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
    assignee: { name: string } | null;
    assigneeUserId: string | null;
    // TP-6 — the directly-linked control (FK), for the filter's
    // runtime-derived options.
    control: { id: string; code: string | null; name: string } | null;
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
    useEffect(() => {
        if (searchParams?.get('create') === '1') {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setIsCreateOpen(true);
            const next = new URLSearchParams(searchParams.toString());
            next.delete('create');
            const qs = next.toString();
            router.replace(
                `/t/${tenantSlug}/tasks${qs ? `?${qs}` : ''}`,
                { scroll: false },
            );
        }
        // First-mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
    const filtersMatchInitial = useMemo(() => {
        if (!serverHadFilters) return !hasActive;
        const keys = new Set([...Object.keys(queryKeyFilters), ...Object.keys(initialFilters!)]);
        for (const k of keys) {
            if ((queryKeyFilters[k] ?? '') !== (initialFilters![k] ?? '')) return false;
        }
        return true;
    }, [queryKeyFilters, initialFilters, serverHadFilters, hasActive]);

    // Epic 69 — same SWR-first read pattern as policies / risks /
    // evidence / vendors. Filter-aware key + server-rendered
    // fallbackData (gated against filter divergence). The prior
    // `staleTime: 30_000` setting maps to SWR's
    // `dedupingInterval` — the Epic 69 hook's default is 5 s
    // already, so we bump it here to keep the previous behaviour
    // (dampens revalidation thrash during bulk-select interaction).
    const tasksKey = useMemo(() => {
        const qs = fetchParams.toString();
        return qs ? `${CACHE_KEYS.tasks.list()}?${qs}` : CACHE_KEYS.tasks.list();
    }, [fetchParams]);

    // PR-9 — API returns `{ rows, truncated }` (mirrors the seven
    // other list-page entities). SSR initial wraps with
    // `truncated: false` because the SSR cap (100) is well below
    // the backfill cap (5000) — the SSR slice never trips truncation
    // by itself.
    const tasksQuery = useTenantSWR<CappedList<TaskListItem>>(tasksKey, {
        fallbackData: filtersMatchInitial
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
                tasks as unknown as Parameters<typeof buildTaskFilters>[0],
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
                        assignee: value ? { name: label || value } : null,
                    };
                if (action === 'due') return { ...task, dueAt: value || null };
                return task;
            });
            return { rows, truncated: current?.truncated ?? false };
        },
    });

    // BulkActionBar.onApply — fire the bulk mutation; the bar clears its own
    // form once `applying` settles.
    const handleBulkApply = (action: string, value: string, label: string) => {
        if (!action || selected.size === 0) return;
        const requested = Array.from(selected);
        bulkMutation
            .trigger({ action, value, label, ids: requested })
            .then((result) => {
                // A bulk op can partially succeed. The optimistic update
                // already repainted EVERY selected row, and the
                // revalidation below silently reverts the ones the server
                // rejected — so without this the user watches rows snap
                // back with no explanation.
                const missed = (result?.results ?? []).filter(
                    (r) => r.status !== 'ok',
                ).length;
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
            { value: 'delete', label: t('bulk.delete'), confirm: true },
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
                    columns={orderedTaskColumns}
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
                    selectionEnabled={appPermissions.tasks.edit}
                    selectedRows={Object.fromEntries(
                        Array.from(selected).map((id) => [id, true]),
                    )}
                    onRowSelectionChange={(rows) =>
                        setSelected(new Set(rows.map((r) => r.original.id)))
                    }
                    selectionControls={() => (
                        <BulkActionBar
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
                        hasActive ? (
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
