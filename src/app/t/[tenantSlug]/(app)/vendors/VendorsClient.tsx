'use client';
/* eslint-disable react-hooks/exhaustive-deps -- Various useEffect/useMemo dep arrays in this file deliberately omit identity-unstable callbacks (handlers recreated each render) or use selector functions whose change-detection happens elsewhere. Adding the deps would either trigger unnecessary re-runs OR cause infinite render loops; the proper structural fix is to wrap parent-level callbacks in useCallback. Tracked as follow-up. */
import { TimestampTooltip } from '@/components/ui/timestamp-tooltip';
import { Tooltip } from '@/components/ui/tooltip';
import { AppIcon } from '@/components/icons/AppIcon';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTenantHref } from '@/lib/tenant-context-provider';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { NewVendorModal } from './NewVendorModal';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useKpiTrends, buildKpiSparklines, buildKpiSparklineNullable, centeredSparklineDomain, assignSparklineVariants } from '@/lib/charts/kpi-trends';
import { BulkActionBar, type BulkActionDef } from '@/components/ui/bulk-action-bar';
import { UserCombobox } from '@/components/ui/user-combobox';
import { Combobox } from '@/components/ui/combobox';
import { ownerDisplayName } from '@/lib/owner-display';
import { CACHE_KEYS } from '@/lib/swr-keys';
import type { CappedList } from '@/lib/list-backfill-cap';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { TableTitleCell } from '@/components/ui/table-title-cell';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { DataTable, createColumns, useColumnsDropdown, sortRowsByDisplay, type SortAccessors } from '@/components/ui/table';
import { Package } from 'lucide-react';
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
import { useThresholdLoadMore } from '@/components/ui/hooks';
import { toApiSearchParams } from '@/lib/filters/url-sync';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';
import { buildVendorFilters, VENDOR_FILTER_KEYS } from './filter-defs';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { useKpiFilter, type KpiFilterDef } from '@/components/ui/kpi-filter';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { useTranslations } from 'next-intl';

const STATUS_VARIANT: Record<string, 'success' | 'info' | 'warning' | 'neutral'> = {
    ACTIVE: 'success', ONBOARDING: 'info',
    OFFBOARDING: 'warning', OFFBOARDED: 'neutral',
};
const CRIT_VARIANT: Record<string, 'neutral' | 'warning' | 'error'> = {
    LOW: 'neutral', MEDIUM: 'warning', HIGH: 'error', CRITICAL: 'error',
};

function isOverdue(d: string | null, now: Date | null) {
    if (!d || !now) return false;
    return new Date(d) < now;
}

// listVendors → VendorRepository.list (vendorListSelect). Cells/accessors are
// still explicitly-untyped callbacks (a separate ratchet category); this types
// the query payload + the column factory.
interface VendorRow {
    id: string;
    name: string;
    status: string;
    criticality: string;
    inherentRisk: string | null;
    nextReviewAt: string | null;
    contractRenewalAt: string | null;
    owner: { name: string | null } | null;
    isSubprocessor: boolean;
}

interface VendorsClientProps {
    initialVendors: VendorRow[];
    initialFilters: Record<string, string>;
    tenantSlug: string;
    permissions: {
        canCreate: boolean;
    };
}

/**
 * Client island for vendors — handles filter interactions and table navigation.
 * Data is pre-fetched server-side and passed via props.
 */
export function VendorsClient(props: VendorsClientProps) {
    const filterCtx = useFilterContext([], VENDOR_FILTER_KEYS, {
        serverFilters: props.initialFilters,
    });
    return (
        <FilterProvider value={filterCtx}>
            <VendorsPageInner {...props} />
        </FilterProvider>
    );
}

function VendorsPageInner({ initialVendors, initialFilters, tenantSlug, permissions }: VendorsClientProps) {
    const t = useTranslations('vendors');
    // Bulk-action status options (canonical BulkActionBar), localized.
    const vendorStatusOptions = [
        { value: 'ACTIVE', label: t('statusOption.ACTIVE') },
        { value: 'ONBOARDING', label: t('statusOption.ONBOARDING') },
        { value: 'OFFBOARDING', label: t('statusOption.OFFBOARDING') },
        { value: 'OFFBOARDED', label: t('statusOption.OFFBOARDED') },
    ];
    // Stable across renders — it feeds `vendorColumns`' dep array, so a
    // bare arrow here would rebuild the table model mid-double-click and
    // kill row navigation (the PoliciesClient regression, #1678).
    const tenantHref = useTenantHref();
    const router = useRouter();
    // Null until hydrated — keeps Overdue/Due badges stable across SSR.
    const hydratedNow = useHydratedNow();

    // Stable table-model identities — see the note on `tenantHref`.
    const getVendorRowId = useCallback((v: VendorRow) => v.id, []);
    const handleVendorRowClick = useCallback(
        (row: { original: VendorRow }) =>
            router.push(tenantHref(`/vendors/${row.original.id}`)),
        [router, tenantHref],
    );
    const handleVendorRowPrefetch = useCallback(
        (row: { original: VendorRow }) =>
            router.prefetch(tenantHref(`/vendors/${row.original.id}`)),
        [router, tenantHref],
    );

    // Modal-form P2 — create-vendor modal mounted off the list, auto-
    // opening on `?create=1` (the redirect target from `/vendors/new`).
    // Bookmarks, deep links, and E2E `page.goto('/vendors/new')` all
    // land here. Flag is stripped after open so back/forward doesn't
    // reopen the modal unexpectedly.
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const searchParams = useSearchParams();
    useEffect(() => {
        if (searchParams?.get('create') === '1') {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setIsCreateOpen(true);
            const next = new URLSearchParams(searchParams.toString());
            next.delete('create');
            const qs = next.toString();
            router.replace(
                `/t/${tenantSlug}/vendors${qs ? `?${qs}` : ''}`,
                { scroll: false },
            );
        }
        // First-mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const filterCtx = useFilters();
    const { state, search, hasActive } = filterCtx;

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
        const keys = new Set([...Object.keys(queryKeyFilters), ...Object.keys(initialFilters)]);
        for (const k of keys) {
            if ((queryKeyFilters[k] ?? '') !== (initialFilters[k] ?? '')) return false;
        }
        return true;
    }, [queryKeyFilters, initialFilters, serverHadFilters, hasActive]);

    // Epic 69 — same SWR-first read pattern as policies / risks /
    // evidence. Filter-aware key + server-rendered fallbackData
    // (gated against filter divergence so the hook fires fresh on
    // any URL-driven filter change).
    const vendorsKey = useMemo(() => {
        const qs = fetchParams.toString();
        return qs
            ? `${CACHE_KEYS.vendors.list()}?${qs}`
            : CACHE_KEYS.vendors.list();
    }, [fetchParams]);

    // PR-5 — API returns `{ rows, truncated }`. SSR initial wraps
    // with `truncated: false` (the SSR cap is below the backfill cap).
    const vendorsQuery = useTenantSWR<CappedList<VendorRow>>(vendorsKey, {
        fallbackData: filtersMatchInitial
            ? { rows: initialVendors, truncated: false }
            : undefined,
    });

    const vendors = vendorsQuery.data?.rows ?? [];
    const truncated = vendorsQuery.data?.truncated ?? false;

    // ─── Sortable headers (per-column asc/desc, parity with Controls) ───
    const [sortBy, setSortBy] = useState<string | undefined>(undefined);
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc' | undefined>(
        undefined,
    );
    const sortableColumns = useMemo(
        () => [
            'name', 'status', 'criticality', 'risk',
            'nextReviewAt', 'contractRenewalAt', 'owner',
        ],
        [],
    );
    // Sort accessors return the value each column DISPLAYS, so sorting groups
    // same-displayed-value rows contiguously and can never drift from the
    // rendered cell. `risk` + `owner` point their column `accessorFn` at the
    // SAME function below (see the column defs) to keep the key and the
    // rendered value in lockstep.
    const sortAccessors = useMemo<SortAccessors<VendorRow>>(
        () => ({
            name: (v) => v.name || '',
            status: (v) => v.status || '',
            criticality: (v) => v.criticality || '',
            risk: (v) => v.inherentRisk || '',
            // Cells render the relative form of these timestamps, which is a
            // monotonic transform of the ISO value — sorting on the raw ISO
            // preserves the displayed order and grouping.
            nextReviewAt: (v) => v.nextReviewAt || '',
            contractRenewalAt: (v) => v.contractRenewalAt || '',
            owner: (v) => v.owner?.name || '—',
        }),
        [],
    );
    const sortedVendors = useMemo(
        () => sortRowsByDisplay(vendors, sortAccessors, sortBy, sortOrder),
        [vendors, sortAccessors, sortBy, sortOrder],
    );

    // Load-on-scroll windowing — render the first batch, append more as
    // the user nears the bottom (DataTable onReachEnd sentinel).
    const {
        visibleRows: visibleVendors,
        hasMore: hasMoreVendors,
        loadMore: loadMoreVendors,
    } = useThresholdLoadMore(sortedVendors);

    // ─── Bulk actions (canonical BulkActionBar) ───
    const apiUrl = (path: string) => `/api/t/${tenantSlug}${path}`;
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [bulkApplying, setBulkApplying] = useState(false);
    const handleBulkApply = async (action: string, value: string) => {
        const ids = Array.from(selected);
        if (!action || ids.length === 0) return;
        setBulkApplying(true);
        try {
            const url = action === 'status'
                ? apiUrl('/vendors/bulk/status')
                : action === 'delete'
                    ? apiUrl('/vendors/bulk/delete')
                    : apiUrl('/vendors/bulk/assign');
            const body =
                action === 'status'
                    ? { vendorIds: ids, status: value }
                    : action === 'delete'
                        ? { vendorIds: ids }
                        : { vendorIds: ids, ownerUserId: value || null };
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error('Bulk action failed');
            await vendorsQuery.mutate();
            setSelected(new Set());
        } finally {
            setBulkApplying(false);
        }
    };
    const vendorBulkActions: BulkActionDef[] = useMemo(
        () => [
            {
                value: 'status',
                label: t('bulk.setStatus'),
                canApply: (v) => v !== '',
                renderInput: ({ value, setValue }) => (
                    <Combobox
                        hideSearch
                        id="bulk-value-input"
                        selected={vendorStatusOptions.find((o) => o.value === value) ?? null}
                        setSelected={(opt) => setValue(opt?.value ?? '')}
                        options={vendorStatusOptions}
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
        [tenantSlug, t, vendorStatusOptions],
    );
    const tGroup = useTranslations('common.filterGroups');
    const liveFilters = useMemo(
        () =>
            buildVendorFilters(
                (k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [t, tGroup],
    );
    const filterCards = useMemo(() => filtersToCards(liveFilters), [liveFilters]);
    const { visibleCards, dropdown: filtersDropdown } = useFilterCardVisibility({
        storageKey: 'inflect:filter-vis:vendors',
        cards: filterCards,
    });
    const visibleFilterDefs = useMemo(
        () => selectVisibleFilters(visibleCards, liveFilters),
        [visibleCards, liveFilters],
    );

    // ─── R23-PR-F — KPI definitions for the Vendors page ───
    type VendorKpiId = 'total' | 'active' | 'critical' | 'reviewOverdue';
    // guardrail-ignore: KPI counts across the loaded page, not a refilter.
    const totalVendors = vendors.length;
    // guardrail-ignore: KPI count, not a refilter.
    const activeVendors = vendors.filter((v) => v.status === 'ACTIVE').length;
    // guardrail-ignore: KPI count, not a refilter.
    const criticalVendors = vendors.filter(
        (v) => v.criticality === 'CRITICAL',
    ).length;
    // guardrail-ignore: KPI count, not a refilter.
    const reviewOverdueVendors = vendors.filter((v) =>
        isOverdue(v.nextReviewAt ?? null, hydratedNow),
    ).length;

    // Canonical KPI-card sparklines (shared hook). total + reviewOverdue are
    // always-present series; active + critical are forward-only nullable
    // columns — empty until history accrues, never a fake ramp.
    const trendsQuery = useKpiTrends(tenantSlug);
    const vendorTrends = useMemo(() => {
        const points = trendsQuery.data?.dataPoints;
        const base = buildKpiSparklines(points, (d) => d.vendorsTotal, {
            total: (d) => d.vendorsTotal,
            reviewOverdue: (d) => d.vendorsOverdueReview,
        });
        return {
            ...base,
            active: buildKpiSparklineNullable(points, (d) => d.vendorsActive),
            critical: buildKpiSparklineNullable(points, (d) => d.vendorsCritical),
        };
    }, [trendsQuery.data]);
    // Distinct sparkline colour per card (canonical allocator).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const sparkColors = useMemo(
        () => assignSparklineVariants(['total', 'active', 'critical', 'reviewOverdue']),
        [],
    );
    const vendorKpiDefs: ReadonlyArray<KpiFilterDef<VendorKpiId>> = useMemo(
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
                id: 'critical',
                apply: (ctx) => ctx.set('criticality', 'CRITICAL'),
                isActive: (s) => (s.criticality ?? []).includes('CRITICAL'),
                clear: (ctx) => ctx.removeAll('criticality'),
            },
            {
                id: 'reviewOverdue',
                apply: (ctx) => ctx.set('reviewDue', 'overdue'),
                isActive: (s) => (s.reviewDue ?? []).includes('overdue'),
                clear: (ctx) => ctx.removeAll('reviewDue'),
            },
        ],
        [],
    );
    const { activeKpiId: activeVendorKpi, toggle: toggleVendorKpi } =
        useKpiFilter(vendorKpiDefs);

    // R10-PR7 — column-visibility gear.
    const vendorColumnList = useMemo(
        () => [
            { id: 'name', label: t('columns.name') },
            { id: 'status', label: t('columns.status') },
            { id: 'criticality', label: t('columns.criticality') },
            { id: 'risk', label: t('columns.risk') },
            { id: 'nextReviewAt', label: t('columns.nextReview') },
            { id: 'contractRenewalAt', label: t('columns.contractRenewal'), defaultVisible: false },
            { id: 'owner', label: t('columns.owner') },
        ],
        [t],
    );
    const {
        columnVisibility,
        setColumnVisibility,
        orderColumns,
        dropdown: columnsDropdown,
    } = useColumnsDropdown({
        storageKey: 'inflect:col-vis:vendors',
        columns: vendorColumnList,
    });

    const vendorColumns = useMemo(() => orderColumns(createColumns<VendorRow>([
        {
            accessorKey: 'name',
            header: t('columns.name'),
            // R13-PR1 — Sub-processor badge moved out of the title
            // cell to its own column (visible via the gear). Title
            // cell stays single-element so every row in the product
            // reads at the same height.
            cell: ({ row }) => (
                <TableTitleCell
                    href={tenantHref(`/vendors/${row.original.id}`)}
                    id={`vendor-link-${row.original.id}`}
                >
                    {row.original.name}
                </TableTitleCell>
            ),
        },
        {
            accessorKey: 'status',
            header: t('columns.status'),
            cell: ({ row }) => (
                <StatusBadge variant={STATUS_VARIANT[row.original.status] || 'neutral'} icon={null}>{t('statusOption.' + row.original.status)}</StatusBadge>
            ),
        },
        {
            accessorKey: 'criticality',
            header: t('columns.criticality'),
            cell: ({ row }) => (
                <StatusBadge variant={CRIT_VARIANT[row.original.criticality] || 'neutral'} icon={null}>{t('criticalityLabel.' + row.original.criticality)}</StatusBadge>
            ),
        },
        {
            id: 'risk',
            header: t('columns.risk'),
            accessorFn: sortAccessors.risk,
            cell: ({ row }) => {
                const v = row.original;
                return v.inherentRisk
                    ? <StatusBadge variant={CRIT_VARIANT[v.inherentRisk] || 'neutral'} icon={null}>{t('criticalityLabel.' + v.inherentRisk)}</StatusBadge>
                    : <span>—</span>;
            },
        },
        {
            id: 'nextReviewAt',
            header: t('columns.nextReview'),
            cell: ({ row }) => (
                <span>
                    <TimestampTooltip date={row.original.nextReviewAt} />
                    {isOverdue(row.original.nextReviewAt, hydratedNow) && <span className="ml-1 text-xs text-content-error font-semibold">{t('badge.overdue')}</span>}
                </span>
            ),
        },
        {
            id: 'contractRenewalAt',
            header: t('columns.contractRenewal'),
            cell: ({ row }) => (
                <span>
                    <TimestampTooltip date={row.original.contractRenewalAt} />
                    {isOverdue(row.original.contractRenewalAt, hydratedNow) && <span className="ml-1 text-xs text-content-warning font-semibold">{t('badge.due')}</span>}
                </span>
            ),
        },
        {
            id: 'owner',
            header: t('columns.owner'),
            accessorFn: (v) => v.owner?.name || '—',
            cell: ({ getValue }) => <span className="text-content-muted">{getValue()}</span>,
        },
    ])), [tenantHref, hydratedNow, orderColumns, sortAccessors, t]);

    return (
        <ListPageShell className="animate-fadeIn gap-section">
            <ListPageShell.Header>
                <div className="flex items-center justify-between">
                    <div>
                        <PageBreadcrumbs
                            items={[
                                { label: t('breadcrumbDashboard'), href: tenantHref('/dashboard') },
                                { label: t('title') },
                            ]}
                            className="mb-1"
                        />
                        <Heading level={1} className="sr-only">{t('title')}</Heading>
                        <p className="text-sm text-content-muted mt-1">
                            {t('subtitle')}
                        </p>
                    </div>
                </div>
            </ListPageShell.Header>

            <ListPageShell.Filters className="space-y-section">
                {/* R23-PR-F — KPI strip. */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-default">
                    <KpiFilterCard
                        label={t('kpi.total')}
                        value={totalVendors}
                        sparkline={vendorTrends.total}
                        sparklineVariant={sparkColors.total}
                        sparklineDomain={centeredSparklineDomain(vendorTrends.total)}
                        onClick={() => toggleVendorKpi('total')}
                        selected={activeVendorKpi === 'total'}
                    />
                    <KpiFilterCard
                        label={t('kpi.active')}
                        value={activeVendors}
                        tone="success"
                        sparkline={vendorTrends.active}
                        sparklineVariant={sparkColors.active}
                        sparklineDomain={centeredSparklineDomain(vendorTrends.active)}
                        onClick={() => toggleVendorKpi('active')}
                        selected={activeVendorKpi === 'active'}
                    />
                    <KpiFilterCard
                        label={t('kpi.critical')}
                        value={criticalVendors}
                        tone={criticalVendors > 0 ? 'critical' : 'default'}
                        sparkline={vendorTrends.critical}
                        sparklineVariant={sparkColors.critical}
                        sparklineDomain={centeredSparklineDomain(vendorTrends.critical)}
                        onClick={() => toggleVendorKpi('critical')}
                        selected={activeVendorKpi === 'critical'}
                    />
                    <KpiFilterCard
                        label={t('kpi.reviewOverdue')}
                        value={reviewOverdueVendors}
                        tone={reviewOverdueVendors > 0 ? 'critical' : 'default'}
                        sparkline={vendorTrends.reviewOverdue}
                        sparklineVariant={sparkColors.reviewOverdue}
                        sparklineDomain={centeredSparklineDomain(vendorTrends.reviewOverdue)}
                        onClick={() => toggleVendorKpi('reviewOverdue')}
                        selected={activeVendorKpi === 'reviewOverdue'}
                    />
                </div>
                <FilterToolbar
                    filters={visibleFilterDefs}
                    searchId="vendors-search"
                    searchPlaceholder={t('searchPlaceholder')}
                    leading={
                        permissions.canCreate ? (
                            <Button
                                variant="primary"
                                icon={<Plus className="-ml-0.5 -mr-2.5" />}
                                onClick={() => setIsCreateOpen(true)}
                                id="new-vendor-btn"
                            >
                                {t('createButton')}
                            </Button>
                        ) : undefined
                    }
                    actions={
                        <>
                            <Tooltip content={t('dashboardTooltip')}>
                                <Link href={tenantHref('/vendors/dashboard')} aria-label={t('dashboardTooltip')} className={cn(buttonVariants({ variant: 'secondary', size: 'icon' }))} id="vendor-dashboard-btn">
                                    <AppIcon name="dashboard" size={16} />
                                </Link>
                            </Tooltip>
                            {columnsDropdown}
                            {filtersDropdown}
                        </>
                    }
                />
            </ListPageShell.Filters>

            <ListPageShell.Body>
                <TruncationBanner truncated={truncated} />
                {/* DataTable owns its own bordered/rounded card + fillBody
                    scroll (canonical EntityListPage pattern). A hand-rolled
                    wrapper here added a redundant second border AND `flex-1`,
                    which forced the card to fill the viewport height even with
                    one row — the "broken bounds" giant empty box. */}
                <DataTable
                    fillBody
                        onReachEnd={hasMoreVendors ? loadMoreVendors : undefined}
                        data={visibleVendors}
                        columns={vendorColumns}
                        sortableColumns={sortableColumns}
                        sortBy={sortBy}
                        sortOrder={sortOrder}
                        onSortChange={({ sortBy: nextBy, sortOrder: nextOrder }) => {
                            setSortBy(nextBy);
                            setSortOrder(nextOrder);
                        }}
                        getRowId={getVendorRowId}
                        columnVisibility={columnVisibility}
                        onColumnVisibilityChange={setColumnVisibility}
                        onRowClick={handleVendorRowClick}
                        onRowPrefetch={handleVendorRowPrefetch}
                        selectionEnabled
                        selectedRows={Object.fromEntries(
                            Array.from(selected).map((id) => [id, true]),
                        )}
                        onRowSelectionChange={(rows) =>
                            setSelected(new Set(rows.map((r) => r.original.id)))
                        }
                        selectionControls={() => (
                            <BulkActionBar
                                actions={vendorBulkActions}
                                onApply={handleBulkApply}
                                applying={bulkApplying}
                                selectedCount={selected.size}
                                entityLabel={t('entityLabelPlural')}
                            />
                        )}
                        emptyState={
                            hasActive ? (
                                <EmptyState
                                    size="sm"
                                    variant="no-results"
                                    title={t('empty.noResultsTitle')}
                                    description={t('empty.filtersHint')}
                                    secondaryAction={{
                                        label: t('empty.clearFilters'),
                                        onClick: () => filterCtx.clearAll(),
                                    }}
                                />
                            ) : (
                                <EmptyState
                                    size="sm"
                                    icon={Package}
                                    variant="no-records"
                                    title={t('empty.noRecordsTitle')}
                                    description={t('empty.recordsHint')}
                                />
                            )
                        }
                    resourceName={(p) => p ? t('entityLabelPlural') : t('entityLabel')}
                    data-testid="vendors-table"
                    className="hover:bg-bg-muted"
                />
            </ListPageShell.Body>

            {permissions.canCreate && (
                <NewVendorModal open={isCreateOpen} setOpen={setIsCreateOpen} />
            )}
        </ListPageShell>
    );
}
