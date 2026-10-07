'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { UserFocus } from '@inflect/ui/components/ui/icons/nucleo';

import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { formatDate } from '@inflect/ui/lib/format-date';
import { useTenantHref } from '@/lib/tenant-context-provider';

export interface DsarRow {
    id: string;
    type: 'EXPORT' | 'ERASURE';
    status: 'RECEIVED' | 'VERIFIED' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'CANCELED';
    subject: { id: string; email: string | null; name: string | null };
    requestedAt: string;
    verifiedAt: string | null;
    completedAt: string | null;
    rejectionReason: string | null;
    fulfilmentNotes: string | null;
    handledBy: { id: string; name: string | null } | null;
}

/** Status → badge tone. CANCELED reads neutral, REJECTED reads error: a
 *  withdrawn request is not a refused one. */
const STATUS_TONE: Record<DsarRow['status'], StatusBadgeVariant> = {
    RECEIVED: 'warning',
    VERIFIED: 'info',
    IN_PROGRESS: 'info',
    COMPLETED: 'success',
    REJECTED: 'error',
    CANCELED: 'neutral',
};

export function DsarRegisterClient({
    tenantSlug: _tenantSlug,
    initial,
    canManage,
    title,
}: {
    tenantSlug: string;
    initial: DsarRow[];
    canManage: boolean;
    title: string;
}) {
    const t = useTranslations('admin');
    const tenantHref = useTenantHref();
    const [rows] = useState<DsarRow[]>(initial);

    const columns = useMemo(
        () => createColumns<DsarRow>([
            {
                id: 'subject',
                header: t('dsar.col.subject'),
                accessorKey: 'subject',
                cell: ({ row }) => {
                    const s = row.original.subject;
                    return (
                        <span className="text-sm" data-testid={`dsar-subject-${row.original.id}`}>
                            {s.name ?? s.email ?? s.id}
                        </span>
                    );
                },
            },
            {
                id: 'type',
                header: t('dsar.col.type'),
                accessorKey: 'type',
                cell: ({ row }) => (
                    <StatusBadge variant={row.original.type === 'ERASURE' ? 'warning' : 'info'}>
                        {t(`dsar.type.${row.original.type}`)}
                    </StatusBadge>
                ),
            },
            {
                id: 'status',
                header: t('dsar.col.status'),
                accessorKey: 'status',
                cell: ({ row }) => (
                    <StatusBadge variant={STATUS_TONE[row.original.status]}>
                        {t(`dsar.status.${row.original.status}`)}
                    </StatusBadge>
                ),
            },
            {
                id: 'requestedAt',
                header: t('dsar.col.requested'),
                accessorKey: 'requestedAt',
                cell: ({ row }) => (
                    <span className="text-sm text-content-muted">{formatDate(row.original.requestedAt)}</span>
                ),
            },
            {
                id: 'handledBy',
                header: t('dsar.col.handledBy'),
                accessorKey: 'handledBy',
                cell: ({ row }) => (
                    <span className="text-sm text-content-muted">{row.original.handledBy?.name ?? '—'}</span>
                ),
            },
        ]),
        [t],
    );

    return (
        <ListPageShell>
            <ListPageShell.Header>
                <div className="space-y-default">
                    <PageBreadcrumbs
                        items={[
                            { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                            { label: t('title'), href: tenantHref('/admin') },
                            { label: title },
                        ]}
                    />
                    <BackAffordance />
                    <div className="flex items-center gap-compact">
                        <UserFocus className="w-4 h-4 text-content-muted" />
                        <Heading level={1}>{title}</Heading>
                    </div>

                    {/* The load-bearing disclosure. Nothing on this page exports or
                        erases anything — marking a request COMPLETED records that a
                        human did the work out-of-band. A queue that looked like an
                        engine would be worse than no queue at all. */}
                    <InlineNotice variant="info" title={t('dsar.manualTitle')}>
                        {t('dsar.manualBody')}
                    </InlineNotice>

                    {!canManage && (
                        <InlineNotice variant="info">{t('dsar.readOnlyNotice')}</InlineNotice>
                    )}
                </div>
            </ListPageShell.Header>

            <ListPageShell.Body>
                <DataTable
                    fillBody
                    data={rows}
                    columns={columns}
                    getRowId={(r) => r.id}
                    emptyState={
                        <div className="space-y-tight text-center">
                            <p className="text-sm font-medium text-content-emphasis">{t('dsar.emptyTitle')}</p>
                            <p className="text-sm text-content-muted">{t('dsar.emptyDesc')}</p>
                        </div>
                    }
                />
            </ListPageShell.Body>
        </ListPageShell>
    );
}
