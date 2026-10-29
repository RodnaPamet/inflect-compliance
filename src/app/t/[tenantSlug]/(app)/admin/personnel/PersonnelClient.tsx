'use client';

/**
 * Personnel roster (PR-4) — the people-layer hub. Lists the employees an HRIS
 * sync has brought in, with employment-status filtering and a name / email
 * search. Built on EntityListPage. The page only reads.
 *
 * THE FILTER AND THE SEARCH RUN ON THE SERVER (#4470). The roster read is
 * capped at PERSONNEL_ROSTER_CAP, so filtering the rows already delivered
 * could only hide some of them: "Terminated" would miss every leaver past the
 * cap. With no filter the page shows the server-rendered roster; any filter or
 * search asks `GET /personnel` for the matching rows instead.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { Users } from '@inflect/ui/components/ui/icons/nucleo/users';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { PERSONNEL_ROSTER_CAP } from '@/lib/personnel-roster';
import { buildPersonnelFilters, EMPLOYEE_SOURCE_KEYS, EMPLOYEE_STATUS_KEYS, PERSONNEL_FILTER_KEYS } from './filter-defs';

export interface EmployeeRow {
    id: string;
    fullName: string;
    workEmail: string;
    status: string;
    department: string | null;
    jobTitle: string | null;
    managerEmployeeId: string | null;
    source: string;
}

/** The roster read's wire shape: `listEmployees` / `GET /personnel`. */
export interface EmployeeRoster {
    employees: EmployeeRow[];
    truncated: boolean;
    total: number;
}

interface Props {
    initialRoster: EmployeeRoster;
    /** The status filter and search in the address, for the first render. */
    initialFilters: Record<string, string>;
    tenantSlug: string;
}

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    ACTIVE: 'success',
    ONBOARDING: 'info',
    OFFBOARDING: 'warning',
    TERMINATED: 'error',
    LEAVE: 'neutral',
};

const KNOWN_STATUSES: ReadonlySet<string> = new Set(EMPLOYEE_STATUS_KEYS);
const KNOWN_SOURCES: ReadonlySet<string> = new Set(EMPLOYEE_SOURCE_KEYS);

export function PersonnelClient(props: Props) {
    const t = useTranslations('personnel');
    const tGroup = useTranslations('common.filterGroups');
    const filters = useMemo(
        () => buildPersonnelFilters((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const filterCtx = useFilterContext(filters, [...PERSONNEL_FILTER_KEYS], { serverFilters: props.initialFilters });
    return (
        <FilterProvider value={filterCtx}>
            <PersonnelInner {...props} />
        </FilterProvider>
    );
}

function PersonnelInner({ initialRoster }: Props) {
    const t = useTranslations('personnel');
    const tGroup = useTranslations('common.filterGroups');
    const filterDefs = useMemo(
        () => buildPersonnelFilters((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const { state, search } = useFilters();

    // The API path for the current filter, or null when nothing narrows the
    // roster and the server-rendered read already answers.
    const statuses = state.status;
    const rosterPath = useMemo(() => {
        const qs = new URLSearchParams();
        const term = search.trim();
        if (term) qs.set('q', term);
        for (const s of statuses ?? []) qs.append('status', s);
        const query = qs.toString();
        return query ? `/personnel?${query}` : null;
    }, [search, statuses]);
    const filtering = rosterPath !== null;

    const filtered = useTenantSWR<EmployeeRoster>(rosterPath);
    const roster = filtering ? filtered.data : initialRoster;
    const rows = roster?.employees ?? [];

    const columns = useMemo(
        () =>
            createColumns<EmployeeRow>([
                {
                    id: 'name',
                    header: t('colName'),
                    accessorFn: (r) => r.fullName,
                    cell: ({ row }) => (
                        <div className="min-w-0">
                            <div className="truncate font-medium text-content-default">{row.original.fullName}</div>
                            <div className="truncate text-content-subtle">{row.original.workEmail}</div>
                        </div>
                    ),
                },
                {
                    id: 'status',
                    header: t('colStatus'),
                    accessorFn: (r) => r.status,
                    cell: ({ row }) => {
                        const status = row.original.status;
                        return (
                            <StatusBadge variant={STATUS_VARIANT[status] ?? 'neutral'}>
                                {KNOWN_STATUSES.has(status) ? t(`filterEnums.status.${status}` as Parameters<typeof t>[0]) : status}
                            </StatusBadge>
                        );
                    },
                },
                { id: 'department', header: t('colDepartment'), accessorFn: (r) => r.department ?? '', cell: ({ row }) => <span className="text-content-muted">{row.original.department ?? '—'}</span> },
                { id: 'jobTitle', header: t('colTitle'), accessorFn: (r) => r.jobTitle ?? '', cell: ({ row }) => <span className="text-content-muted">{row.original.jobTitle ?? '—'}</span> },
                {
                    id: 'source',
                    header: t('colSource'),
                    accessorFn: (r) => r.source,
                    cell: ({ row }) => {
                        const source = row.original.source;
                        return (
                            <span className="text-content-subtle">
                                {KNOWN_SOURCES.has(source) ? t(`sourceLabels.${source}` as Parameters<typeof t>[0]) : source}
                            </span>
                        );
                    },
                },
            ]),
        [t],
    );

    return (
        <EntityListPage<EmployeeRow>
            header={{
                title: (
                    <>
                        <Users className="inline-block mr-2 h-5 w-5 align-text-bottom" />
                        {t('title')}
                    </>
                ),
                // The whole roster, counted exactly — not the rows on screen,
                // which stop at the cap.
                description: t('description', { total: initialRoster.total }),
                back: { smart: true },
            }}
            filters={{
                defs: filterDefs,
                searchId: 'personnel-search',
                searchPlaceholder: t('searchPlaceholder'),
            }}
            banner={<TruncationBanner truncated={roster?.truncated ?? false} cap={PERSONNEL_ROSTER_CAP} />}
            table={{
                data: rows,
                columns,
                loading: filtering && !filtered.data && !filtered.error,
                error: filtering && filtered.error ? t('loadError') : undefined,
                getRowId: (r) => r.id,
                // Read-only rows: no bulk action exists, so no select column.
                selectionEnabled: false,
                resourceName: (plural) => (plural ? t('resourcePlural') : t('resourceSingular')),
                emptyState: (
                    <EmptyState
                        icon={Users}
                        title={filtering ? t('emptyMatchingTitle') : t('emptyTitle')}
                        description={filtering ? t('emptyMatchingDesc') : t('emptyDesc')}
                    />
                ),
            }}
        />
    );
}
