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
import { TruncationBanner } from '@/components/ui/TruncationBanner';
import { TRAINING_LIST_CAP, effectiveTrainingStatus } from '@/lib/training-list';
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
    /** The workspace holds more than `TRAINING_LIST_CAP` assignments. */
    truncated?: boolean;
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

function TrainingInner({ initialRows, truncated = false }: Props) {
    const t = useTranslations('training');
    const tGroup = useTranslations('common.filterGroups');
    const filterDefs = useMemo(
        () => buildTrainingFilters((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const { state, hasActive, search } = useFilters();
    const term = search.trim().toLowerCase();

    // Each row's status as it stands today: an open assignment past its due
    // date is overdue, though nothing stores OVERDUE (#4817). The filter and
    // the badge both read this, so "Overdue" finds what it shows.
    const withStatus = useMemo(
        () => initialRows.map((r) => ({ ...r, status: effectiveTrainingStatus(r) })),
        [initialRows],
    );

    const rows = useMemo(() => {
        const statuses = (state.status ?? []) as string[];
        return withStatus.filter((r) => {
            if (statuses.length && !statuses.includes(r.status)) return false;
            if (!term) return true;
            return [r.employee.fullName, r.employee.workEmail, r.course.name]
                .some((v) => v.toLowerCase().includes(term));
        });
    }, [withStatus, state.status, term]);

    const columns = useMemo(
        () => {
            const tAny = t as unknown as ((k: string) => string) & { has: (k: string) => boolean };
            const statusLabel = (status: string) =>
                tAny.has(`filterEnums.status.${status}`) ? tAny(`filterEnums.status.${status}`) : status;
            return createColumns<AssignmentRow>([
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
                { id: 'status', header: t('colStatus'), accessorFn: (r) => r.status, cell: ({ row }) => <StatusBadge variant={STATUS_VARIANT[row.original.status] ?? 'neutral'}>{statusLabel(row.original.status)}</StatusBadge> },
                { id: 'due', header: t('colDue'), accessorFn: (r) => r.dueAt ?? '', cell: ({ row }) => <span className="text-content-muted">{row.original.dueAt ? formatDate(row.original.dueAt) : '—'}</span> },
                { id: 'completed', header: t('colCompleted'), accessorFn: (r) => r.completedAt ?? '', cell: ({ row }) => <span className="text-content-muted">{row.original.completedAt ? formatDate(row.original.completedAt) : '—'}</span> },
            ]);
        },
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
            filters={{ defs: filterDefs, searchId: 'training-search', searchPlaceholder: t('searchPlaceholder') }}
            banner={<TruncationBanner truncated={truncated} cap={TRAINING_LIST_CAP} />}
            table={{
                data: rows,
                columns,
                getRowId: (r) => r.id,
                resourceName: (plural) => (plural ? t('resourcePlural') : t('resourceSingular')),
                emptyState: (
                    <EmptyState
                        icon={Book2}
                        title={hasActive || term ? t('emptyMatchingTitle') : t('emptyTitle')}
                        description={hasActive || term ? t('emptyMatchingDesc') : t('emptyDesc')}
                    />
                ),
            }}
        />
    );
}
