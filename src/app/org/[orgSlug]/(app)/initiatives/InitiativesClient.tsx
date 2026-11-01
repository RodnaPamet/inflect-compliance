'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useGuardedPush } from '@/lib/nav/use-guarded-push';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@/components/ui/table';

import { DataTable, createColumns, TableEmptyState } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { formatDate } from '@inflect/ui/lib/format-date';
import { useHydratedNow } from '@/lib/hooks/use-hydrated-now';
import type { MemberOption } from './CreateInitiativeModal';

/**
 * The create dialog, loaded when it is first opened (#4851). Its owner picker,
 * date picker and form fields came to about 40 KB of First Load JS, on a page
 * that opens closed, and took the initiative routes past the `root` bundle
 * budget. The page is otherwise usable at once; the dialog follows its button.
 */
const CreateInitiativeModal = dynamic(
    () => import('./CreateInitiativeModal').then((m) => m.CreateInitiativeModal),
    { ssr: false },
);

type Row = {
    id: string;
    title: string;
    status: string;
    ownerUserId: string | null;
    ownerName: string | null;
    targetDate: string | null;
    manualProgressPercent: number | null;
    linkCount: number;
    tenantSpan: number;
};

const STATUS_VARIANT: Record<string, 'neutral' | 'info' | 'warning' | 'error' | 'success'> = {
    PLANNED: 'neutral',
    IN_PROGRESS: 'info',
    BLOCKED: 'error',
    COMPLETED: 'success',
    CANCELLED: 'neutral',
};
const STATUS_LABEL_KEY: Record<string, string> = {
    PLANNED: 'widgets.statusPlanned',
    IN_PROGRESS: 'widgets.statusInProgress',
    BLOCKED: 'widgets.statusBlocked',
    COMPLETED: 'widgets.statusCompleted',
    CANCELLED: 'widgets.statusCancelled',
};

/**
 * Blocked, or past its target date while still open. The clock is the
 * hydrated `now` (#4851): reading `Date.now()` during render gave the server
 * and the browser different answers. Before hydration only a blocked
 * initiative reads at risk.
 */
function atRisk(r: Row, now: Date | null): boolean {
    if (r.status === 'BLOCKED') return true;
    if (!now || !r.targetDate || r.status === 'COMPLETED' || r.status === 'CANCELLED') return false;
    return new Date(r.targetDate).getTime() < now.getTime();
}

export function InitiativesClient({
    orgSlug,
    canManage,
    members,
    initiatives,
}: {
    orgSlug: string;
    canManage: boolean;
    members: MemberOption[];
    initiatives: Row[];
}) {
    const router = useRouter();
    const guardedPush = useGuardedPush();
    const t = useTranslations('org');
    const now = useHydratedNow();
    const [createOpen, setCreateOpen] = useState(false);

    const columns = useMemo(
        () =>
            createColumns<Row>([
                {
                    accessorKey: 'title',
                    header: t('initiatives.colInitiative'),
                    cell: ({ row }) => <span className="font-medium">{row.original.title}</span>,
                },
                {
                    accessorKey: 'status',
                    header: t('initiatives.colStatus'),
                    cell: ({ row }) => (
                        <StatusBadge variant={STATUS_VARIANT[row.original.status] ?? 'neutral'} size="sm">
                            {STATUS_LABEL_KEY[row.original.status]
                                ? t(STATUS_LABEL_KEY[row.original.status])
                                : row.original.status}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'owner',
                    header: t('initiatives.colOwner'),
                    cell: ({ row }) =>
                        row.original.ownerName ? (
                            <span className="text-content-default">{row.original.ownerName}</span>
                        ) : (
                            <span className="text-content-muted text-xs">{t('initiatives.noOwner')}</span>
                        ),
                },
                {
                    id: 'risk',
                    header: t('initiatives.colRisk'),
                    cell: ({ row }) =>
                        atRisk(row.original, now) ? (
                            <StatusBadge variant="warning" size="sm">{t('initiatives.atRisk')}</StatusBadge>
                        ) : (
                            <span className="text-content-muted text-xs">—</span>
                        ),
                },
                {
                    id: 'linked',
                    header: t('initiatives.colLinkedWork'),
                    cell: ({ row }) => (
                        <span className="text-content-muted tabular-nums">
                            {row.original.linkCount}
                            {row.original.tenantSpan > 0
                                ? t('initiatives.tenantSpan', { count: row.original.tenantSpan })
                                : ''}
                        </span>
                    ),
                },
                {
                    accessorKey: 'targetDate',
                    header: t('initiatives.colTarget'),
                    cell: ({ row }) =>
                        row.original.targetDate ? (
                            <span className="text-content-muted">{formatDate(new Date(row.original.targetDate))}</span>
                        ) : (
                            <span className="text-content-muted text-xs">—</span>
                        ),
                },
            ]),
        [t, now],
    );

    return (
        <div className="space-y-section p-4">
            <div className="flex items-center justify-between gap-compact flex-wrap">
                <Heading level={1}>{t('initiatives.title')}</Heading>
                {canManage && (
                    <Button variant="primary" onClick={() => setCreateOpen(true)}>
                        {t('initiatives.newInitiative')}
                    </Button>
                )}
            </div>

            <DataTable
                data={initiatives}
                columns={columns}
                getRowId={(r) => r.id}
                onRowClick={(r) => guardedPush(`/org/${orgSlug}/initiatives/${r.id}`)}
                resourceName={(plural) => (plural ? t('initiatives.resourceMany') : t('initiatives.resourceOne'))}
                emptyState={
                    <TableEmptyState
                        title={t('initiatives.emptyTitle')}
                        description={canManage ? t('initiatives.emptyDescManage') : t('initiatives.emptyDescRead')}
                    />
                }
                data-testid="org-initiatives-table"
            />

            {createOpen && (
                <CreateInitiativeModal
                    orgSlug={orgSlug}
                    members={members}
                    onClose={() => setCreateOpen(false)}
                    onCreated={(id) => router.push(`/org/${orgSlug}/initiatives/${id}`)}
                />
            )}
        </div>
    );
}
