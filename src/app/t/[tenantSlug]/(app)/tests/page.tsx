'use client';

import { formatDate } from '@/lib/format-date';
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { DataTable, createColumns, useColumnsDropdown, sortRowsByDisplay, type SortAccessors } from '@/components/ui/table';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { useRouter } from 'next/navigation';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { BulkActionBar, type BulkActionDef } from '@/components/ui/bulk-action-bar';
import { UserCombobox } from '@/components/ui/user-combobox';
import { Combobox } from '@/components/ui/combobox';
import { ownerDisplayName } from '@/lib/owner-display';
import { buttonVariants } from '@/components/ui/button-variants';
import { Button } from '@/components/ui/button';
import { ToggleGroup } from '@/components/ui/toggle-group';
import { Plus } from '@/components/ui/icons/nucleo';
import { NewTestPlanModal } from './_components/NewTestPlanModal';
import { TestsSubNav } from './_components/TestsSubNav';
import {
    buildPlanStatusLabels,
    buildResultLabels,
    PLAN_STATUS_BADGE,
    RESULT_BADGE,
} from './_components/test-plan-labels';
import { FilterProvider, useFilterContext, useFilters, useFilterCardVisibility, filtersToCards, selectVisibleFilters } from '@/components/ui/filter';
import { FilterToolbar } from '@/components/filters/FilterToolbar';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { ErrorState } from '@/components/ui/error-state';
import { useToast } from '@/components/ui/hooks/use-toast';
import { useToastWithUndo } from '@/components/ui/hooks/use-toast-with-undo';
import { Heading } from '@/components/ui/typography';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { useKpiFilter, type KpiFilterDef } from '@/components/ui/kpi-filter';
import { useKpiTrends, buildKpiSparklines, buildKpiSparklineNullable, centeredSparklineDomain, assignSparklineVariants } from '@/lib/charts/kpi-trends';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { AppIcon } from '@/components/icons/AppIcon';
import { Tooltip } from '@/components/ui/tooltip';
import { buildTestFilters, TEST_FILTER_KEYS } from './filter-defs';

/** Bulk-action status options (canonical BulkActionBar). */
const TEST_PLAN_STATUS_OPTIONS = [
    { value: 'ACTIVE', label: 'Active' },
    { value: 'PAUSED', label: 'Paused' },
    { value: 'ARCHIVED', label: 'Archived' },
];

interface TestPlanSummary {
    id: string;
    name: string;
    frequency: string;
    status: string;
    nextDueAt: string | null;
    // PR-Q — the cron-derived clock, so overdue reconciles both signals.
    nextRunAt: string | null;
    controlId: string;
    method: string;
    control: { id: string; name: string; code: string | null };
    owner?: { id: string; name: string | null; email: string } | null;
    _count?: { runs: number; steps: number };
    runs?: Array<{
        id: string;
        result: string | null;
        executedAt: string | null;
        status: string;
    }>;
}

// R3-P1 — an automated integration check (IntegrationExecution) for the
// unified /tests surface's "Automated checks" view.
interface ControlCheck {
    id: string;
    provider: string;
    automationKey: string;
    status: string;
    controlId: string | null;
    executedAt: string | null;
    control: { id: string; name: string; code: string | null } | null;
}

// Humanized check-status labels reuse the R2 controls.health.checkStatus.*
// keys (rendered elsewhere too); unknown statuses fall back to the raw value.
const CHECK_STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    PASSED: 'success', FAILED: 'error', ERROR: 'error',
    NOT_APPLICABLE: 'neutral', PENDING: 'info', RUNNING: 'info',
};

const freqLabels = (t: (key: string) => string): Record<string, string> => ({
    AD_HOC: t('freq.adHoc'), DAILY: t('freq.daily'), WEEKLY: t('freq.weekly'),
    MONTHLY: t('freq.monthly'), QUARTERLY: t('freq.quarterly'), ANNUALLY: t('freq.annually'),
});
// PR-DD — RESULT_BADGE + PLAN_STATUS_BADGE moved to the shared
// `_components/test-plan-labels` module so this register and the plan detail
// view render one vocabulary with one set of tones (they were duplicated).
//
// Audit Coherence S2 — TestPlanStatus values: ACTIVE / PAUSED /
// ARCHIVED. ARCHIVED is the terminal "retired control test" state
// (preserved for historical audit, no new runs). Pre-S2 the UI
// only knew about ACTIVE / PAUSED.

// PR-Q — reconciled due signal: the earliest of the two clocks (nextDueAt from
// frequency, nextRunAt from a cron schedule). Mirrors the server-side
// effectiveDueAt so /tests overdue matches /tests/due and the dashboard.
const effectiveDue = (p: { nextDueAt: string | null; nextRunAt: string | null }): string | null => {
    const ds = [p.nextDueAt, p.nextRunAt].filter((d): d is string => d != null);
    if (ds.length === 0) return null;
    return ds.reduce((a, b) => (new Date(a) <= new Date(b) ? a : b));
};
/**
 * THE definition of an overdue plan, shared with `/tests/due` and the dashboard
 * (`due-planning.ts`): status ACTIVE, and the earliest of the two due clocks is
 * at-or-before now.
 *
 * Both halves used to differ here — this surface counted EVERY status with a
 * strict `<`, while the server counted ACTIVE-only with `<=`. So a paused or
 * archived past-due plan showed as overdue in the list but not in the KPI, and
 * the two disagreed on the exact-equality boundary. ACTIVE-only is the right
 * scope (pausing a plan is a deliberate "stop expecting this"), and `<=`
 * matches the `lte` the authoritative DB queries use.
 */
const isOverdue = (p: { nextDueAt: string | null; nextRunAt: string | null; status: string }) => {
    if (p.status !== 'ACTIVE') return false;
    const d = effectiveDue(p);
    return d ? new Date(d) <= new Date() : false;
};

// R4-P3 #5 — the "last result" of a plan whose newest run is still
// PLANNED/RUNNING has no verdict yet. Reading `runs[0].result` alone rendered
// "No runs" next to a Runs count of 12 and dropped the plan into the NONE
// filter. Distinguish IN_PROGRESS (a run exists, no verdict) from NONE (never
// run). The key drives the badge, the filter bucket, AND the sort order.
type LastResultKey = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'IN_PROGRESS' | 'NONE';
const getLastResultKey = (plan: TestPlanSummary): LastResultKey => {
    const run = plan.runs?.[0];
    if (!run) return 'NONE';
    if (run.result) return run.result as 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    return 'IN_PROGRESS';
};

export default function TestsRollupPage() {
    // Filter state lives in the URL-synced filter context; the page
    // filters its in-memory plan list off `state` + `search`.
    const filterCtx = useFilterContext([], TEST_FILTER_KEYS, {});
    return (
        <FilterProvider value={filterCtx}>
            <TestsRollupContent />
        </FilterProvider>
    );
}

function TestsRollupContent() {
    const t = useTranslations('controlTests');
    const FREQ_LABELS = useMemo(() => freqLabels(t), [t]);
    // PR-R — localized enum→label maps for the plan-status + last-result badges.
    // PR-DD moved the builders into `_components/test-plan-labels` so the plan
    // DETAIL view renders the same vocabulary (it printed raw enums before).
    const PLAN_STATUS_LABELS = useMemo(() => buildPlanStatusLabels(t), [t]);
    const RESULT_LABELS = useMemo(() => buildResultLabels(t), [t]);
    // Displayed "last result" text — the value the column shows, so sort keys
    // group by what the eye sees (R4-P3 #5 + #10), not the raw enum.
    const lastResultLabel = useCallback((p: TestPlanSummary): string => {
        const key = getLastResultKey(p);
        if (key === 'NONE') return t('list.noRuns');
        if (key === 'IN_PROGRESS') return t('list.inProgress');
        return RESULT_LABELS[key] ?? key;
    }, [t, RESULT_LABELS]);
    const tGroup = useTranslations('common.filterGroups');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { tenantSlug } = useTenantContext();
    const router = useRouter();
    const { state, search, hasActive, clearAll } = useFilters();

    // PR-Q — canonical useTenantSWR reads (Epic 69). `mutate` refetches after
    // bulk mutations; the old fetch-on-mount + setState pattern is gone.
    const { data: plansData, isLoading: loading, error: plansError, mutate } = useTenantSWR<TestPlanSummary[]>(CACHE_KEYS.tests.plans());
    const plans = useMemo(() => plansData ?? [], [plansData]);
    const fetchData = mutate;
    const toast = useToast();
    const triggerUndoToast = useToastWithUndo();

    // R3-P1 — segmented view: manual/scheduled Test plans vs Automated checks.
    // "Show me all my control testing" now has ONE place.
    const [view, setView] = useState<'plans' | 'checks'>('plans');
    const [createOpen, setCreateOpen] = useState(false);

    // Lazy-load automated checks the first time the Checks view is opened
    // (null SWR key until then — the conventional lazy-fetch idiom).
    const { data: checksData, isLoading: checksLoading, error: checksError, mutate: mutateChecks } = useTenantSWR<{ checks: ControlCheck[] }>(
        view === 'checks' ? CACHE_KEYS.tests.checks() : null,
    );
    const checks = useMemo(() => checksData?.checks ?? [], [checksData]);

    // ─── Bulk actions (canonical BulkActionBar) ───
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [bulkApplying, setBulkApplying] = useState(false);
    const handleBulkApply = async (action: string, value: string) => {
        const ids = Array.from(selected);
        if (!action || ids.length === 0) return;

        // Bulk-delete is destructive — route it through the Epic 67 undo toast:
        // optimistically drop the rows, defer the real DELETE 5s, and let Undo
        // cancel it before it ever hits the server. (A committed delete is still
        // recoverable via the bulk/restore endpoint.)
        if (action === 'delete') {
            const idSet = new Set(ids);
            setSelected(new Set());
            mutate(
                (cur) =>
                    // guardrail-ignore: optimistic-delete cache update (drop the just-deleted rows during the Epic 67 undo window) — NOT display refiltering; mutate() restores on Undo/failure.
                    cur ? cur.filter((p) => !idSet.has(p.id)) : cur,
                { revalidate: false },
            );
            triggerUndoToast({
                message: t('list.bulkDeletedToast', { count: ids.length }),
                undoMessage: t('list.bulkDeleteUndo'),
                action: async () => {
                    const res = await fetch(apiUrl('/tests/plans/bulk/delete'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ planIds: ids }),
                    });
                    if (!res.ok) throw new Error('bulk delete failed');
                    await mutate();
                },
                undoAction: () => { mutate(); },
                onError: () => { toast.error(t('list.bulkFailed')); mutate(); },
            });
            return;
        }

        setBulkApplying(true);
        try {
            const url = action === 'status'
                ? apiUrl('/tests/plans/bulk/status')
                : apiUrl('/tests/plans/bulk/assign');
            const body =
                action === 'status'
                    ? { planIds: ids, status: value }
                    : { planIds: ids, ownerUserId: value || null };
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(t('list.bulkFailed'));
            await fetchData();
            setSelected(new Set());
            toast.success(t('list.bulkApplied'));
        } catch {
            toast.error(t('list.bulkFailed'));
        } finally {
            setBulkApplying(false);
        }
    };
    const testBulkActions: BulkActionDef[] = useMemo(
        () => [
            {
                value: 'status',
                label: t('bulk.setStatus'),
                canApply: (v) => v !== '',
                renderInput: ({ value, setValue }) => (
                    <Combobox
                        hideSearch
                        id="bulk-value-input"
                        selected={TEST_PLAN_STATUS_OPTIONS.find((o) => o.value === value) ?? null}
                        setSelected={(opt) => setValue(opt?.value ?? '')}
                        options={TEST_PLAN_STATUS_OPTIONS}
                        placeholder={t('bulk.selectStatus')}
                        matchTriggerWidth
                        buttonProps={{ className: 'text-sm' }}
                    />
                ),
            },
            {
                value: 'assign',
                label: t('bulk.assignOwner'),
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
                        placeholder={t('bulk.ownerPlaceholder')}
                        className="w-full sm:w-44"
                        id="bulk-value-input"
                    />
                ),
            },
            { value: 'delete', label: t('bulk.delete'), confirm: true },
        ],
        [t, tenantSlug],
    );

    // ── Column-visibility gear (Epic 52/R10) ──
    const {
        columnVisibility,
        setColumnVisibility,
        orderColumns,
        dropdown: columnsDropdown,
    } = useColumnsDropdown({
        storageKey: 'inflect:col-vis:tests',
        columns: [
            { id: 'name', label: t('colHeaders.name') },
            { id: 'status', label: t('colHeaders.status') },
            { id: 'control', label: t('colHeaders.control') },
            { id: 'method', label: t('colHeaders.method') },
            { id: 'frequency', label: t('colHeaders.frequency') },
            { id: 'nextDue', label: t('colHeaders.nextDue') },
            { id: 'lastResult', label: t('colHeaders.lastResult') },
            { id: 'runs', label: t('colHeaders.runs') },
        ],
    });

    const liveFilters = useMemo(
        () =>
            buildTestFilters(
                (k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [t, tGroup],
    );

    const filterCards = useMemo(() => filtersToCards(liveFilters), [liveFilters]);
    const { visibleCards, dropdown: filtersDropdown } = useFilterCardVisibility({
        storageKey: 'inflect:filter-vis:tests',
        cards: filterCards,
    });
    const visibleFilterDefs = useMemo(
        () => selectVisibleFilters(visibleCards, liveFilters),
        [visibleCards, liveFilters],
    );

    // ── Client-side filtering from the filter context ──
    const filteredPlans = useMemo(() => {
        const statusSel = state.status ?? [];
        const resultSel = state.result ?? [];
        const freqSel = state.frequency ?? [];
        const dueSel = state.due ?? [];
        const q = search.trim().toLowerCase();
        return plans.filter((p) => {
            if (statusSel.length && !statusSel.includes(p.status)) return false;
            const result = getLastResultKey(p);
            if (resultSel.length && !resultSel.includes(result)) return false;
            if (freqSel.length && !freqSel.includes(p.frequency)) return false;
            if (dueSel.includes('overdue') && !isOverdue(p)) {
                return false;
            }
            if (q && !p.name.toLowerCase().includes(q)) return false;
            return true;
        });
    }, [plans, state, search]);

    // ─── Sortable headers (per-column asc/desc, parity with Controls) ───
    const [sortBy, setSortBy] = useState<string | undefined>(undefined);
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | undefined>(
        undefined,
    );
    const sortableColumns = useMemo(
        () => ['name', 'status', 'control', 'frequency', 'nextDue', 'lastResult', 'runs'],
        [],
    );
    // Each accessor returns the value its column DISPLAYS, so sorting groups
    // same-displayed-value rows contiguously (case-insensitive via the shared
    // helper's locale compare).
    const sortAccessors = useMemo<SortAccessors<TestPlanSummary>>(
        () => ({
            name: (p) => p.name ?? '',
            // #10 — sort by the localized label the cell renders, not the raw
            // enum, so alphabetical order matches what the user sees.
            status: (p) => PLAN_STATUS_LABELS[p.status] ?? p.status ?? '',
            control: (p) => p.control?.code || p.control?.name || '',
            frequency: (p) => FREQ_LABELS[p.frequency] || p.frequency || '',
            nextDue: (p) => effectiveDue(p) ?? '',
            lastResult: (p) => lastResultLabel(p),
            runs: (p) => p._count?.runs ?? 0,
        }),
        [FREQ_LABELS, PLAN_STATUS_LABELS, lastResultLabel],
    );
    const sortedPlans = useMemo(
        () => sortRowsByDisplay(filteredPlans, sortAccessors, sortBy, sortOrder),
        [filteredPlans, sortAccessors, sortBy, sortOrder],
    );

    // KPI-card counts — total + the three TestPlanStatus buckets. These power
    // the clickable KpiFilterCard row (each toggles the table's status filter).
    const totalPlans = plans.length;
    const activePlans = plans.filter((p) => p.status === 'ACTIVE').length;
    const pausedPlans = plans.filter((p) => p.status === 'PAUSED').length;
    const archivedPlans = plans.filter((p) => p.status === 'ARCHIVED').length;

    // Canonical KPI-card sparklines (shared hook). total is an always-present
    // series; active/paused/archived are forward-only nullable columns (PR3) —
    // empty until ~2 days of snapshot history accrue, never a fake ramp.
    const trendsQuery = useKpiTrends(tenantSlug);
    const testTrends = useMemo(() => {
        const points = trendsQuery.data?.dataPoints;
        const base = buildKpiSparklines(points, (d) => d.testPlansTotal, {
            total: (d) => d.testPlansTotal,
        });
        return {
            ...base,
            active: buildKpiSparklineNullable(points, (d) => d.testPlansActive),
            paused: buildKpiSparklineNullable(points, (d) => d.testPlansPaused),
            archived: buildKpiSparklineNullable(points, (d) => d.testPlansArchived),
        };
    }, [trendsQuery.data]);
    // Distinct sparkline colour per card (canonical allocator).
    const sparkColors = useMemo(
        () => assignSparklineVariants(['total', 'active', 'paused', 'archived']),
        [],
    );

    // Clickable-KPI → table-filter wiring. "Total" clears all filters; each
    // status card toggles the `status` filter to its bucket (mutually
    // exclusive — the hook clears sibling status keys before applying).
    type TestKpiId = 'total' | 'active' | 'paused' | 'archived';
    const testKpiDefs: ReadonlyArray<KpiFilterDef<TestKpiId>> = useMemo(
        () => [
            {
                id: 'total',
                apply: (ctx) => ctx.clearAll(),
                isActive: (s) => Object.keys(s).length === 0,
            },
            {
                id: 'active',
                apply: (ctx) => ctx.set('status', 'ACTIVE'),
                isActive: (s) => (s.status ?? []).includes('ACTIVE'),
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                id: 'paused',
                apply: (ctx) => ctx.set('status', 'PAUSED'),
                isActive: (s) => (s.status ?? []).includes('PAUSED'),
                clear: (ctx) => ctx.removeAll('status'),
            },
            {
                id: 'archived',
                apply: (ctx) => ctx.set('status', 'ARCHIVED'),
                isActive: (s) => (s.status ?? []).includes('ARCHIVED'),
                clear: (ctx) => ctx.removeAll('status'),
            },
        ],
        [],
    );
    const { activeKpiId: activeTestKpi, toggle: toggleTestKpi } =
        useKpiFilter(testKpiDefs);

    const planColumns = useMemo(
        () =>
            orderColumns(createColumns<TestPlanSummary>([
                {
                    id: 'name', header: t('colHeaders.name'), accessorKey: 'name',
                    cell: ({ row }) => (
                        <Link
                            href={tenantHref(`/tests/plans/${row.original.id}`)}
                            className="text-content-emphasis font-medium hover:text-[var(--brand-default)] transition"
                        >
                            {row.original.name}
                        </Link>
                    ),
                },
                {
                    id: 'status', header: t('colHeaders.status'), accessorKey: 'status',
                    cell: ({ row }) => (
                        <StatusBadge variant={PLAN_STATUS_BADGE[row.original.status] ?? 'neutral'} size="sm">
                            {PLAN_STATUS_LABELS[row.original.status] ?? row.original.status}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'control', header: t('colHeaders.control'), accessorFn: (p) => p.control?.code || p.control?.name || '—',
                    cell: ({ row }) => (
                        <Link href={tenantHref(`/controls/${row.original.control.id}`)} className="text-content-muted hover:text-content-emphasis text-xs transition">
                            {row.original.control?.code || row.original.control?.name || '—'}
                        </Link>
                    ),
                },
                {
                    // R3-P1 — method column so manual vs automated plans are
                    // distinguishable on the canonical list (the inherited
                    // panel already shows one; this must not be less informative).
                    id: 'method', header: t('colHeaders.method'),
                    accessorFn: (p) => p.method,
                    cell: ({ row }) => {
                        const m = row.original.method;
                        return (
                            <StatusBadge variant={m === 'AUTOMATED' ? 'info' : 'neutral'} size="sm">
                                {t(`method.${m}` as Parameters<typeof t>[0])}
                            </StatusBadge>
                        );
                    },
                },
                { id: 'frequency', header: t('colHeaders.frequency'), accessorFn: (p) => FREQ_LABELS[p.frequency] || p.frequency },
                {
                    id: 'nextDue', header: t('colHeaders.nextDue'), accessorKey: 'nextDueAt',
                    cell: ({ row }) => {
                        const due = effectiveDue(row.original);
                        return due ? (
                            <span className={isOverdue(row.original) ? 'text-content-error font-semibold' : 'text-content-muted'}>
                                {formatDate(due)}
                            </span>
                        ) : <span className="text-content-subtle">—</span>;
                    },
                },
                {
                    id: 'lastResult', header: t('colHeaders.lastResult'),
                    accessorFn: (p) => lastResultLabel(p),
                    cell: ({ row }) => {
                        const key = getLastResultKey(row.original);
                        if (key === 'NONE') return <span className="text-content-subtle text-xs">{t('list.noRuns')}</span>;
                        // In-progress is a transient state, not a verdict — keep it
                        // quiet inline text so the result badge stays the one loud
                        // signal in the row (badge-density discipline).
                        if (key === 'IN_PROGRESS') return <span className="text-content-info text-xs">{t('list.inProgress')}</span>;
                        return <StatusBadge variant={RESULT_BADGE[key] || 'neutral'} size="sm">{RESULT_LABELS[key] ?? key}</StatusBadge>;
                    },
                },
                {
                    id: 'runs', header: t('colHeaders.runs'),
                    accessorFn: (p) => p._count?.runs ?? 0,
                    cell: ({ getValue }) => <span className="text-content-subtle">{getValue() as number}</span>,
                },
            ])),
        [t, tenantHref, orderColumns, FREQ_LABELS, PLAN_STATUS_LABELS, RESULT_LABELS],
    );

    // R3-P1 — columns for the Automated checks view.
    const checkColumns = useMemo(
        () =>
            createColumns<ControlCheck>([
                {
                    id: 'check', header: t('checksList.colCheck'), accessorFn: (c) => c.automationKey,
                    cell: ({ row }) => (
                        <span className="text-xs font-mono text-content-default">{row.original.automationKey}</span>
                    ),
                },
                {
                    id: 'control', header: t('colHeaders.control'),
                    accessorFn: (c) => c.control?.code || c.control?.name || '',
                    cell: ({ row }) => row.original.control ? (
                        <Link href={tenantHref(`/controls/${row.original.control.id}`)} className="text-content-muted hover:text-content-emphasis text-xs transition">
                            {row.original.control.code || row.original.control.name}
                        </Link>
                    ) : <span className="text-content-subtle text-xs">—</span>,
                },
                {
                    id: 'provider', header: t('checksList.colProvider'), accessorFn: (c) => c.provider,
                    cell: ({ row }) => <span className="text-xs text-content-muted">{row.original.provider}</span>,
                },
                {
                    id: 'status', header: t('colHeaders.status'), accessorFn: (c) => c.status,
                    cell: ({ row }) => (
                        <StatusBadge variant={CHECK_STATUS_BADGE[row.original.status] ?? 'neutral'} size="sm">
                            {t(`checkStatus.${row.original.status}` as Parameters<typeof t>[0])}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'executedAt', header: t('checksList.colExecuted'), accessorKey: 'executedAt',
                    cell: ({ row }) => row.original.executedAt ? (
                        <span className="text-content-muted text-xs">{formatDate(row.original.executedAt)}</span>
                    ) : <span className="text-content-subtle">—</span>,
                },
            ]),
        [t, tenantHref],
    );

    if (loading) return <div className="p-12 text-center text-content-subtle animate-pulse">{t('list.loading')}</div>;

    return (
        <ListPageShell className="animate-fadeIn gap-section">
            <ListPageShell.Header>
                <PageBreadcrumbs
                    items={[
                        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                        { label: t('crumb.tests') },
                    ]}
                    className="mb-1"
                />
                {/* R3-P3 — the single sub-nav spine across the three test surfaces. */}
                <TestsSubNav active="tests" className="mb-3" />
                <div className="flex items-start justify-between gap-default">
                    <div>
                        <Heading level={1} id="tests-page-title">{t('list.title')}</Heading>
                        {/* R3-P1 — the tests-vs-checks distinction, explained at the
                            GLOBAL level (not only inline on a control's two tabs). */}
                        <p className="text-sm text-content-muted mt-1">{t('unified.explanation')}</p>
                        <div className="mt-3">
                            <ToggleGroup
                                ariaLabel={t('unified.viewAria')}
                                selected={view}
                                selectAction={(v) => {
                                    const next = v as 'plans' | 'checks';
                                    setView(next);
                                    // R4-P3 #9 — the plan filters aren't rendered on the
                                    // Checks view, so leaving chips set would strand them
                                    // invisible + inert (and silently re-applied on return).
                                    // Clear them when leaving Plans.
                                    if (next === 'checks') clearAll();
                                }}
                                options={[
                                    { value: 'plans', label: t('unified.tabPlans') },
                                    { value: 'checks', label: t('unified.tabChecks') },
                                ]}
                            />
                        </div>
                    </div>
                    {view === 'plans' && (
                        <Button variant="primary" icon={<Plus />} onClick={() => setCreateOpen(true)} id="tests-create-plan-btn">
                            {t('unified.testPlanNoun')}
                        </Button>
                    )}
                </div>
            </ListPageShell.Header>

            <ListPageShell.Filters className="space-y-section">
                {view === 'plans' && (<>
                {/* KPI strip — clickable cards filter the table by status. */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                    <KpiFilterCard
                        label={t('kpi.total')}
                        value={totalPlans}
                        sparkline={testTrends.total}
                        sparklineVariant={sparkColors.total}
                        sparklineDomain={centeredSparklineDomain(testTrends.total)}
                        onClick={() => toggleTestKpi('total')}
                        selected={activeTestKpi === 'total'}
                    />
                    <KpiFilterCard
                        label={t('kpi.active')}
                        value={activePlans}
                        tone="success"
                        sparkline={testTrends.active}
                        sparklineVariant={sparkColors.active}
                        sparklineDomain={centeredSparklineDomain(testTrends.active)}
                        onClick={() => toggleTestKpi('active')}
                        selected={activeTestKpi === 'active'}
                    />
                    <KpiFilterCard
                        label={t('kpi.paused')}
                        value={pausedPlans}
                        tone={pausedPlans > 0 ? 'attention' : 'default'}
                        sparkline={testTrends.paused}
                        sparklineVariant={sparkColors.paused}
                        sparklineDomain={centeredSparklineDomain(testTrends.paused)}
                        onClick={() => toggleTestKpi('paused')}
                        selected={activeTestKpi === 'paused'}
                    />
                    <KpiFilterCard
                        label={t('kpi.archived')}
                        value={archivedPlans}
                        sparkline={testTrends.archived}
                        sparklineVariant={sparkColors.archived}
                        sparklineDomain={centeredSparklineDomain(testTrends.archived)}
                        onClick={() => toggleTestKpi('archived')}
                        selected={activeTestKpi === 'archived'}
                    />
                </div>

                {/* Filter bar (Status / Last Result / Frequency / Due) +
                    live content search + column-visibility gear. Replaces
                    the old All/Overdue/Failed toggle blade. */}
                <FilterToolbar
                    filters={visibleFilterDefs}
                    searchId="tests-search"
                    searchPlaceholder={t('list.searchPlaceholder')}
                    actions={
                        <>
                            {/* R3-P3 — due/dashboard cross-links now live in the
                                shared TestsSubNav; only the cross-section
                                access-reviews jump stays here. */}
                            <Tooltip content={t('nav.accessReviews')}>
                                <Link href={tenantHref('/access-reviews')} aria-label={t('nav.accessReviews')} className={buttonVariants({ variant: 'secondary', size: 'icon' })} id="tests-uar-btn">
                                    <AppIcon name="userCheck" size={16} />
                                </Link>
                            </Tooltip>
                            {columnsDropdown}{filtersDropdown}
                        </>
                    }
                />
                </>)}
            </ListPageShell.Filters>

            <ListPageShell.Body>
                {/* Error + retry — the header/sub-nav above stay mounted so the
                    user keeps their bearings and can jump elsewhere. A failed
                    fetch must not read as "no data". */}
                {((view === 'plans' && plansError) || (view === 'checks' && checksError)) ? (
                    <ErrorState
                        title={t('list.loadErrorTitle')}
                        description={t('list.loadErrorBody')}
                        onRetry={() => { if (view === 'checks') { mutateChecks(); } else { mutate(); } }}
                        retryLabel={t('list.retry')}
                        data-testid="tests-load-error"
                    />
                ) : view === 'checks' ? (
                    <DataTable
                        fillBody
                        data={checks}
                        columns={checkColumns}
                        getRowId={(c) => c.id}
                        loading={checksLoading}
                        selectionEnabled={false}
                        emptyState={t('checksList.empty')}
                        resourceName={(p) => p ? t('checksList.entityPlural') : t('checksList.entitySingular')}
                        data-testid="tests-checks-table"
                        onRowClick={(row) =>
                            row.original.control && router.push(tenantHref(`/controls/${row.original.control.id}`))
                        }
                    />
                ) : (
                <DataTable
                    fillBody
                    data={sortedPlans}
                    columns={planColumns}
                    sortableColumns={sortableColumns}
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSortChange={({ sortBy: nextBy, sortOrder: nextOrder }) => {
                        setSortBy(nextBy);
                        setSortOrder(nextOrder);
                    }}
                    getRowId={(p) => p.id}
                    columnVisibility={columnVisibility}
                    onColumnVisibilityChange={setColumnVisibility}
                    selectionEnabled
                    selectedRows={Object.fromEntries(
                        Array.from(selected).map((id) => [id, true]),
                    )}
                    onRowSelectionChange={(rows) =>
                        setSelected(new Set(rows.map((r) => r.original.id)))
                    }
                    selectionControls={() => (
                        <BulkActionBar
                            actions={testBulkActions}
                            onApply={handleBulkApply}
                            applying={bulkApplying}
                            selectedCount={selected.size}
                            entityLabel={t('list.entityPlural')}
                        />
                    )}
                    emptyState={
                        hasActive
                            ? t('list.emptyFiltered')
                            : t('list.emptyNone')
                    }
                    resourceName={(p) => p ? t('list.entityPlural') : t('list.entitySingular')}
                    data-testid="tests-rollup-table"
                    // Row hover band + brand left-band (and double-click →
                    // open the plan), matching every other list table.
                    onRowClick={(row) =>
                        router.push(
                            tenantHref(`/tests/plans/${row.original.id}`),
                        )
                    }
                />
                )}
            </ListPageShell.Body>

            <NewTestPlanModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={fetchData} />
        </ListPageShell>
    );
}
