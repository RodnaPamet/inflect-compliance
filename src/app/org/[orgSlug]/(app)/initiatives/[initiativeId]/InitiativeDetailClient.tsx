'use client';

/**
 * One security initiative (#4852).
 *
 * The page could show an initiative and change its status, and nothing
 * else: no way to link work (so derived progress stayed 0%), to edit or to
 * delete it; linked rows showed stored ids; and every write ignored its
 * answer. Owner decision (2026-11-01): an Edit sheet, Delete with a typed
 * confirmation, a Link work picker (workspace, then item), linked rows by
 * name with links.
 */
import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft } from 'lucide-react';

import { StatusBadge } from '@/components/ui/status-badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { DataTable, createColumns, TableEmptyState } from '@/components/ui/table';
import { useToastWithUndo } from '@/components/ui/hooks';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineNotice } from '@/components/ui/inline-notice';
import { formatDate } from '@inflect/ui/lib/format-date';
import type { ColumnDef } from '@/components/ui/table';
import { TYPE_LABEL_KEY, failure, type Initiative, type LinkRow, type Progress } from './initiative-shared';

// The three dialogs load when first opened (#4852): their pickers and form
// fields would otherwise be First Load JS on a page that opens with all of
// them closed, past the `root` bundle budget.
const EditInitiativeSheet = dynamic(() => import('./InitiativeDialogs').then((m) => m.EditInitiativeSheet), { ssr: false });
const LinkWorkModal = dynamic(() => import('./InitiativeDialogs').then((m) => m.LinkWorkModal), { ssr: false });
const DeleteInitiativeModal = dynamic(() => import('./InitiativeDialogs').then((m) => m.DeleteInitiativeModal), { ssr: false });

const STATUSES = ['PLANNED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED'] as const;
/** Statuses that end an initiative: asked first. */
const TERMINAL = new Set<string>(['COMPLETED', 'CANCELLED']);
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

export function InitiativeDetailClient({
    orgSlug,
    canManage,
    members,
    workspaces,
    initiative,
    progress,
}: {
    orgSlug: string;
    canManage: boolean;
    members: Array<{ id: string; label: string }>;
    workspaces: Array<{ id: string; name: string }>;
    initiative: Initiative;
    progress: Progress;
}) {
    const router = useRouter();
    const t = useTranslations('org');
    const triggerUndoToast = useToastWithUndo();
    const [links, setLinks] = useState<LinkRow[]>(initiative.links);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editOpen, setEditOpen] = useState(false);
    const [linkOpen, setLinkOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [confirmStatus, setConfirmStatus] = useState<string | null>(null);
    const base = `/api/org/${orgSlug}/initiatives/${initiative.id}`;
    const statusLabel = (s: string) => (STATUS_LABEL_KEY[s] ? t(STATUS_LABEL_KEY[s]) : s);

    // A refused change says so (#4852): it used to refresh as if it had
    // worked, so nothing appeared to happen.
    const changeStatus = useCallback(
        async (status: string) => {
            setBusy(true);
            setError(null);
            try {
                const res = await fetch(`${base}/status`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status }),
                });
                if (!res.ok) {
                    setError(await failure(res, t('initiativeDetail.failedStatus')));
                    return;
                }
                router.refresh();
            } catch {
                setError(t('initiativeDetail.failedStatus'));
            } finally {
                setBusy(false);
            }
        },
        [base, router, t],
    );

    const requestStatus = (status: string) => {
        if (TERMINAL.has(status)) setConfirmStatus(status);
        else void changeStatus(status);
    };

    // Epic 67 — unlink via the undo-toast (optimistic remove + 5s window). A
    // refused DELETE puts the row back and says so (#4852).
    const unlink = (link: LinkRow) => {
        setError(null);
        setLinks((prev) => prev.filter((l) => l.id !== link.id));
        const restore = () => setLinks((prev) => (prev.some((l) => l.id === link.id) ? prev : [...prev, link]));
        triggerUndoToast({
            action: async () => {
                const res = await fetch(`${base}/links/${link.id}`, { method: 'DELETE' });
                if (!res.ok) throw new Error('unlink refused');
                router.refresh();
            },
            undoAction: restore,
            message: t('initiativeDetail.unlinkedToast', { entity: link.name ?? t(TYPE_LABEL_KEY[link.entityType] ?? 'initiativeDetail.typeItem') }),
            undoMessage: t('initiativeDetail.undo'),
            onError: () => {
                restore();
                setError(t('initiativeDetail.failedUnlink'));
            },
        });
    };

    const columns = useMemo(
        () =>
            createColumns<LinkRow>([
                {
                    accessorKey: 'entityType',
                    header: t('initiativeDetail.colType'),
                    cell: ({ row }) => (
                        <StatusBadge variant="neutral" size="sm">
                            {TYPE_LABEL_KEY[row.original.entityType] ? t(TYPE_LABEL_KEY[row.original.entityType]) : row.original.entityType}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'workspace',
                    header: t('initiativeDetail.colWorkspace'),
                    cell: ({ row }) => (
                        <span className="text-content-muted">{row.original.workspaceName ?? t('initiativeDetail.workspaceGone')}</span>
                    ),
                },
                {
                    id: 'item',
                    header: t('initiativeDetail.colEntity'),
                    cell: ({ row }) =>
                        row.original.href && row.original.name ? (
                            <Link href={row.original.href} className="font-medium text-content-emphasis hover:text-content-info hover:underline">
                                {row.original.name}
                            </Link>
                        ) : (
                            <span className="text-content-muted">{row.original.name ?? t('initiativeDetail.itemGone')}</span>
                        ),
                },
                ...(canManage
                    ? [
                          {
                              id: 'actions',
                              header: '',
                              cell: ({ row }: { row: { original: LinkRow } }) => (
                                  <Button variant="ghost" size="sm" onClick={() => unlink(row.original)}>
                                      {t('initiativeDetail.unlink')}
                                  </Button>
                              ),
                          } as ColumnDef<LinkRow>,
                      ]
                    : []),
            ]),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `unlink` closes over state setters only
        [t, canManage],
    );

    const workspaceSpan = new Set(links.map((l) => l.linkedTenantId)).size;

    return (
        <div className="space-y-section p-4">
            <Button variant="ghost" size="sm" onClick={() => router.push(`/org/${orgSlug}/initiatives`)}>
                <ChevronLeft className="w-3.5 h-3.5" /> {t('initiativeDetail.backToInitiatives')}
            </Button>

            <div className="space-y-tight">
                <div className="flex items-center gap-compact flex-wrap">
                    <Heading level={1}>{initiative.title}</Heading>
                    <StatusBadge variant={STATUS_VARIANT[initiative.status] ?? 'neutral'}>{statusLabel(initiative.status)}</StatusBadge>
                </div>
                {initiative.description && <p className="text-sm text-content-muted">{initiative.description}</p>}
                <p className="text-xs text-content-muted" data-testid="initiative-owner">
                    {initiative.ownerName
                        ? t('initiativeDetail.owner', { name: initiative.ownerName })
                        : t('initiativeDetail.noOwner')}
                    {initiative.targetDate
                        ? ` · ${t('initiativeDetail.target', { date: formatDate(new Date(initiative.targetDate)) })}`
                        : ''}
                </p>
            </div>

            <div className="space-y-tight max-w-md">
                <div className="flex items-center justify-between text-sm">
                    <span className="text-content-muted">
                        {progress.manual ? t('initiativeDetail.progressManual') : t('initiativeDetail.progressDerived')}
                    </span>
                    <span className="tabular-nums">
                        {progress.percent}%{!progress.manual && ` · ${progress.completed}/${progress.total}`}
                    </span>
                </div>
                <ProgressBar value={progress.percent} aria-label={t('initiativeDetail.progressAria')} />
            </div>

            {error && (
                <InlineNotice variant="error" icon={null}>
                    <span data-testid="initiative-error">{error}</span>
                </InlineNotice>
            )}

            {canManage && (
                <div className="space-y-default">
                    <div className="flex items-center gap-tight flex-wrap">
                        <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)} id="initiative-edit">
                            {t('initiativeDetail.edit')}
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => setLinkOpen(true)} id="initiative-link-work">
                            {t('initiativeDetail.linkWork')}
                        </Button>
                        <Button variant="ghost" size="sm" className="text-content-error" onClick={() => setDeleteOpen(true)} id="initiative-delete">
                            {t('initiativeDetail.delete')}
                        </Button>
                    </div>
                    <div className="flex items-center gap-tight flex-wrap">
                        <span className="text-sm text-content-muted">{t('initiativeDetail.setStatus')}</span>
                        {STATUSES.map((s) => (
                            <Button
                                key={s}
                                variant="secondary"
                                size="sm"
                                disabled={busy || s === initiative.status}
                                onClick={() => requestStatus(s)}
                                data-testid={`initiative-status-${s}`}
                            >
                                {statusLabel(s)}
                            </Button>
                        ))}
                    </div>
                </div>
            )}

            <div className="space-y-tight">
                <Heading level={3}>
                    {t('initiativeDetail.linkedWork')}
                    {workspaceSpan > 0 ? t('initiativeDetail.workspaceSpan', { count: workspaceSpan }) : ''}
                </Heading>
                <DataTable
                    data={links}
                    columns={columns}
                    getRowId={(r) => r.id}
                    resourceName={(plural) => (plural ? t('initiativeDetail.resourceMany') : t('initiativeDetail.resourceOne'))}
                    emptyState={
                        <TableEmptyState
                            title={t('initiativeDetail.emptyLinksTitle')}
                            description={canManage ? t('initiativeDetail.emptyLinksManage') : t('initiativeDetail.emptyLinksRead')}
                        />
                    }
                    data-testid="initiative-links-table"
                />
            </div>

            <ConfirmDialog
                showModal={confirmStatus !== null}
                setShowModal={(open) => {
                    if (!open) setConfirmStatus(null);
                }}
                tone="warning"
                title={confirmStatus ? t('initiativeDetail.confirmStatusTitle', { status: statusLabel(confirmStatus) }) : ''}
                description={t('initiativeDetail.confirmStatusBody')}
                confirmLabel={confirmStatus ? t('initiativeDetail.confirmStatusLabel', { status: statusLabel(confirmStatus) }) : ''}
                onConfirm={async () => {
                    if (confirmStatus) await changeStatus(confirmStatus);
                }}
                onCancel={() => setConfirmStatus(null)}
            />

            {editOpen && (
                <EditInitiativeSheet
                    base={base}
                    initiative={initiative}
                    members={members}
                    onClose={() => setEditOpen(false)}
                    onSaved={() => {
                        setEditOpen(false);
                        router.refresh();
                    }}
                />
            )}
            {linkOpen && (
                <LinkWorkModal
                    orgSlug={orgSlug}
                    base={base}
                    workspaces={workspaces}
                    onClose={() => setLinkOpen(false)}
                    onLinked={() => {
                        setLinkOpen(false);
                        router.refresh();
                    }}
                />
            )}
            {deleteOpen && (
                <DeleteInitiativeModal
                    base={base}
                    title={initiative.title}
                    onClose={() => setDeleteOpen(false)}
                    onDeleted={() => router.push(`/org/${orgSlug}/initiatives`)}
                />
            )}
        </div>
    );
}
