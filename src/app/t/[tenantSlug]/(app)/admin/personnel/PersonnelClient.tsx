'use client';

/**
 * Personnel roster (PR-4) — the people-layer hub. Lists employees synced from
 * an HRIS or entered manually, with employment-status filtering. Built on
 * EntityListPage. Device (PR-5) + Training/Background (PR-6) attach to the
 * detail page.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Users } from '@inflect/ui/components/ui/icons/nucleo/users';
import { buildPersonnelFilters, PERSONNEL_FILTER_KEYS } from './filter-defs';

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

interface Props {
    initialRows: EmployeeRow[];
    tenantSlug: string;
}

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    ACTIVE: 'success',
    ONBOARDING: 'info',
    OFFBOARDING: 'warning',
    TERMINATED: 'error',
    LEAVE: 'neutral',
};

export function PersonnelClient(props: Props) {
    const t = useTranslations('personnel');
    const tGroup = useTranslations('common.filterGroups');
    const filters = useMemo(
        () => buildPersonnelFilters((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const filterCtx = useFilterContext(filters, [...PERSONNEL_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <PersonnelInner {...props} />
        </FilterProvider>
    );
}

function PersonnelInner({ initialRows }: Props) {
    const t = useTranslations('personnel');
    const tGroup = useTranslations('common.filterGroups');
    const filterDefs = useMemo(
        () => buildPersonnelFilters((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const { state, hasActive } = useFilters();

    const rows = useMemo(() => {
        const statuses = (state.status ?? []) as string[];
        return statuses.length ? initialRows.filter((r) => statuses.includes(r.status)) : initialRows;
    }, [initialRows, state.status]);

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
                    cell: ({ row }) => <StatusBadge variant={STATUS_VARIANT[row.original.status] ?? 'neutral'}>{row.original.status}</StatusBadge>,
                },
                { id: 'department', header: t('colDepartment'), accessorFn: (r) => r.department ?? '', cell: ({ row }) => <span className="text-content-muted">{row.original.department ?? '—'}</span> },
                { id: 'jobTitle', header: t('colTitle'), accessorFn: (r) => r.jobTitle ?? '', cell: ({ row }) => <span className="text-content-muted">{row.original.jobTitle ?? '—'}</span> },
                { id: 'source', header: t('colSource'), accessorFn: (r) => r.source, cell: ({ row }) => <span className="text-content-subtle">{row.original.source}</span> },
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
                description: t('description', { total: initialRows.length }),
                back: { smart: true },
            }}
            filters={{ defs: filterDefs }}
            table={{
                data: rows,
                columns,
                getRowId: (r) => r.id,
                resourceName: (plural) => (plural ? t('resourcePlural') : t('resourceSingular')),
                emptyState: (
                    <EmptyState
                        icon={Users}
                        title={hasActive ? t('emptyMatchingTitle') : t('emptyTitle')}
                        description={hasActive ? t('emptyMatchingDesc') : t('emptyDesc')}
                    />
                ),
            }}
        />
    );
}
