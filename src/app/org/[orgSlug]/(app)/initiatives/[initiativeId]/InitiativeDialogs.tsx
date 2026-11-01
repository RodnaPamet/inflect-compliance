'use client';

/**
 * The initiative page's dialogs (#4852): Edit, Link work and Delete. Loaded
 * lazily by InitiativeDetailClient, which opens with all three closed.
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Sheet } from '@/components/ui/sheet';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { AsyncCombobox, type AsyncOption } from '@/components/ui/async-combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { parseYMD, toYMD } from '@/components/ui/date-picker/date-utils';
import { NumberStepper } from '@/components/ui/number-stepper';
import { LINK_TYPES, TYPE_LABEL_KEY, failure, type Initiative, type Option } from './initiative-shared';

// ─── Edit ───────────────────────────────────────────────────────────

export function EditInitiativeSheet({
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
                        <DatePicker
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

export function LinkWorkModal({
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
export function DeleteInitiativeModal({
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
