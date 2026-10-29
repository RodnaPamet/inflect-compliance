'use client';
import { useCallback, useMemo, useState } from 'react';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { useRouter } from 'next/navigation';
import { useGuardedPush } from '@/lib/nav/use-guarded-push';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { usePublishDisplayedOrder } from '@/lib/hooks/use-entity-list-ids';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { Button } from '@/components/ui/button';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';
import { createColumns } from '@/components/ui/table';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { EmptyState } from '@/components/ui/empty-state';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { unwrapCappedList, type CappedList } from '@/lib/list-backfill-cap';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import {
    FilterProvider,
    useFilterContext,
    useFilters,
} from '@/components/ui/filter';
import { formatDate } from '@inflect/ui/lib/format-date';
import {
    buildIncidentFilterDefs,
    buildSeverityLabels,
    buildPhaseLabels,
    INCIDENT_FILTER_KEYS,
    type IncidentSeverityKey,
    type IncidentPhaseKey,
} from './filter-defs';
import { NewIncidentModal } from './NewIncidentModal';

export interface IncidentNotificationLite {
    kind: 'EARLY_WARNING_24H' | 'DETAILED_72H' | 'FINAL_1MONTH';
    dueAt: string;
    status: 'PENDING' | 'DUE' | 'OVERDUE' | 'SUBMITTED' | 'NOT_REQUIRED';
}

export interface IncidentRow {
    id: string;
    reference: string;
    title: string;
    severity: IncidentSeverityKey;
    phase: IncidentPhaseKey;
    incidentType: string;
    detectedAt: string;
    reportable: boolean;
    ownerUserId: string | null;
    createdAt: string;
    notifications: IncidentNotificationLite[];
}

/**
 * The register's KPI cards, counted server-side over EVERY incident
 * (`IncidentRepository.kpiCounts`) — not derived from the list rows, which
 * stop at the backfill cap.
 */
export interface IncidentKpiCounts {
    total: number;
    open: number;
    reportable: number;
    deadlinesDueOrOverdue: number;
}

/** Shape of GET /api/t/:slug/incidents. */
type IncidentListResponse = CappedList<IncidentRow> & { kpiCounts?: IncidentKpiCounts };

interface IncidentsClientProps {
    initialIncidents: IncidentRow[];
    /** Server aggregates for the first paint; omitted → counted from the rows. */
    initialKpiCounts?: IncidentKpiCounts;
    tenantSlug: string;
    canManage: boolean;
}

const SEVERITY_TONE: Record<string, StatusBadgeVariant> = {
    LOW: 'neutral',
    MEDIUM: 'info',
    HIGH: 'warning',
    CRITICAL: 'error',
};

const DEADLINE_TONE: Record<string, StatusBadgeVariant> = {
    PENDING: 'neutral',
    DUE: 'warning',
    OVERDUE: 'error',
    SUBMITTED: 'success',
    NOT_REQUIRED: 'neutral',
};

/** The earliest still-open (non-submitted, non-NA) notification. */
export function nextOpenDeadline(
    notifications: IncidentNotificationLite[],
): IncidentNotificationLite | null {
    const open = notifications
        .filter((n) => n.status !== 'SUBMITTED' && n.status !== 'NOT_REQUIRED')
        .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
    return open[0] ?? null;
}

export function IncidentsClient(props: IncidentsClientProps) {
    const t = useTranslations('incidents');
    const tGroup = useTranslations('common.filterGroups');
    const defs = useMemo(
        () =>
            buildIncidentFilterDefs(
                (k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [t, tGroup],
    );
    const filterCtx = useFilterContext([...defs.filters], [
        ...INCIDENT_FILTER_KEYS,
    ]);
    return (
        <FilterProvider value={filterCtx}>
            <IncidentsPageInner {...props} />
        </FilterProvider>
    );
}

function IncidentsPageInner({
    initialIncidents,
    initialKpiCounts,
    tenantSlug,
    canManage,
}: IncidentsClientProps) {
    const t = useTranslations('incidents');
    const tGroup = useTranslations('common.filterGroups');
    const severityLabels = useMemo(
        () => buildSeverityLabels((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1])),
        [t],
    );
    const phaseLabels = useMemo(
        () => buildPhaseLabels((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1])),
        [t],
    );
    const incidentDefs = useMemo(
        () =>
            buildIncidentFilterDefs(
                (k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]),
                (k) => tGroup(k as Parameters<typeof tGroup>[0]),
            ),
        [t, tGroup],
    );
    const router = useRouter();
    const guardedPush = useGuardedPush();
    const tenantHref = useTenantHref();
    const [isCreateOpen, setIsCreateOpen] = useState(false);

    // GET /incidents answers `{ rows, truncated, kpiCounts }` (PR-5 backfill
    // cap). The SSR page holds the first SSR_PAGE_LIMIT rows, so its seed is
    // not "truncated" — the revalidated response says whether the cap fired.
    // A bare array (an older cached response) still reads, through
    // `unwrapCappedList`.
    const query = useTenantSWR<IncidentListResponse | IncidentRow[]>(CACHE_KEYS.incidents.list(), {
        fallbackData: { rows: initialIncidents, truncated: false, kpiCounts: initialKpiCounts },
    });
    const incidents = query.data ? unwrapCappedList(query.data) : initialIncidents;
    const listResponse = query.data && !Array.isArray(query.data) ? query.data : undefined;
    const truncated = listResponse?.truncated ?? false;
    const { state, search, hasActive, clearAll } = useFilters();

    // Client-side filtering (the API returns the bounded per-tenant list).
    const filtered = useMemo(() => {
        const q = (search ?? '').trim().toLowerCase();
        const sev = state.severity ?? [];
        const ph = state.phase ?? [];
        const rep = state.reportable ?? [];
        return incidents.filter((i) => {
            if (q && !`${i.reference} ${i.title}`.toLowerCase().includes(q)) return false;
            if (sev.length > 0 && !sev.includes(i.severity)) return false;
            if (ph.length > 0 && !ph.includes(i.phase)) return false;
            if (rep.length > 0) {
                const want = rep.includes('yes');
                const notWant = rep.includes('no');
                if (want && !notWant && !i.reportable) return false;
                if (notWant && !want && i.reportable) return false;
            }
            return true;
        });
    }, [incidents, state, search]);
    // #107 — publish the rendered order so the detail page's prev/next
    // stepper walks what the user saw. Incidents filter entirely client-side,
    // so the list cache holds rows the table is not showing.
    usePublishDisplayedOrder(CACHE_KEYS.incidents.list(), filtered);

    // KPI summary — open incidents, reportable, deadlines due/overdue.
    // Counted by the server over every incident; the rows-derived fallback
    // only serves a response that carries no counts.
    const kpi = listResponse?.kpiCounts ?? {
        total: incidents.length,
        open: incidents.filter((i) => i.phase !== 'CLOSED').length,
        reportable: incidents.filter((i) => i.reportable).length,
        deadlinesDueOrOverdue: incidents.filter((i) =>
            i.notifications.some((n) => n.status === 'DUE' || n.status === 'OVERDUE'),
        ).length,
    };
    const openCount = kpi.open;
    const reportableCount = kpi.reportable;
    const dueOrOverdueCount = kpi.deadlinesDueOrOverdue;

    const columns = useMemo(
        () =>
            createColumns<IncidentRow>([
                {
                    accessorKey: 'reference',
                    header: t('colHeaders.reference'),
                    cell: ({ getValue }) => (
                        <span className="font-medium text-content-emphasis">
                            {String(getValue() ?? '')}
                        </span>
                    ),
                },
                { accessorKey: 'title', header: t('colHeaders.title') },
                {
                    accessorKey: 'severity',
                    header: t('colHeaders.severity'),
                    cell: ({ getValue }) => {
                        const s = String(getValue() ?? '');
                        return (
                            <StatusBadge variant={SEVERITY_TONE[s] ?? 'neutral'}>
                                {severityLabels[s] ?? s}
                            </StatusBadge>
                        );
                    },
                },
                {
                    accessorKey: 'phase',
                    header: t('colHeaders.phase'),
                    cell: ({ getValue }) => {
                        const p = String(getValue() ?? '');
                        return (
                            <StatusBadge variant="neutral">
                                {phaseLabels[p] ?? p}
                            </StatusBadge>
                        );
                    },
                },
                {
                    id: 'nextDeadline',
                    header: t('colHeaders.nextDeadline'),
                    cell: ({ row }) => {
                        const next = nextOpenDeadline(row.original.notifications);
                        if (!next) return <span className="text-content-muted">—</span>;
                        // The badge names the state in words as well as by
                        // colour — "24h · Overdue", not a red "24h".
                        const kind = t(`kindShort.${next.kind}` as Parameters<typeof t>[0]);
                        const state = t(`deadlineStatus.${next.status}` as Parameters<typeof t>[0]);
                        return (
                            <span className="inline-flex items-center gap-tight">
                                <StatusBadge variant={DEADLINE_TONE[next.status] ?? 'neutral'}>
                                    {`${kind} · ${state}`}
                                </StatusBadge>
                                <span className="text-xs text-content-muted">
                                    {formatDate(next.dueAt)}
                                </span>
                            </span>
                        );
                    },
                },
                {
                    accessorKey: 'ownerUserId',
                    header: t('colHeaders.owner'),
                    cell: ({ getValue }) => (
                        <span className="text-content-muted">
                            {getValue() ? t('assigned') : '—'}
                        </span>
                    ),
                },
            ]),
        [t, severityLabels, phaseLabels],
    );

    // Stable table-model identities — a fresh identity here rebuilds
    // the table model mid-double-click and kills row navigation (#1678).
    const getIncidentRowId = useCallback((row: IncidentRow) => row.id, []);
    const handleIncidentRowClick = useCallback(
        (row: { original: IncidentRow }) =>
            guardedPush(tenantHref(`/incidents/${row.original.id}`)),
        [guardedPush, tenantHref],
    );

    return (
        <EntityListPage<IncidentRow>
            header={{
                back: { smart: true },
                breadcrumbs: [
                    { label: t('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: t('crumb.internalAudits'), href: `/t/${tenantSlug}/audits` },
                    { label: t('crumb.incidents') },
                ],
                title: t('title'),
                count: t('count', { count: kpi.total }),
                description: t('description'),
                actions: canManage ? (
                    <Button
                        variant="primary"
                        icon={<Plus />}
                        onClick={() => setIsCreateOpen(true)}
                        id="new-incident-btn"
                    >
                        {t('addBtn')}
                    </Button>
                ) : undefined,
            }}
            kpis={
                <div className="grid grid-cols-1 gap-default sm:grid-cols-3">
                    <KpiFilterCard label={t('kpi.open')} value={openCount} />
                    <KpiFilterCard label={t('kpi.reportable')} value={reportableCount} />
                    <KpiFilterCard
                        label={t('kpi.deadlines')}
                        value={dueOrOverdueCount}
                        tone={dueOrOverdueCount > 0 ? 'critical' : 'default'}
                    />
                </div>
            }
            // The list stops at the backfill cap; say so rather than show a
            // partial register as if it were whole.
            banner={<TruncationBanner truncated={truncated} />}
            filters={{
                defs: [...incidentDefs.filters],
                searchId: 'incidents-search',
                searchPlaceholder: t('searchPlaceholder'),
            }}
            table={{
                data: filtered,
                columns,
                loading: query.isLoading && !query.data,
                getRowId: getIncidentRowId,
                onRowClick: handleIncidentRowClick,
                // A search or filter that matches nothing is not an empty
                // register — say so, and offer the way back.
                emptyState: hasActive ? (
                    <EmptyState
                        size="sm"
                        variant="no-results"
                        title={t('emptyFilteredTitle')}
                        description={t('emptyFilteredDesc')}
                        secondaryAction={{
                            label: t('emptyClearFilters'),
                            onClick: clearAll,
                        }}
                    />
                ) : (
                    <EmptyState
                        size="sm"
                        variant="no-records"
                        title={t('emptyTitle')}
                        description={t('emptyDesc')}
                    />
                ),
            }}
        >
            {isCreateOpen && (
                <NewIncidentModal
                    open={isCreateOpen}
                    onClose={() => setIsCreateOpen(false)}
                    tenantSlug={tenantSlug}
                    onCreated={async (id) => {
                        setIsCreateOpen(false);
                        await query.mutate();
                        router.push(`/t/${tenantSlug}/incidents/${id}`);
                    }}
                />
            )}
        </EntityListPage>
    );
}
