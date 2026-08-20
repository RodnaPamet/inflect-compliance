'use client';

/**
 * Business Continuity register — Business Impact Analyses ordered by their
 * derived recovery priority ("what comes back first"). A subpage of the
 * Internal Audit area (reached via the "Business Continuity" pill beside
 * Incidents). Built on EntityListPage + FilterToolbar + DataTable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from '@/components/ui/icons/nucleo/plus';
import { LifeRing } from '@/components/ui/icons/nucleo/life-ring';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { useThresholdLoadMore } from '@/components/ui/hooks';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDate } from '@/lib/format-date';
import { buildBiaFilters, BIA_FILTER_KEYS } from './filter-defs';
import { NewBiaModal } from './NewBiaModal';

export interface BiaRow {
    id: string;
    name: string;
    criticality: string;
    rtoHours: number | null;
    rpoHours: number | null;
    mtpdHours: number | null;
    reviewedAt: string | null;
    processNode: { id: string; label: string } | null;
    ownerUser: { id: string; name: string | null; email: string } | null;
    recovery: { rank: number; rationale: string } | null;
}

interface Props {
    initialRows: BiaRow[];
    tenantSlug: string;
    canWrite: boolean;
}

const CRITICALITY_VARIANT: Record<string, StatusBadgeVariant> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'info',
};

const REVIEW_STALE_DAYS = 365;

function isReviewOverdue(reviewedAt: string | null): boolean {
    if (!reviewedAt) return true;
    return Date.now() - new Date(reviewedAt).getTime() > REVIEW_STALE_DAYS * 86_400_000;
}

const hrs = (v: number | null) => (v != null ? `${v}h` : '—');

export function BusinessContinuityClient(props: Props) {
    const tx = useTranslations('audits');
    const tGroup = useTranslations('common.filterGroups');
    const filters = useMemo(
        () =>
            buildBiaFilters(
                (k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [tx, tGroup],
    );
    const filterCtx = useFilterContext(filters, [...BIA_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <BusinessContinuityInner {...props} />
        </FilterProvider>
    );
}

function BusinessContinuityInner({ initialRows, tenantSlug, canWrite }: Props) {
    const tx = useTranslations('audits');
    const tGroup = useTranslations('common.filterGroups');
    const filterDefs = useMemo(
        () =>
            buildBiaFilters(
                (k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [tx, tGroup],
    );
    const router = useRouter();
    const tenantHref = useTenantHref();
    const searchParams = useSearchParams();
    const { state, hasActive } = useFilters();
    const [showNew, setShowNew] = useState(false);
    // Canvas "Add BIA" deep-link — ?newProcessNodeId=<id> auto-opens the
    // create modal prefilled with the process node.
    const [prefillNode, setPrefillNode] = useState<string | undefined>(undefined);
    useEffect(() => {
        const p = searchParams?.get('newProcessNodeId');
        if (p) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setPrefillNode(p);
            setShowNew(true);
            const next = new URLSearchParams(searchParams.toString());
            next.delete('newProcessNodeId');
            const qs = next.toString();
            router.replace(`/t/${tenantSlug}/audits/business-continuity${qs ? `?${qs}` : ''}`, { scroll: false });
        }
        // First-mount only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const rows = useMemo(() => {
        const crits = (state.criticality ?? []) as string[];
        return initialRows.filter((r) => (crits.length ? crits.includes(r.criticality) : true));
    }, [initialRows, state.criticality]);
    // Render a window, not the whole backfill-capped set. Without this the
    // page mounts every row it fetched and never virtualizes — the default
    // threshold is 1000, so a tenant can sit under it and still re-render
    // hundreds of rows on every filter or sort change. `onReachEnd` extends
    // the window on scroll, the same contract the other list pages use.
    const {
        visibleRows: visibleBiaRows,
        hasMore: hasMoreBiaRows,
        loadMore: loadMoreBiaRows,
    } = useThresholdLoadMore(rows);


    const summary = useMemo(() => {
        const critical = initialRows.filter((r) => r.criticality === 'CRITICAL').length;
        const overdue = initialRows.filter((r) => isReviewOverdue(r.reviewedAt)).length;
        return { total: initialRows.length, critical, overdue };
    }, [initialRows]);

    const columns = useMemo(
        () =>
            createColumns<BiaRow>([
                {
                    id: 'recovery',
                    header: '#',
                    accessorFn: (r) => r.recovery?.rank ?? 999,
                    cell: ({ row }) => (
                        <span className="tabular-nums font-medium text-content-default">
                            {row.original.recovery ? row.original.recovery.rank : '—'}
                        </span>
                    ),
                },
                {
                    id: 'name',
                    header: tx('bia.colProcess'),
                    accessorFn: (r) => r.name,
                    cell: ({ row }) => (
                        <div className="min-w-0" data-testid={`bia-row-${row.original.id}`}>
                            <div className="truncate font-medium text-content-default">{row.original.name}</div>
                            {row.original.processNode && (
                                <div className="truncate text-xs text-content-subtle">{row.original.processNode.label}</div>
                            )}
                        </div>
                    ),
                },
                {
                    id: 'criticality',
                    header: tx('bia.colCriticality'),
                    accessorFn: (r) => r.criticality,
                    cell: ({ row }) => (
                        <StatusBadge variant={CRITICALITY_VARIANT[row.original.criticality] ?? 'neutral'}>
                            {row.original.criticality}
                        </StatusBadge>
                    ),
                },
                { id: 'rto', header: 'RTO', accessorFn: (r) => r.rtoHours ?? -1, cell: ({ row }) => <span className="tabular-nums text-content-muted">{hrs(row.original.rtoHours)}</span> },
                { id: 'rpo', header: 'RPO', accessorFn: (r) => r.rpoHours ?? -1, cell: ({ row }) => <span className="tabular-nums text-content-muted">{hrs(row.original.rpoHours)}</span> },
                { id: 'mtpd', header: 'MTPD', accessorFn: (r) => r.mtpdHours ?? -1, cell: ({ row }) => <span className="tabular-nums text-content-muted">{hrs(row.original.mtpdHours)}</span> },
                {
                    id: 'owner',
                    header: tx('bia.colOwner'),
                    accessorFn: (r) => r.ownerUser?.name ?? r.ownerUser?.email ?? '',
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {row.original.ownerUser ? row.original.ownerUser.name ?? row.original.ownerUser.email : '—'}
                        </span>
                    ),
                },
                {
                    id: 'reviewed',
                    header: tx('bia.colReviewed'),
                    accessorFn: (r) => r.reviewedAt ?? '',
                    cell: ({ row }) =>
                        isReviewOverdue(row.original.reviewedAt) ? (
                            <StatusBadge variant="warning">{tx('bia.reviewOverdue')}</StatusBadge>
                        ) : (
                            <span className="text-content-muted">{formatDate(row.original.reviewedAt!)}</span>
                        ),
                },
            ]),
        [tx],
    );

    // Stable table-model identities — a fresh identity here rebuilds
    // the table model mid-double-click and kills row navigation (#1678).
    const getBiaRowId = useCallback((r: BiaRow) => r.id, []);
    const handleBiaRowClick = useCallback(
        (row: { original: BiaRow }) =>
            router.push(tenantHref(`/audits/business-continuity/${row.original.id}`)),
        [router, tenantHref],
    );

    return (
        <>
            <EntityListPage<BiaRow>
                header={{
                    back: { smart: true },
                    breadcrumbs: [
                        { label: tx('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                        { label: tx('crumb.internalAudit'), href: `/t/${tenantSlug}/audits` },
                        { label: tx('crumb.businessContinuity') },
                    ],
                    title: (
                        <>
                            <LifeRing className="inline-block mr-2 h-5 w-5 align-text-bottom" />
                            {tx('crumb.businessContinuity')}
                        </>
                    ),
                    description: tx('bia.description', { total: summary.total, critical: summary.critical, overdue: summary.overdue }),
                    actions: canWrite ? (
                        <Button variant="primary" icon={<Plus />} onClick={() => { setPrefillNode(undefined); setShowNew(true); }}>
                            {tx('bia.addBia')}
                        </Button>
                    ) : undefined,
                }}
                filters={{ defs: filterDefs }}
                table={{
                    data: visibleBiaRows,
                    onReachEnd: hasMoreBiaRows ? loadMoreBiaRows : undefined,
                    columns,
                    getRowId: getBiaRowId,
                    onRowClick: handleBiaRowClick,
                    resourceName: (plural) => (plural ? tx('bia.resourceAnalyses') : tx('bia.resourceAnalysis')),
                    emptyState: (
                        <EmptyState
                            icon={LifeRing}
                            title={hasActive ? tx('bia.emptyMatchTitle') : tx('bia.emptyTitle')}
                            description={hasActive ? tx('bia.emptyMatchDesc') : tx('bia.emptyDesc')}
                        />
                    ),
                }}
            />
            {showNew && (
                <NewBiaModal
                    tenantSlug={tenantSlug}
                    processNodeId={prefillNode}
                    onClose={() => {
                        setShowNew(false);
                        setPrefillNode(undefined);
                    }}
                    onCreated={(id) => {
                        setShowNew(false);
                        setPrefillNode(undefined);
                        router.push(`/t/${tenantSlug}/audits/business-continuity/${id}`);
                    }}
                />
            )}
        </>
    );
}
