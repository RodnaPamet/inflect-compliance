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
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft } from 'lucide-react';

import { StatusBadge } from '@/components/ui/status-badge';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { DataTable, createColumns, TableEmptyState } from '@/components/ui/table';
import { useToastWithUndo } from '@/components/ui/hooks';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { AsyncCombobox, type AsyncOption } from '@/components/ui/async-combobox';
import { LazyDatePicker } from '@/app/org/[orgSlug]/(app)/initiatives/LazyDatePicker';
import { parseYMD, toYMD } from '@/components/ui/date-picker/date-utils';
import { NumberStepper } from '@/components/ui/number-stepper';
import { InlineNotice } from '@/components/ui/inline-notice';
import { formatDate } from '@inflect/ui/lib/format-date';
import { apiErrorMessage } from '@/lib/api-error';
import type { ColumnDef } from '@/components/ui/table';

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
const LINK_TYPES = ['CONTROL', 'RISK', 'TASK', 'FINDING'] as const;
const TYPE_LABEL_KEY: Record<string, string> = {
    CONTROL: 'initiativeDetail.typeControl',
    RISK: 'initiativeDetail.typeRisk',
    TASK: 'initiativeDetail.typeTask',
    FINDING: 'initiativeDetail.typeFinding',
};

type LinkRow = {
    id: string;
    entityType: string;
    entityId: string;
    linkedTenantId: string;
    workspaceName: string | null;
    name: string | null;
    href: string | null;
};
type Initiative = {
    id: string;
    title: string;
    description: string | null;
    status: string;
    ownerUserId: string | null;
    ownerName: string | null;
    targetDate: string | null;
    manualProgressPercent: number | null;
    links: LinkRow[];
};
type Progress = { percent: number; completed: number; total: number; manual: boolean };
type Option = { id: string; label?: string; name?: string };

/** The server's reason for a refused write, else this action's sentence. */
async function failure(res: Response, fallback: string): Promise<string> {
    const body = await res.json().catch(() => ({}));
    return apiErrorMessage(body, fallback);
}

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

// ─── Edit ───────────────────────────────────────────────────────────

function EditInitiativeSheet({
    base,
    initiative,
    members,
    onClose,
    onSaved,
}: {
    base: string;
    initiative: Initiative;
    members: Array<{ id: string; label: string }>;
    onClose: () => void;
    onSaved: () => void;
}) {
    const t = useTranslations('org');
    const [title, setTitle] = useState(initiative.title);
    const [description, setDescription] = useState(initiative.description ?? '');
    const [ownerUserId, setOwnerUserId] = useState(initiative.ownerUserId ?? '');
    const [targetDate, setTargetDate] = useState(initiative.targetDate ? initiative.targetDate.slice(0, 10) : '');
    const [manual, setManual] = useState(initiative.manualProgressPercent !== null);
    const [percent, setPercent] = useState(initiative.manualProgressPercent ?? 0);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ownerOptions = useMemo<ComboboxOption[]>(() => members.map((m) => ({ value: m.id, label: m.label })), [members]);
    const progressOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: 'derived', label: t('initiativeDetail.progressFromLinks') },
            { value: 'manual', label: t('initiativeDetail.progressByHand') },
        ],
        [t],
    );

    const save = async () => {
        if (!title.trim()) {
            setError(t('initiatives.titleRequired'));
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(base, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    description: description || null,
                    ownerUserId: ownerUserId || null,
                    targetDate: targetDate || null,
                    manualProgressPercent: manual ? percent : null,
                }),
            });
            if (!res.ok) {
                setError(await failure(res, t('initiativeDetail.failedSave')));
                return;
            }
            onSaved();
        } catch {
            setError(t('initiativeDetail.failedSave'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
            <Sheet.Header title={t('initiativeDetail.editTitle')} />
            <Sheet.Body>
                <div className="space-y-default" data-testid="initiative-edit-form">
                    <FormField label={t('initiatives.titleLabel')} required>
                        <Input id="initiative-edit-title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
                    </FormField>
                    <FormField label={t('initiatives.descriptionLabel')}>
                        <Textarea id="initiative-edit-description" rows={3} maxLength={8000} value={description} onChange={(e) => setDescription(e.target.value)} />
                    </FormField>
                    <FormField label={t('initiatives.ownerLabel')} description={t('initiatives.ownerHint')}>
                        <Combobox
                            id="initiative-edit-owner"
                            options={ownerOptions}
                            selected={ownerOptions.find((o) => o.value === ownerUserId) ?? null}
                            setSelected={(opt) => setOwnerUserId(opt?.value ?? '')}
                            placeholder={t('initiatives.noOwner')}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                        />
                    </FormField>
                    <FormField label={t('initiatives.targetLabel')} description={t('initiatives.targetHint')}>
                        <LazyDatePicker
                            id="initiative-edit-target"
                            className="w-full"
                            clearable
                            align="start"
                            value={parseYMD(targetDate)}
                            onChange={(next) => setTargetDate(toYMD(next) ?? '')}
                            aria-label={t('initiatives.targetLabel')}
                        />
                    </FormField>
                    <FormField label={t('initiativeDetail.progressLabel')} description={t('initiativeDetail.progressHint')}>
                        <Combobox
                            hideSearch
                            id="initiative-edit-progress-mode"
                            options={progressOptions}
                            selected={progressOptions.find((o) => o.value === (manual ? 'manual' : 'derived')) ?? null}
                            setSelected={(opt) => setManual(opt?.value === 'manual')}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full', 'aria-label': t('initiativeDetail.progressLabel') }}
                        />
                    </FormField>
                    {manual && (
                        <NumberStepper
                            id="initiative-edit-percent"
                            value={percent}
                            onChange={setPercent}
                            min={0}
                            max={100}
                            step={5}
                            ariaLabel={t('initiativeDetail.percentLabel')}
                            formatValue={(v) => `${v}%`}
                        />
                    )}
                    {error && (
                        <p className="text-sm text-content-error" role="alert" data-testid="initiative-edit-error">
                            {error}
                        </p>
                    )}
                </div>
            </Sheet.Body>
            <Sheet.Actions>
                <Button variant="ghost" onClick={onClose} disabled={saving}>
                    {t('common.cancel')}
                </Button>
                <Button variant="primary" onClick={save} disabled={saving} loading={saving} id="initiative-edit-save">
                    {t('initiativeDetail.save')}
                </Button>
            </Sheet.Actions>
        </Sheet>
    );
}

// ─── Link work ──────────────────────────────────────────────────────

function LinkWorkModal({
    orgSlug,
    base,
    workspaces,
    onClose,
    onLinked,
}: {
    orgSlug: string;
    base: string;
    workspaces: Array<{ id: string; name: string }>;
    onClose: () => void;
    onLinked: () => void;
}) {
    const t = useTranslations('org');
    const [tenantId, setTenantId] = useState('');
    const [entityType, setEntityType] = useState<string>('CONTROL');
    const [entityId, setEntityId] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const workspaceOptions = useMemo<ComboboxOption[]>(() => workspaces.map((w) => ({ value: w.id, label: w.name })), [workspaces]);
    const typeOptions = useMemo<ComboboxOption[]>(
        () => LINK_TYPES.map((ty) => ({ value: ty, label: t(TYPE_LABEL_KEY[ty]) })),
        [t],
    );

    const search = useCallback(
        async (query: string, signal: AbortSignal): Promise<AsyncOption[]> => {
            if (!tenantId) return [];
            const params = new URLSearchParams({ tenantId, type: entityType, q: query });
            const res = await fetch(`/api/org/${orgSlug}/initiatives/link-candidates?${params.toString()}`, { signal });
            if (!res.ok) return [];
            const data = (await res.json()) as { candidates: Option[] };
            return data.candidates.map((c) => ({ value: c.id, label: c.name ?? c.id }));
        },
        [orgSlug, tenantId, entityType],
    );

    const link = async () => {
        if (!tenantId || !entityId) return;
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`${base}/links`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenantId, entityType, entityId }),
            });
            if (!res.ok) {
                setError(await failure(res, t('initiativeDetail.failedLink')));
                return;
            }
            onLinked();
        } catch {
            setError(t('initiativeDetail.failedLink'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal showModal setShowModal={(o) => (o ? null : onClose())}>
            <Modal.Header title={t('initiativeDetail.linkWorkTitle')} />
            <Modal.Body>
                <div className="space-y-default" data-testid="initiative-link-form">
                    <FormField label={t('initiativeDetail.workspaceLabel')} required>
                        <Combobox
                            id="initiative-link-workspace"
                            options={workspaceOptions}
                            selected={workspaceOptions.find((o) => o.value === tenantId) ?? null}
                            setSelected={(opt) => {
                                setTenantId(opt?.value ?? '');
                                setEntityId(null);
                            }}
                            placeholder={t('initiativeDetail.workspacePlaceholder')}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full', 'aria-label': t('initiativeDetail.workspaceLabel') }}
                        />
                    </FormField>
                    <FormField label={t('initiativeDetail.typeLabel')} required>
                        <Combobox
                            hideSearch
                            id="initiative-link-type"
                            options={typeOptions}
                            selected={typeOptions.find((o) => o.value === entityType) ?? null}
                            setSelected={(opt) => {
                                setEntityType(opt?.value ?? 'CONTROL');
                                setEntityId(null);
                            }}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full', 'aria-label': t('initiativeDetail.typeLabel') }}
                        />
                    </FormField>
                    <FormField label={t('initiativeDetail.itemLabel')} required description={tenantId ? undefined : t('initiativeDetail.itemNeedsWorkspace')}>
                        <AsyncCombobox
                            // A new workspace or type is a new search.
                            key={`${tenantId}:${entityType}`}
                            id="initiative-link-item"
                            value={entityId}
                            onChange={(opt) => setEntityId(opt?.value ?? null)}
                            onSearch={search}
                            disabled={!tenantId}
                            placeholder={t('initiativeDetail.itemPlaceholder')}
                            searchPlaceholder={t('initiativeDetail.itemSearch')}
                            matchTriggerWidth
                        />
                    </FormField>
                    {error && (
                        <p className="text-sm text-content-error" role="alert" data-testid="initiative-link-error">
                            {error}
                        </p>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        {t('common.cancel')}
                    </Button>
                    <Button variant="primary" onClick={link} disabled={saving || !tenantId || !entityId} loading={saving} id="initiative-link-submit">
                        {t('initiativeDetail.linkWork')}
                    </Button>
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}

// ─── Delete ─────────────────────────────────────────────────────────

/**
 * A typed confirmation, as a workspace's: deleting an initiative removes it
 * and its links for everybody, with no undo (owner decision, 2026-11-01).
 */
function DeleteInitiativeModal({
    base,
    title,
    onClose,
    onDeleted,
}: {
    base: string;
    title: string;
    onClose: () => void;
    onDeleted: () => void;
}) {
    const t = useTranslations('org');
    const [typed, setTyped] = useState('');
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const confirmDelete = async () => {
        setDeleting(true);
        setError(null);
        try {
            const res = await fetch(base, { method: 'DELETE' });
            if (!res.ok) {
                setError(await failure(res, t('initiativeDetail.failedDelete')));
                return;
            }
            onDeleted();
        } catch {
            setError(t('initiativeDetail.failedDelete'));
        } finally {
            setDeleting(false);
        }
    };

    return (
        <Modal showModal setShowModal={(o) => (o ? null : onClose())}>
            <Modal.Header title={t('initiativeDetail.deleteTitle')} />
            <Modal.Body>
                <div className="space-y-default" data-testid="initiative-delete-form">
                    <p className="text-sm text-content-default">{t('initiativeDetail.deleteBody', { title })}</p>
                    <FormField label={t('initiativeDetail.typeToConfirm', { title })} required>
                        <Input id="initiative-delete-confirm-input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
                    </FormField>
                    {error && (
                        <p className="text-sm text-content-error" role="alert" data-testid="initiative-delete-error">
                            {error}
                        </p>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button variant="ghost" onClick={onClose} disabled={deleting}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={confirmDelete}
                        disabled={deleting || typed.trim() !== title.trim()}
                        loading={deleting}
                        id="initiative-delete-confirm"
                    >
                        {t('initiativeDetail.deleteConfirm')}
                    </Button>
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}
