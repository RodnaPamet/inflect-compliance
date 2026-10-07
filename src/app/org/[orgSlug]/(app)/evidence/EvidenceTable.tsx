'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Paperclip } from 'lucide-react';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { DataTable, createColumns, sortRowsByDisplay, type SortAccessors } from '@/components/ui/table';
import { TableEmptyState } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { useCursorPagination } from '@/components/ui/hooks';
import { formatDate } from '@inflect/ui/lib/format-date';
import type { OverdueEvidenceRow } from '@/app-layer/schemas/portfolio';
import { Heading } from '@/components/ui/typography';

interface Props {
    rows: OverdueEvidenceRow[];
    nextCursor?: string | null;
    orgSlug?: string;
}

const STATUS_VARIANTS: Record<OverdueEvidenceRow['status'], 'warning' | 'info' | 'error'> = {
    DRAFT: 'warning',
    SUBMITTED: 'info',
    REJECTED: 'error',
};

const STATUS_LABEL_KEY: Record<OverdueEvidenceRow['status'], string> = {
    DRAFT: 'evidence.statusDraft',
    SUBMITTED: 'evidence.statusSubmitted',
    REJECTED: 'evidence.statusRejected',
};

function OverdueBadge({ days }: { days: number }) {
    const t = useTranslations('org');
    // 30+ days → critical, 7+ → warning, otherwise pending.
    const variant = days >= 30 ? 'error' : days >= 7 ? 'warning' : 'warning';
    return (
        <StatusBadge variant={variant}>
            {t('evidence.overdueBadge', { days })}
        </StatusBadge>
    );
}

export function EvidenceTable({ rows: initialRows, nextCursor: initialNextCursor, orgSlug }: Props) {
    const t = useTranslations('org');
    const [sortBy, setSortBy] = useState<string>('daysOverdue');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

    // Epic E — Load-more accumulator. See ControlsTable for design.
    const pagination = useCursorPagination<OverdueEvidenceRow>({
        initialRows,
        initialNextCursor: initialNextCursor ?? null,
        fetchUrl: (cursor) =>
            `/api/org/${orgSlug ?? ''}/portfolio?view=evidence&cursor=${encodeURIComponent(cursor)}`,
    });

    // Sort by what each column DISPLAYS so same-displayed-value rows group
    // contiguously. The Overdue cell renders the `daysOverdue` number (sort
    // numerically), Status renders the raw status, Review-due renders the
    // formatted `nextReviewDate` (raw ISO sorts chronologically + groups).
    const sortAccessors = useMemo<SortAccessors<OverdueEvidenceRow>>(
        () => ({
            tenantName: (x) => x.tenantName || '',
            title: (x) => x.title || '',
            daysOverdue: (x) => x.daysOverdue,
            status: (x) => x.status,
            nextReviewDate: (x) => x.nextReviewDate,
        }),
        [],
    );
    const sorted = useMemo(
        () => sortRowsByDisplay(pagination.rows, sortAccessors, sortBy, sortOrder),
        [pagination.rows, sortAccessors, sortBy, sortOrder],
    );

    const columns = useMemo(
        () =>
            createColumns<OverdueEvidenceRow>([
                {
                    id: 'tenantName',
                    header: t('evidence.colTenant'),
                    cell: ({ row }) => (
                        <span
                            className="text-xs font-medium text-content-muted"
                            data-testid={`org-evidence-tenant-${row.original.tenantSlug}`}
                        >
                            {row.original.tenantName}
                        </span>
                    ),
                },
                {
                    id: 'title',
                    header: t('evidence.colEvidence'),
                    cell: ({ row }) => (
                        <Link
                            href={row.original.drillDownUrl}
                            className="font-medium text-content-emphasis hover:text-content-info hover:underline"
                            data-testid={`org-evidence-link-${row.original.evidenceId}`}
                        >
                            {row.original.title}
                        </Link>
                    ),
                },
                {
                    id: 'daysOverdue',
                    header: t('evidence.colOverdue'),
                    cell: ({ row }) => <OverdueBadge days={row.original.daysOverdue} />,
                },
                {
                    id: 'status',
                    header: t('evidence.colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANTS[row.original.status]}>
                            {t(STATUS_LABEL_KEY[row.original.status])}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'nextReviewDate',
                    header: t('evidence.colReviewDue'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-subtle tabular-nums">
                            {formatDate(row.original.nextReviewDate)}
                        </span>
                    ),
                },
            ]),
        [t],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div>
                    <Heading level={1}>
                        {t('evidence.title')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('evidence.subtitle', { count: pagination.rows.length })}
                        {pagination.hasMore ? t('evidence.moreAvailable') : ''}
                    </p>
                </div>
            </ListPageShell.Header>
            <ListPageShell.Body>
                <DataTable<OverdueEvidenceRow>
                    fillBody
                    data={sorted}
                    columns={columns}
                    getRowId={(r) => r.evidenceId}
                    sortableColumns={['tenantName', 'title', 'daysOverdue', 'status', 'nextReviewDate']}
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSortChange={(p) => {
                        if (p.sortBy) setSortBy(p.sortBy);
                        if (p.sortOrder) setSortOrder(p.sortOrder);
                    }}
                    resourceName={(plural) => (plural ? 'evidence items' : 'evidence item')}
                    emptyState={
                        <TableEmptyState
                            title={t('evidence.emptyTitle')}
                            description={t('evidence.emptyDesc')}
                            icon={<Paperclip className="size-10" />}
                        />
                    }
                    data-testid="org-evidence-table"
                />
                {pagination.hasMore && orgSlug && (
                    <div className="flex flex-col items-center gap-tight pt-3">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="org-evidence-load-more"
                            onClick={() => {
                                void pagination.loadMore();
                            }}
                            disabled={pagination.loading}
                        >
                            {pagination.loading ? t('common.loading') : t('evidence.loadMore')}
                        </Button>
                        {pagination.error && (
                            <span
                                className="text-content-error text-sm"
                                role="alert"
                                data-testid="org-evidence-load-error"
                            >
                                {t('evidence.failedLoadMore')}
                            </span>
                        )}
                    </div>
                )}
            </ListPageShell.Body>
        </ListPageShell>
    );
}
