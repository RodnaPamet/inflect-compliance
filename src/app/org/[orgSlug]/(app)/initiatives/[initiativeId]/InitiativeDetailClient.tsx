'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft } from 'lucide-react';

import { StatusBadge } from '@/components/ui/status-badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { DataTable, createColumns } from '@/components/ui/table';
import { useToastWithUndo } from '@/components/ui/hooks';
import { formatDate } from '@/lib/format-date';
import type { ColumnDef } from '@/components/ui/table';

const STATUSES = ['PLANNED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED'] as const;
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

type LinkRow = { id: string; linkedTenantId: string; entityType: string; entityId: string };
type Initiative = {
    id: string;
    title: string;
    description: string | null;
    status: string;
    ownerUserId: string | null;
    targetDate: string | null;
    manualProgressPercent: number | null;
    links: LinkRow[];
};
type Progress = { percent: number; completed: number; total: number; manual: boolean };

export function InitiativeDetailClient({
    orgSlug,
    canManage,
    initiative,
    progress,
}: {
    orgSlug: string;
    canManage: boolean;
    initiative: Initiative;
    progress: Progress;
}) {
    const router = useRouter();
    const t = useTranslations('org');
    const triggerUndoToast = useToastWithUndo();
    const [links, setLinks] = useState<LinkRow[]>(initiative.links);
    const [busy, setBusy] = useState(false);
    const base = `/api/org/${orgSlug}/initiatives/${initiative.id}`;

    const changeStatus = async (status: string) => {
        setBusy(true);
        try {
            await fetch(`${base}/status`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status }),
            });
            router.refresh();
        } finally {
            setBusy(false);
        }
    };

    // Epic 67 — unlink via the undo-toast (optimistic remove + 5s window).
    const unlink = (link: LinkRow) => {
        setLinks((prev) => prev.filter((l) => l.id !== link.id));
        triggerUndoToast({
            action: async () => {
                await fetch(`${base}/links/${link.id}`, { method: 'DELETE' });
                router.refresh();
            },
            undoAction: () => setLinks((prev) => [...prev, link]),
            message: t('initiativeDetail.unlinkedToast', { entity: link.entityType.toLowerCase() }),
            undoMessage: t('initiativeDetail.undo'),
        });
    };

    const columns = createColumns<LinkRow>([
        { accessorKey: 'entityType', header: t('initiativeDetail.colType'), cell: ({ row }) => <StatusBadge variant="neutral" size="sm">{row.original.entityType}</StatusBadge> },
        { accessorKey: 'linkedTenantId', header: t('initiativeDetail.colTenant'), cell: ({ row }) => <span className="text-content-muted text-xs">{row.original.linkedTenantId}</span> },
        { accessorKey: 'entityId', header: t('initiativeDetail.colEntity'), cell: ({ row }) => <span className="text-content-muted text-xs">{row.original.entityId}</span> },
        ...(canManage
            ? [{
                  id: 'actions',
                  header: '',
                  cell: ({ row }: { row: { original: LinkRow } }) => (
                      <Button variant="ghost" size="sm" onClick={() => unlink(row.original)}>{t('initiativeDetail.unlink')}</Button>
                  ),
              } as ColumnDef<LinkRow>]
            : []),
    ]);

    const tenantSpan = new Set(links.map((l) => l.linkedTenantId)).size;

    return (
        <div className="space-y-section p-4">
            <Button variant="ghost" size="sm" onClick={() => router.push(`/org/${orgSlug}/initiatives`)}>
                <ChevronLeft className="w-3.5 h-3.5" /> {t('initiativeDetail.backToInitiatives')}
            </Button>

            <div className="space-y-tight">
                <div className="flex items-center gap-compact flex-wrap">
                    <Heading level={1}>{initiative.title}</Heading>
                    <StatusBadge variant={STATUS_VARIANT[initiative.status] ?? 'neutral'}>
                        {STATUS_LABEL_KEY[initiative.status] ? t(STATUS_LABEL_KEY[initiative.status]) : initiative.status}
                    </StatusBadge>
                </div>
                {initiative.description && <p className="text-sm text-content-muted">{initiative.description}</p>}
                {initiative.targetDate && (
                    <p className="text-xs text-content-muted">{t('initiativeDetail.target', { date: formatDate(new Date(initiative.targetDate)) })}</p>
                )}
            </div>

            <div className="space-y-tight max-w-md">
                <div className="flex items-center justify-between text-sm">
                    <span className="text-content-muted">{progress.manual ? t('initiativeDetail.progressManual') : t('initiativeDetail.progressDerived')}</span>
                    <span className="tabular-nums">{progress.percent}%{!progress.manual && ` · ${progress.completed}/${progress.total}`}</span>
                </div>
                <ProgressBar value={progress.percent} aria-label={t('initiativeDetail.progressAria')} />
            </div>

            {canManage && (
                <div className="flex items-center gap-tight flex-wrap">
                    <span className="text-sm text-content-muted">{t('initiativeDetail.setStatus')}</span>
                    {STATUSES.map((s) => (
                        <Button key={s} variant="secondary" size="sm" disabled={busy || s === initiative.status} onClick={() => changeStatus(s)}>
                            {STATUS_LABEL_KEY[s] ? t(STATUS_LABEL_KEY[s]) : s}
                        </Button>
                    ))}
                </div>
            )}

            <div className="space-y-tight">
                <Heading level={3}>
                    {t('initiativeDetail.linkedWork')}{tenantSpan > 0 ? t('initiativeDetail.tenantSpan', { count: tenantSpan }) : ''}
                </Heading>
                <DataTable data={links} columns={columns} getRowId={(r) => r.id} />
            </div>
        </div>
    );
}
