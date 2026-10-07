'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';

import { ListPageShell } from '@/components/layout/ListPageShell';
import { DataTable, createColumns, sortRowsByDisplay, type SortAccessors } from '@/components/ui/table';
import { TableEmptyState } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { useCursorPagination } from '@/components/ui/hooks';
import { formatDate } from '@inflect/ui/lib/format-date';
import type { CriticalRiskRow } from '@/app-layer/schemas/portfolio';
import { Heading } from '@/components/ui/typography';

interface Props {
    rows: CriticalRiskRow[];
    nextCursor?: string | null;
    orgSlug?: string;
}

const STATUS_VARIANTS: Record<CriticalRiskRow['status'], 'error' | 'warning' | 'info'> = {
    OPEN: 'error',
    MITIGATING: 'warning',
    ACCEPTED: 'info',
};

const STATUS_LABEL_KEY: Record<CriticalRiskRow['status'], string> = {
    OPEN: 'risks.statusOpen',
    MITIGATING: 'risks.statusMitigating',
    ACCEPTED: 'risks.statusAccepted',
};

function ScorePill({ score }: { score: number }) {
    // ≥ 20 critical (red), 15-19 high (warning).
    const variant = score >= 20 ? 'error' : 'warning';
    return <StatusBadge variant={variant}>{score}</StatusBadge>;
}

export function RisksTable({ rows: initialRows, nextCursor: initialNextCursor, orgSlug }: Props) {
    const t = useTranslations('org');
    const [sortBy, setSortBy] = useState<string>('inherentScore');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

    // Epic E — Load-more accumulator. See ControlsTable for design.
    const pagination = useCursorPagination<CriticalRiskRow>({
        initialRows,
        initialNextCursor: initialNextCursor ?? null,
        fetchUrl: (cursor) =>
            `/api/org/${orgSlug ?? ''}/portfolio?view=risks&cursor=${encodeURIComponent(cursor)}`,
    });

    // Sort by what each column DISPLAYS so same-displayed-value rows group
    // contiguously. The Score cell renders the `inherentScore` number (sort
    // numerically), Status renders the raw status, Updated renders the
    // formatted `updatedAt` (raw ISO sorts chronologically + groups).
    const sortAccessors = useMemo<SortAccessors<CriticalRiskRow>>(
        () => ({
            tenantName: (x) => x.tenantName || '',
            title: (x) => x.title || '',
            inherentScore: (x) => x.inherentScore,
            status: (x) => x.status,
            updatedAt: (x) => x.updatedAt,
        }),
        [],
    );
    const sorted = useMemo(
        () => sortRowsByDisplay(pagination.rows, sortAccessors, sortBy, sortOrder),
        [pagination.rows, sortAccessors, sortBy, sortOrder],
    );

    const columns = useMemo(
        () =>
            createColumns<CriticalRiskRow>([
                {
                    id: 'tenantName',
                    header: t('risks.colTenant'),
                    cell: ({ row }) => (
                        <span
                            className="text-xs font-medium text-content-muted"
                            data-testid={`org-risk-tenant-${row.original.tenantSlug}`}
                        >
                            {row.original.tenantName}
                        </span>
                    ),
                },
                {
                    id: 'title',
                    header: t('risks.colRisk'),
                    cell: ({ row }) => (
                        <Link
                            href={row.original.drillDownUrl}
                            className="font-medium text-content-emphasis hover:text-content-info hover:underline"
                            data-testid={`org-risk-link-${row.original.riskId}`}
                        >
                            {row.original.title}
                        </Link>
                    ),
                },
                {
                    id: 'inherentScore',
                    header: t('risks.colScore'),
                    cell: ({ row }) => <ScorePill score={row.original.inherentScore} />,
                },
                {
                    id: 'status',
                    header: t('risks.colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANTS[row.original.status]}>
                            {t(STATUS_LABEL_KEY[row.original.status])}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'updatedAt',
                    header: t('risks.colUpdated'),
                    cell: ({ row }) => (
                        <span className="text-xs text-content-subtle tabular-nums">
                            {formatDate(row.original.updatedAt)}
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
                        {t('risks.title')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('risks.subtitle', { count: pagination.rows.length })}
                        {pagination.hasMore ? t('risks.moreAvailable') : ''}
                    </p>
                </div>
            </ListPageShell.Header>
            <ListPageShell.Body>
                <DataTable<CriticalRiskRow>
                    fillBody
                    data={sorted}
                    columns={columns}
                    getRowId={(r) => r.riskId}
                    sortableColumns={['tenantName', 'title', 'inherentScore', 'status', 'updatedAt']}
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSortChange={(p) => {
                        if (p.sortBy) setSortBy(p.sortBy);
                        if (p.sortOrder) setSortOrder(p.sortOrder);
                    }}
                    resourceName={(plural) => (plural ? 'risks' : 'risk')}
                    emptyState={
                        <TableEmptyState
                            title={t('risks.emptyTitle')}
                            description={t('risks.emptyDesc')}
                            icon={<AlertTriangle className="size-10" />}
                        />
                    }
                    data-testid="org-risks-table"
                />
                {pagination.hasMore && orgSlug && (
                    <div className="flex flex-col items-center gap-tight pt-3">
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="org-risks-load-more"
                            onClick={() => {
                                void pagination.loadMore();
                            }}
                            disabled={pagination.loading}
                        >
                            {pagination.loading ? t('common.loading') : t('risks.loadMore')}
                        </Button>
                        {pagination.error && (
                            <span
                                className="text-content-error text-sm"
                                role="alert"
                                data-testid="org-risks-load-error"
                            >
                                {t('risks.failedLoadMore')}
                            </span>
                        )}
                    </div>
                )}
            </ListPageShell.Body>
        </ListPageShell>
    );
}
