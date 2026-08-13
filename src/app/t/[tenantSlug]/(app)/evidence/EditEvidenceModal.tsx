'use client';

/**
 * B5 — Evidence edit modal.
 *
 * Pre-B5 evidence rows could not be edited after creation through
 * the UI — the `updateEvidence` usecase + the
 * `PATCH /api/t/:slug/evidence/:id` route both existed but no
 * client surface called them.
 *
 * Mirrors the canonical modal-form shape (NewVendorModal +
 * NewAssetModal) — wraps the existing `<Modal>` shell with a
 * disabled-while-submitting fieldset and an unsaved-changes guard
 * on close.
 *
 * EP-3 — the singular control link became a many-to-many join. The
 * control field is now a `<Combobox multiple>` seeded from the
 * evidence's linked controls; on save the PUT body carries
 * `controlIds: string[]` (the usecase reconciles adds/removes).
 * Category is editable here too, and file-type evidence gains a
 * "Replace file" affordance.
 */
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react';
import { useTranslations } from 'next-intl';
import { isEvidenceContentEditable } from '@/lib/evidence-content';
import { apiErrorMessage } from '@/lib/api-error';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { UserCombobox } from '@/components/ui/user-combobox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

interface ControlOption {
    id: string;
    name: string;
    code?: string | null;
    annexId?: string | null;
}

/** Shared shape passed into the modal to seed the edit form. */
export interface EditEvidenceInitial {
    id: string;
    title: string;
    /**
     * The evidence body. This is `Evidence.content` — the modal used to
     * carry a `description`, which is not a column on the model, so the
     * form opened blank and the save was discarded by the schema's
     * `.strip()`. Only editable for TEXT/LINK; see @/lib/evidence-content.
     */
    content: string | null;
    ownerUserId: string | null;
    /** EP-3 — the controls this evidence currently satisfies. */
    controlLinks: ControlOption[];
    /** EP-3 — persisted classification. */
    category: string | null;
    /** B8 follow-up — current folder label (null = unfoldered). */
    folder?: string | null;
    /** Current tags (normalised, lower-cased). */
    tags?: string[];
    /** Retention date (ISO) — edited here now (was inline in the table). */
    retentionUntil?: string | null;
    /** EvidenceType — gates the "Replace file" affordance. */
    type: string;
    /** Linked file record id (present for FILE-type evidence). */
    fileRecordId?: string | null;
}

export interface EditEvidenceModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    /** Full control list for the tenant — powers the multi-select options. */
    controls: ControlOption[];
    initial: EditEvidenceInitial | null;
    onSaved?: () => void;
}

function controlLabel(c: ControlOption): string {
    return `${c.annexId || c.code || 'Custom'}: ${c.name}`;
}

export function EditEvidenceModal({
    open,
    setOpen,
    tenantSlug,
    controls,
    initial,
    onSaved,
}: EditEvidenceModalProps) {
    const apiUrl = useTenantApiUrl();
    const t = useTranslations('evidence');
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    // Comma-separated in the input; normalised to an array on submit.
    const [tagsInput, setTagsInput] = useState('');
    /** Did the caller seed `initial.tags`? See the reset effect below. */
    const [tagsSeeded, setTagsSeeded] = useState(false);
    // FILE evidence stores its object-storage pathKey in `content`, so the
    // body field is hidden AND withheld from the PUT for that type.
    const contentEditable = isEvidenceContentEditable(initial?.type);
    const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
    // EP-3 — multi-select control links.
    const [selectedControls, setSelectedControls] = useState<
        ComboboxOption<ControlOption>[]
    >([]);
    // EP-3 — editable category.
    const [category, setCategory] = useState('');
    // B8 follow-up — folder is editable post-create.
    const [folder, setFolder] = useState('');
    // Retention date — moved here from the inline table column. Held as a
    // YMD string; the initial value is remembered so we only hit the
    // retention endpoint when it actually changes.
    const [retentionDate, setRetentionDate] = useState('');
    const [initialRetention, setInitialRetention] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isDirty, setIsDirty] = useState(false);
    // PART 4 — replace-file affordance (FILE-type evidence only).
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [replacing, setReplacing] = useState(false);

    const controlOptions = useMemo<ComboboxOption<ControlOption>[]>(
        () =>
            controls.map((c) => ({
                value: c.id,
                label: controlLabel(c),
                meta: c,
            })),
        [controls],
    );

    // Seed from `initial` when the modal opens; reset dirty + error
    // each time so a re-open after cancel reads clean.
    useEffect(() => {
        if (open && initial) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setTitle(initial.title);
            setContent(initial.content ?? '');
            setTagsInput((initial.tags ?? []).join(', '));
            // Whether the CALLER told us the current tags at all. `tags` is
            // optional on `EditEvidenceInitial`, so a seed site that omits it
            // type-checks — and this field then renders empty, which is
            // indistinguishable from "this evidence has no tags".
            //
            // The payload reconciles tags to exactly what it sends, so an
            // unseeded modal used to submit `[]` and delete every tag on the
            // row. Tracking seeded-ness lets the submit omit the field
            // entirely when we were never told, which the usecase treats as
            // "leave tags alone" (`if (data.tags !== undefined)`).
            setTagsSeeded(initial.tags !== undefined);
            setOwnerUserId(initial.ownerUserId);
            // Prefer the shared option (stable label) but fall back to a
            // synthesised option so a control missing from the loaded
            // list still renders a chip.
            setSelectedControls(
                (initial.controlLinks ?? []).map((c) => {
                    const found = controlOptions.find((o) => o.value === c.id);
                    return (
                        found ?? { value: c.id, label: controlLabel(c), meta: c }
                    );
                }),
            );
            setCategory(initial.category ?? '');
            setFolder(initial.folder ?? '');
            const ymd = initial.retentionUntil ? initial.retentionUntil.split('T')[0] : '';
            setRetentionDate(ymd);
            setInitialRetention(ymd);
            setSubmitting(false);
            setReplacing(false);
            setError(null);
            setIsDirty(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, initial]);

    const canSubmit = title.trim().length > 0 && !submitting;

    const submit = async () => {
        if (!initial) return;
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(apiUrl(`/evidence/${initial.id}`), {
                // The tenant evidence route exposes PUT (not PATCH) for
                // metadata updates; a PATCH 405'd, surfacing as the
                // generic "Failed to update evidence" on every save.
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    // Only send the body when this type owns it. For FILE
                    // evidence `content` is the storage pathKey — sending
                    // the (hidden, empty) field would detach the file.
                    ...(contentEditable ? { content: content || null } : {}),
                    // Reconciled server-side to exactly this set; the
                    // repository normalises (trim + lower-case). Sent ONLY
                    // when the caller seeded the current tags — omitting the
                    // key leaves them untouched, whereas sending `[]` from a
                    // modal that was never told the current set deletes them.
                    ...(tagsSeeded
                        ? {
                              tags: tagsInput
                                  .split(',')
                                  .map((t) => t.trim())
                                  .filter(Boolean),
                          }
                        : {}),
                    ownerUserId: ownerUserId || null,
                    // EP-3 — reconcile the whole link set. Never send the
                    // legacy singular `controlId`.
                    controlIds: selectedControls.map((o) => o.value),
                    category: category.trim() || null,
                    // B8 follow-up — empty string clears the folder
                    // (the usecase null-coerces); a non-empty value
                    // sets it. `undefined` would skip the update.
                    folder: folder.trim() || null,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setError(apiErrorMessage(err, t('edit.updateFailed')));
                return;
            }
            // Retention moved into this modal — persist via the dedicated
            // retention endpoint, but only when the date actually changed.
            if (retentionDate !== initialRetention) {
                const rr = await fetch(apiUrl(`/evidence/${initial.id}/retention`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        retentionUntil: retentionDate
                            ? new Date(retentionDate).toISOString()
                            : null,
                        retentionPolicy: retentionDate ? 'FIXED_DATE' : 'NONE',
                    }),
                });
                if (!rr.ok) {
                    const err = await rr.json().catch(() => ({}));
                    setError(apiErrorMessage(err, t('edit.retentionFailed')));
                    return;
                }
            }
            setIsDirty(false);
            setOpen(false);
            onSaved?.();
        } finally {
            setSubmitting(false);
        }
    };

    // PART 4 — replace the backing file of a FILE-type evidence record.
    const handleReplaceFile = async (file: File) => {
        if (!initial) return;
        setReplacing(true);
        setError(null);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await fetch(apiUrl(`/evidence/${initial.id}/replace`), {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                setError(apiErrorMessage(err, t('edit.replaceFailed')));
                return;
            }
            onSaved?.();
            setOpen(false);
        } catch {
            setError(t('edit.replaceFailed'));
        } finally {
            setReplacing(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const busy = submitting || replacing;

    const guardedSetOpen = useCallback<Dispatch<SetStateAction<boolean>>>(
        (next) => {
            const wantClose =
                typeof next === 'function' ? !next(true) : next === false;
            if (wantClose) {
                if (busy) return;
                if (
                    isDirty &&
                    !window.confirm(t('edit.discardConfirm'))
                ) {
                    return;
                }
            }
            setOpen(next);
        },
        [busy, isDirty, setOpen, t],
    );
    const close = () => guardedSetOpen(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        void submit();
    };

    const markDirty = () => setIsDirty(true);

    return (
        <Modal
            showModal={open}
            setShowModal={guardedSetOpen}
            size="lg"
            title={t('edit.title')}
            description={t('edit.description')}
            preventDefaultClose={busy}
        >
            <Modal.Header
                title={t('edit.title')}
                description={t('edit.description')}
            />
            <Modal.Form id="edit-evidence-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="edit-evidence-error"
                            role="alert"
                        >
                            {error}
                        </div>
                    )}
                    <fieldset
                        disabled={submitting}
                        className="m-0 p-0 border-0 space-y-default"
                    >
                        <FormField label={t('edit.titleLabel')} required>
                            <Input
                                id="edit-evidence-title-input"
                                value={title}
                                onChange={(e) => {
                                    setTitle(e.target.value);
                                    markDirty();
                                }}
                                required
                            />
                        </FormField>
                        {/* Body. Hidden for FILE evidence, whose `content`
                            is the internal storage pathKey rather than
                            anything a user wrote. */}
                        {contentEditable && (
                        <FormField label={t('edit.descriptionLabel')}>
                            <Textarea
                                id="edit-evidence-description"
                                className="h-24"
                                value={content}
                                onChange={(e) => {
                                    setContent(e.target.value);
                                    markDirty();
                                }}
                            />
                        </FormField>
                        )}
                        <FormField
                            label={t('edit.tagsLabel')}
                            description={t('edit.tagsDesc')}
                        >
                            <Input
                                id="edit-evidence-tags"
                                type="text"
                                value={tagsInput}
                                placeholder={t('edit.tagsPlaceholder')}
                                onChange={(e) => {
                                    setTagsInput(e.target.value);
                                    markDirty();
                                }}
                                autoComplete="off"
                            />
                        </FormField>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                            <FormField label={t('edit.ownerLabel')}>
                                <UserCombobox
                                    id="edit-evidence-owner-input"
                                    name="ownerUserId"
                                    tenantSlug={tenantSlug}
                                    selectedId={ownerUserId}
                                    onChange={(userId) => {
                                        setOwnerUserId(userId ?? null);
                                        markDirty();
                                    }}
                                    placeholder={t('edit.unassigned')}
                                />
                            </FormField>
                            {/* EP-3 — editable category. */}
                            <FormField label={t('edit.categoryLabel')}>
                                <Input
                                    id="edit-evidence-category-input"
                                    value={category}
                                    onChange={(e) => {
                                        setCategory(e.target.value);
                                        markDirty();
                                    }}
                                    placeholder={t('edit.categoryPlaceholder')}
                                />
                            </FormField>
                        </div>
                        {/* EP-3 — multi-select control links. Sends
                            `controlIds` on save; the usecase reconciles
                            the add/remove diff. */}
                        <FormField
                            label={t('edit.controlsLabel')}
                            description={t('edit.controlsDesc')}
                        >
                            <Combobox<true, ControlOption>
                                multiple
                                id="edit-evidence-control-input"
                                name="controlIds"
                                options={controlOptions}
                                selected={selectedControls}
                                setSelected={(opts) => {
                                    setSelectedControls(opts);
                                    markDirty();
                                }}
                                placeholder={t('edit.controlsPlaceholder')}
                                searchPlaceholder={t('edit.controlsSearchPlaceholder')}
                                emptyState={t('edit.controlsEmpty')}
                                matchTriggerWidth
                                forceDropdown
                                buttonProps={{ className: 'w-full' }}
                                caret
                            />
                        </FormField>
                        {/* B8 follow-up — folder is editable post-
                            create. Clearing the field re-files the
                            evidence as unfoldered. */}
                        <FormField label={t('edit.folderLabel')}>
                            <Input
                                id="edit-evidence-folder-input"
                                data-testid="edit-evidence-folder-input"
                                value={folder}
                                onChange={(e) => {
                                    setFolder(e.target.value);
                                    markDirty();
                                }}
                                placeholder={t('edit.folderPlaceholder')}
                            />
                        </FormField>
                        {/* Retention date — moved here from the inline
                            table column. Clearing it sets the policy back
                            to NONE. */}
                        <FormField
                            label={t('edit.retentionLabel')}
                            description={t('edit.retentionDesc')}
                        >
                            <DatePicker
                                id="edit-evidence-retention-input"
                                className="w-full"
                                placeholder={t('edit.retentionPlaceholder')}
                                clearable
                                align="start"
                                value={parseYMD(retentionDate)}
                                onChange={(next) => {
                                    setRetentionDate(toYMD(next) ?? '');
                                    markDirty();
                                }}
                                disabledDays={{ before: startOfUtcDay(new Date()) }}
                                aria-label={t('edit.retentionAria')}
                            />
                        </FormField>
                    </fieldset>
                    {/* PART 4 — replace the backing file. FILE-type
                        evidence only. Sits outside the main fieldset so
                        it stays actionable even while a metadata save is
                        in flight would be wrong — it shares the busy
                        gate below instead. */}
                    {initial?.type === 'FILE' && (
                        <div className="mt-default border-t border-border-subtle pt-default">
                            <FormField
                                label={t('edit.replaceFileLabel')}
                                description={t('edit.replaceFileDesc')}
                            >
                                <div className="flex items-center gap-default">
                                    <input
                                        ref={fileInputRef}
                                        id="edit-evidence-replace-input"
                                        type="file"
                                        className="input w-full"
                                        disabled={busy}
                                        onChange={(e) => {
                                            const f = e.target.files?.[0];
                                            if (f) void handleReplaceFile(f);
                                        }}
                                    />
                                    {replacing && (
                                        <span className="shrink-0 text-xs text-content-muted">
                                            {t('edit.replacing')}
                                        </span>
                                    )}
                                </div>
                            </FormField>
                        </div>
                    )}
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={close}
                        disabled={busy}
                        id="edit-evidence-cancel-btn"
                    >
                        {t('edit.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={!canSubmit || replacing}
                        id="edit-evidence-submit-btn"
                    >
                        {submitting ? t('edit.saving') : t('edit.save')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
