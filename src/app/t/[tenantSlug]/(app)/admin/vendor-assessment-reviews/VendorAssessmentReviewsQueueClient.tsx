'use client';
/* TODO(swr-migration): fetch-on-mount + setState pattern flagged by
 * react-hooks/set-state-in-effect. The call site carries an inline
 * disable directive; it should migrate to useTenantSWR (Epic 69
 * shape) so the rule can lift. */

/**
 * Epic G-3 — vendor assessment review queue (admin index).
 *
 * Lists G-3 assessments in the reviewable / reviewed set
 * (SUBMITTED / REVIEWED / CLOSED), SUBMITTED-first. Each row links
 * to the reviewer page for that assessment.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useGuardedPush } from '@/lib/nav/use-guarded-push';
import { useTranslations } from 'next-intl';
import {
    useTenantApiUrl,
    useTenantHref,
} from '@/lib/tenant-context-provider';
import { createColumns, DataTable } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { formatDate } from '@/lib/format-date';
import { ShieldCheck } from '@/components/ui/icons/nucleo/shield-check';
import {
    VENDOR_ASSESSMENT_VARIANT,
    vendorAssessmentStatusLabelKey,
} from '@/app-layer/domain/entity-status-mapping';

interface ReviewableRow {
    id: string;
    vendorId: string;
    vendorName: string;
    status: string;
    score: number | null;
    riskRating: string | null;
    submittedAt: string | null;
    reviewedAt: string | null;
}

export function VendorAssessmentReviewsQueueClient() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const guardedPush = useGuardedPush();
    const t = useTranslations('vendors');

    const [rows, setRows] = useState<ReviewableRow[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(apiUrl('/vendor-assessment-reviews'));
            if (!res.ok) {
                setError(t('reviewQueue.loadError', { status: res.status }));
                return;
            }
            setRows((await res.json()) as ReviewableRow[]);
        } finally {
            setLoading(false);
        }
    }, [apiUrl, t]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        refresh();
    }, [refresh]);

    const columns = useMemo(
        () =>
            createColumns<ReviewableRow>([
                {
                    id: 'vendor',
                    header: t('reviewQueue.colVendor'),
                    accessorFn: (r) => r.vendorName,
                    cell: ({ row }) => (
                        <Link
                            href={tenantHref(
                                `/admin/vendor-assessment-reviews/${row.original.id}`,
                            )}
                            className="font-medium text-content-default hover:text-content-emphasis hover:underline"
                            onClick={(e) => e.stopPropagation()}
                            data-testid={`review-queue-row-${row.original.id}`}
                        >
                            {row.original.vendorName || '—'}
                        </Link>
                    ),
                },
                {
                    id: 'status',
                    header: t('reviewQueue.colStatus'),
                    accessorFn: (r) => r.status,
                    cell: ({ row }) => (
                        <StatusBadge
                            variant={
                                VENDOR_ASSESSMENT_VARIANT[row.original.status] ??
                                'neutral'
                            }
                            size="sm"
                        >
                            {t(vendorAssessmentStatusLabelKey(row.original.status))}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'score',
                    header: t('reviewQueue.colScore'),
                    accessorFn: (r) => r.score ?? -1,
                    cell: ({ row }) => (
                        <span className="tabular-nums text-content-muted">
                            {row.original.score ?? '—'}
                        </span>
                    ),
                },
                {
                    id: 'riskRating',
                    header: t('reviewQueue.colRisk'),
                    accessorFn: (r) => r.riskRating ?? '',
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {row.original.riskRating ?? '—'}
                        </span>
                    ),
                },
                {
                    id: 'submittedAt',
                    header: t('reviewQueue.colSubmitted'),
                    accessorFn: (r) => r.submittedAt ?? '',
                    cell: ({ row }) => (
                        <span className="text-content-muted">
                            {row.original.submittedAt
                                ? formatDate(row.original.submittedAt)
                                : '—'}
                        </span>
                    ),
                },
            ]),
        [t, tenantHref],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <BackAffordance />
                <PageBreadcrumbs
                    items={[
                        {
                            label: t('reviewQueue.crumbDashboard'),
                            href: tenantHref('/dashboard'),
                        },
                        {
                            label: t('reviewQueue.crumbAdmin'),
                            href: tenantHref('/admin'),
                        },
                        { label: t('reviewQueue.title') },
                    ]}
                    className="mb-1"
                />
                <Heading level={1} id="vendor-assessment-reviews-title">
                    {t('reviewQueue.title')}
                </Heading>
                <p className="text-sm text-content-muted mt-1">
                    {t('reviewQueue.description')}
                </p>
            </ListPageShell.Header>
            <ListPageShell.Body>
                <DataTable<ReviewableRow>
                    fillBody
                    selectionEnabled={false}
                    loading={loading}
                    error={error ?? undefined}
                    data={rows ?? []}
                    columns={columns}
                    getRowId={(r) => r.id}
                    onRowClick={(row) =>
                        guardedPush(
                            tenantHref(
                                `/admin/vendor-assessment-reviews/${row.original.id}`,
                            ),
                        )
                    }
                    resourceName={(plural) =>
                        plural
                            ? t('reviewQueue.resourcePlural')
                            : t('reviewQueue.resourceSingular')
                    }
                    emptyState={
                        <EmptyState
                            icon={ShieldCheck}
                            title={t('reviewQueue.emptyTitle')}
                            description={t('reviewQueue.emptyDesc')}
                        />
                    }
                />
            </ListPageShell.Body>
        </ListPageShell>
    );
}
