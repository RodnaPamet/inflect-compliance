'use client';

/**
 * Training (PR-6) — security-awareness training assignments per employee, with
 * status filtering. Background checks are recorded via API (a management UI is
 * a follow-up). Built on EntityListPage.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Book2 } from '@inflect/ui/components/ui/icons/nucleo/book2';
import { formatDate } from '@inflect/ui/lib/format-date';
import { buildTrainingFilters, TRAINING_FILTER_KEYS } from './filter-defs';

export interface AssignmentRow {
    id: string;
    status: string;
    assignedAt: string;
    dueAt: string | null;
    completedAt: string | null;
    employee: { fullName: string; workEmail: string };
    course: { name: string };
}

interface Props {
    initialRows: AssignmentRow[];
}

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
    ASSIGNED: 'neutral',
    IN_PROGRESS: 'info',
    COMPLETED: 'success',
    OVERDUE: 'error',
};

export function TrainingClient(props: Props) {
    const t = useTranslations('training');
    const tGroup = useTranslations('common.filterGroups');
    const filters = useMemo(
        () => buildTrainingFilters((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const filterCtx = useFilterContext(filters, [...TRAINING_FILTER_KEYS]);
    return (
        <FilterProvider value={filterCtx}>
            <TrainingInner {...props} />
        </FilterProvider>
    );
}

function TrainingInner({ initialRows }: Props) {
    const t = useTranslations('training');
    const tGroup = useTranslations('common.filterGroups');
    const filterDefs = useMemo(
        () => buildTrainingFilters((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const { state, hasActive } = useFilters();

    const rows = useMemo(() => {
        const statuses = (state.status ?? []) as string[];
        return statuses.length ? initialRows.filter((r) => statuses.includes(r.status)) : initialRows;
    }, [initialRows, state.status]);

    const columns = useMemo(
        () =>
            createColumns<AssignmentRow>([
                {
                    id: 'employee',
                    header: t('colEmployee'),
                    accessorFn: (r) => r.employee.fullName,
                    cell: ({ row }) => (
                        <div className="min-w-0">
                            <div className="truncate font-medium text-content-default">{row.original.employee.fullName}</div>
                            <div className="truncate text-content-subtle">{row.original.employee.workEmail}</div>
                        </div>
                    ),
                },
                { id: 'course', header: t('colCourse'), accessorFn: (r) => r.course.name, cell: ({ row }) => <span className="text-content-default">{row.original.course.name}</span> },
                { id: 'status', header: t('colStatus'), accessorFn: (r) => r.status, cell: ({ row }) => <StatusBadge variant={STATUS_VARIANT[row.original.status] ?? 'neutral'}>{row.original.status}</StatusBadge> },
                { id: 'due', header: t('colDue'), accessorFn: (r) => r.dueAt ?? '', cell: ({ row }) => <span className="text-content-muted">{row.original.dueAt ? formatDate(row.original.dueAt) : '—'}</span> },
                { id: 'completed', header: t('colCompleted'), accessorFn: (r) => r.completedAt ?? '', cell: ({ row }) => <span className="text-content-muted">{row.original.completedAt ? formatDate(row.original.completedAt) : '—'}</span> },
            ]),
        [t],
    );

    return (
        <EntityListPage<AssignmentRow>
            header={{
                title: (
                    <>
                        <Book2 className="inline-block mr-2 h-5 w-5 align-text-bottom" />
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
                        icon={Book2}
                        title={hasActive ? t('emptyMatchingTitle') : t('emptyTitle')}
                        description={hasActive ? t('emptyMatchingDesc') : t('emptyDesc')}
                    />
                ),
            }}
        />
    );
}
