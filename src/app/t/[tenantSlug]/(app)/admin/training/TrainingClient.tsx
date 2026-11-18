'use client';

/**
 * Training (PR-6) — security-awareness training assignments per employee, with
 * a search and a status filter. Background checks are recorded via API (a
 * management UI is a follow-up). Built on EntityListPage.
 *
 * Paged on the server (#5764 item 6). The server page renders the first page
 * for the filters in the URL; the filter bar writes them there, so changing a
 * filter re-renders that first page, and `resetKey` makes the list start again
 * from it. "Load more" reads the next page from `GET /training` with the same
 * filters, so every assignment is reachable, and a filter covers them all
 * rather than the rows already loaded.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { EntityListPage } from '@/components/layout/EntityListPage';
import { FilterProvider, useFilterContext, useFilters } from '@/components/ui/filter';
import { createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { useCursorPagination } from '@/components/ui/hooks';
import { Book2 } from '@inflect/ui/components/ui/icons/nucleo/book2';
import { formatDate } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import {
    TRAINING_PAGE_SIZE,
    effectiveTrainingStatus,
    trainingFiltersKey,
    trainingFiltersQuery,
    type TrainingListFilters,
} from '@/lib/training-list';
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

const NO_FILTERS: TrainingListFilters = { q: '', statuses: [] };

interface Props {
    /** The first page for `filters`, newest first. */
    initialRows: AssignmentRow[];
    /** Where the second page starts, or null when the first is the last. */
    initialNextCursor?: string | null;
    /** Every assignment `filters` match, across all pages. */
    total?: number;
    /** The filters the server applied to `initialRows`. */
    filters?: TrainingListFilters;
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
    const applied = props.filters ?? NO_FILTERS;
    const serverFilters = useMemo(() => {
        const out: Record<string, string> = {};
        if (applied.q) out.q = applied.q;
        if (applied.statuses.length) out.status = applied.statuses.join(',');
        return out;
    }, [applied]);
    const filterCtx = useFilterContext(filters, [...TRAINING_FILTER_KEYS], { serverFilters });
    return (
        <FilterProvider value={filterCtx}>
            <TrainingInner {...props} />
        </FilterProvider>
    );
}

function TrainingInner({ initialRows, initialNextCursor = null, total, filters: applied = NO_FILTERS }: Props) {
    const t = useTranslations('training');
    const tGroup = useTranslations('common.filterGroups');
    const filterDefs = useMemo(
        () => buildTrainingFilters((k, v) => t(k as Parameters<typeof t>[0], v as Parameters<typeof t>[1]), (k) => tGroup(k as Parameters<typeof tGroup>[0])),
        [t, tGroup],
    );
    const { hasActive, search } = useFilters();
    const term = search.trim();
    const apiUrl = useTenantApiUrl();

    // The next pages are read with the filters the SERVER applied to the first
    // one, not the filter bar's live state: the cursor belongs to that query.
    const pages = useCursorPagination<AssignmentRow>({
        initialRows,
        initialNextCursor,
        resetKey: trainingFiltersKey(applied),
        fetchUrl: (cursor) => {
            const q = trainingFiltersQuery(applied);
            q.set('limit', String(TRAINING_PAGE_SIZE));
            q.set('cursor', cursor);
            return apiUrl(`/training?${q.toString()}`);
        },
    });
    const matchCount = total ?? pages.rows.length;
    const filtered = applied.q !== '' || applied.statuses.length > 0;

    // Each row's status as it stands today: an open assignment past its due
    // date is overdue, though nothing stores OVERDUE (#4817). The badge reads
    // this, and the server's status filter applies the same rule.
    const rows = useMemo(
        () => pages.rows.map((r) => ({ ...r, status: effectiveTrainingStatus(r) })),
        [pages.rows],
    );

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
                description: filtered
                    ? t('descriptionMatching', { total: matchCount })
                    : t('description', { total: matchCount }),
                back: { smart: true },
            }}
            filters={{ defs: filterDefs, searchId: 'training-search', searchPlaceholder: t('searchPlaceholder') }}
            table={{
                data: rows,
                columns,
                getRowId: (r) => r.id,
                resourceName: (plural) => (plural ? t('resourcePlural') : t('resourceSingular')),
                'data-testid': 'training-table',
                emptyState: (
                    <EmptyState
                        icon={Book2}
                        title={filtered || hasActive || term ? t('emptyMatchingTitle') : t('emptyTitle')}
                        description={filtered || hasActive || term ? t('emptyMatchingDesc') : t('emptyDesc')}
                    />
                ),
            }}
            tableFooter={
                pages.hasMore ? (
                    <div className="flex flex-col items-center gap-tight pt-3" id="training-load-more">
                        <span className="text-sm text-content-muted">
                            {t('shownOfTotal', { shown: pages.rows.length, total: matchCount })}
                        </span>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            id="training-load-more-button"
                            onClick={() => {
                                void pages.loadMore();
                            }}
                            disabled={pages.loading}
                        >
                            {pages.loading ? t('loading') : t('loadMore')}
                        </Button>
                        {pages.error ? (
                            <span className="text-sm text-content-error" role="alert">
                                {t('loadFailed')}
                            </span>
                        ) : null}
                    </div>
                ) : null
            }
        />
    );
}
