'use client';

/**
 * Epic 43.1 — Evidence upload modal (multi-file dropzone).
 *
 * Builds on the Epic 54 modal shape but swaps the single-file
 * `<FileUpload>` primitive for the new generic `<FileDropzone>` from
 * `@/components/ui/FileDropzone`. The dropzone supports drag-and-drop,
 * click-to-browse, multi-file selection, and a per-file progress bar
 * driven by `XMLHttpRequest.upload.onprogress` (fetch can't surface
 * upload progress on any mainstream browser today).
 *
 * Business contract is preserved byte-for-byte:
 *   - `POST /api/t/:slug/evidence/uploads` with `FormData` carrying
 *     `file`, `title?`, `controlId?`. Each queued file is uploaded
 *     individually; the same metadata fields apply to every file in
 *     the batch.
 *   - Optimistic pending row inserted into the SWR cache for
 *     `CACHE_KEYS.evidence.list()` while each upload is in flight
 *     (Epic 69 — `useTenantMutation` handles the rollback on
 *     throw automatically; the temp row sticks until the
 *     post-success revalidation overwrites the cache with the
 *     authoritative server-side list).
 *   - Follow-up `POST /evidence/:id/retention` when a retention date
 *     is supplied (per uploaded evidence record).
 *   - Sibling filter variants (`/evidence?type=…`, `/evidence?status=…`,
 *     etc.) get a parallel background refetch via the function-form
 *     `swrMutate(matcher, …)` after each successful upload so the
 *     "Expiring" / "Archived" tabs and any filtered view refresh.
 *
 * E2E selectors preserved:
 *   - `#upload-form`, `#upload-evidence-cancel-btn`, `#submit-upload-btn`,
 *     `#file-input`, `#upload-title-input`, `#control-select`,
 *     `#retention-date-input`, `#upload-error`. The dropzone forwards
 *     `inputId="file-input"` so `setInputFiles('#file-input', …)`
 *     keeps working unchanged.
 *
 * The modal is intentionally submit-driven: drops queue files in the
 * dropzone, the operator fills metadata, clicks "Upload", and the
 * dropzone's imperative `startAll()` runs each upload sequentially.
 * Auto-start UX (drop → upload immediately) is left to a future
 * lighter-weight surface (e.g. a list-page bulk-upload tray); the
 * modal preserves the form-shaped flow operators are used to.
 */

import { useSWRConfig } from 'swr';
import { applyEvidenceRetention, applyEvidenceRetentionBatch } from '@/lib/evidence-retention-request';
import {
    SharePointFilePicker,
    type SpPickedItem,
} from '@/components/integrations/sharepoint/SharePointFilePicker';
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
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import {
    FileDropzone,
    type FileDropzoneHandle,
    type FileUploadEntry,
} from '@/components/ui/FileDropzone';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { RequiredMarker } from '@/components/ui/required-marker';
import { InfoTooltip } from '@/components/ui/tooltip';
import { InlineNotice } from '@/components/ui/inline-notice';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import type { CappedList } from '@/lib/list-backfill-cap';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';
import {
    uploadWithProgress,
    UploadHttpError,
} from '@/lib/upload/upload-with-progress';

// ─── Constraints ────────────────────────────────────────────────────
// 25 MB per file — generous enough for a signed PDF or scanned policy
// pack, still small enough to surface oversized uploads client-side
// before we burn bandwidth on a 4xx round-trip. Server-side still
// enforces the canonical limit.
const MAX_FILE_SIZE_MB = 25;

const EVIDENCE_ACCEPT =
    '.pdf,.jpg,.jpeg,.png,.gif,.webp,.csv,.txt,.doc,.docx,.xlsx,.xls,.json,.zip';

// ─── Types ──────────────────────────────────────────────────────────

interface ControlOption {
    id: string;
    name: string;
    code?: string | null;
    annexId?: string | null;
}

export interface UploadEvidenceModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    apiUrl: (path: string) => string;
    controls: ControlOption[];
}

// ─── Component ──────────────────────────────────────────────────────

export function UploadEvidenceModal({
    open,
    setOpen,

    tenantSlug: _tenantSlug,
    apiUrl,
    controls,
}: UploadEvidenceModalProps) {
    const tx = useTranslations('evidence');
    const close = useCallback(() => setOpen(false), [setOpen]);
    const { mutate: swrMutate } = useSWRConfig();
    const dropzoneRef = useRef<FileDropzoneHandle>(null);

    const [title, setTitle] = useState('');
    const [controlId, setControlId] = useState('');
    // EP-3 — free-text category applied to every file in the batch.
    const [category, setCategory] = useState('');
    // B8 follow-up — free-text folder label applied to every file
    // in the upload batch. Datalist below seeds it with values
    // already in use on existing evidence.
    const [folder, setFolder] = useState('');
    const [retentionUntil, setRetentionUntil] = useState('');
    const [error, setError] = useState('');
    const [queuedCount, setQueuedCount] = useState(0);
    const [uploadingAll, setUploadingAll] = useState(false);
    // SP-3 — SharePoint import. spConnId is the first available connection
    // (null = SharePoint not connected → the button stays hidden).
    const [spConnId, setSpConnId] = useState<string | null>(null);
    const [spPickerOpen, setSpPickerOpen] = useState(false);
    // EP-4 — distinguish "not connected" (probe OK, zero connections → button
    // stays hidden, the expected case) from "probe errored" (fetch threw or a
    // non-ok status). A swallowed probe error used to be indistinguishable
    // from not-connected — the button just silently never appeared. Now a
    // probe error surfaces an inline notice so the user knows the connection
    // check itself failed rather than assuming SharePoint isn't set up.
    const [spProbeError, setSpProbeError] = useState(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/integrations/sharepoint/connections'));
                if (!res.ok) {
                    if (!cancelled) setSpProbeError(true);
                    return;
                }
                const conns = (await res.json()) as Array<{ id: string }>;
                if (!cancelled) {
                    setSpConnId(conns[0]?.id ?? null);
                    setSpProbeError(false);
                }
            } catch {
                // Client component — no console (a guard bans it); surface the
                // failed connection check as UI state instead of swallowing it.
                if (!cancelled) setSpProbeError(true);
            }
        })();
        return () => { cancelled = true; };
    }, [open, apiUrl]);

    const handleSpImport = useCallback(
        async (items: SpPickedItem[]) => {
            if (!spConnId || items.length === 0) return;
            try {
                const res = await fetch(apiUrl('/integrations/sharepoint/import'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // Category, Folder and Retention are rendered above and
                    // were all dropped on this branch: the user filled them
                    // in, imported, and the values vanished with no warning.
                    // `category` was already accepted end-to-end by the route
                    // and the importer — it was simply never sent. `folder`
                    // needed the route schema widened to match
                    // `uploadEvidenceFile`, which has always taken it.
                    body: JSON.stringify({
                        connectionId: spConnId,
                        items: items.map((i) => ({ driveId: i.driveId, itemId: i.itemId, name: i.name })),
                        controlId: controlId || undefined,
                        category: category.trim() || undefined,
                        folder: folder.trim() || undefined,
                    }),
                });
                if (!res.ok) {
                    setError(tx('upload.spImportFailed'));
                    return;
                }
                // Retention is not part of the import contract — it is a
                // second write per row, exactly as on the dropzone path. The
                // route already returns the ids it created, so apply it here
                // rather than widening the import to do N writes server-side.
                //
                // A partial failure REVALIDATES and stays open with the
                // error: the rows exist and are worth showing, but reporting
                // plain success over a missing retention date is the defect
                // this whole change is about.
                const created = (await res.json().catch(() => null)) as
                    | { evidenceIds?: string[] }
                    | null;
                const prefix = apiUrl(CACHE_KEYS.evidence.list());
                if (retentionUntil && created?.evidenceIds?.length) {
                    try {
                        await applyEvidenceRetentionBatch(
                            apiUrl,
                            created.evidenceIds,
                            retentionUntil,
                        );
                    } catch {
                        await swrMutate((key) => typeof key === 'string' && key.startsWith(prefix));
                        setError(tx('upload.spImportRetentionFailed'));
                        return;
                    }
                }
                await swrMutate((key) => typeof key === 'string' && key.startsWith(prefix));
                setOpen(false);
            } catch {
                setError(tx('upload.spImportFailedNet'));
            }
        },
        [apiUrl, spConnId, controlId, category, folder, retentionUntil, tx, swrMutate, setOpen],
    );

    // Reset on every open so a previous cancel doesn't leak state.
    useEffect(() => {
        if (!open) return;
        setTitle('');
        setControlId('');
        setCategory('');
        setFolder('');
        setRetentionUntil('');
        setError('');
        setQueuedCount(0);
        setUploadingAll(false);
        setSpProbeError(false);
    }, [open]);

    // Project controls into ComboboxOption shape. The annexId + code +
    // name are all folded into the label so cmdk's fuzzy-match scoring
    // hits on any of them — typing "A.5.1" or "access review" or the
    // raw control code all filter to the same row.
    const controlOptions = useMemo<ComboboxOption<ControlOption>[]>(
        () =>
            controls.map((c) => ({
                value: c.id,
                label: `${c.annexId || c.code || 'Custom'}: ${c.name}`,
                meta: c,
            })),
        [controls],
    );

    const telemetry = useFormTelemetry('UploadEvidenceModal');

    // ─── Mutation: per-file upload (Epic 69 — useTenantMutation) ───
    //
    // Migrated from React Query's `useMutation` + `onMutate` /
    // `onError` rollback hooks. The Epic 69 hook handles three of
    // the four lifecycle concerns (optimistic apply, rollback on
    // throw, post-success revalidation) automatically — the only
    // thing this file still owns is the temp-row shape.
    //
    // Why the unfiltered list key: multiple cache entries can exist
    // (one per filter combo), but new uploads always land in the
    // unfiltered baseline. The optimistic-prepend lands there and
    // stays visible to the user; sibling filter variants get a
    // background refetch via `swrMutate(matcher)` after `trigger()`
    // resolves so they pick the new row up too.
    //
    // The actual HTTP work is `uploadWithProgress` (XMLHttpRequest)
    // so the dropzone's progress bar updates from real network
    // events — `fetch` can't surface upload progress.
    const evidenceListKey = CACHE_KEYS.evidence.list();
    const evidenceUrlPrefix = apiUrl(evidenceListKey);

    interface UploadVars {
        file: File;
        applyTitle: boolean;
        controlId: string;
        /** EP-3 — category applied to every uploaded file. */
        category: string;
        /** B8 follow-up — folder label applied to every uploaded file. */
        folder: string;
        retentionUntil: string;
        onProgress: (percent: number | null) => void;
        signal: AbortSignal;
        tempId: string;
    }

    const mutation = useTenantMutation<CappedList<unknown>, UploadVars, { id?: string }>({
        key: evidenceListKey,
        mutationFn: async (vars) => {
            const { file, applyTitle, onProgress, signal } = vars;
            const formData = new FormData();
            formData.append('file', file);
            // Apply the title input only when uploading a single file
            // (multi-file uploads just take the filename — different
            // titles would all land on the same string otherwise).
            if (applyTitle && title) formData.append('title', title);
            if (vars.controlId) formData.append('controlId', vars.controlId);
            // EP-3 — category rides every uploaded row in the batch.
            if (vars.category) formData.append('category', vars.category.trim());
            // B8 follow-up — folder rides every uploaded row in the
            // batch. The /uploads route forwards it to createEvidence.
            if (vars.folder) formData.append('folder', vars.folder.trim());

            const uploaded = await uploadWithProgress<{ id?: string }>(
                apiUrl('/evidence/uploads'),
                formData,
                {
                    onProgress: (p) => onProgress(p.percent),
                    signal,
                },
            );

            // Retention is a SECOND write and can fail on its own. This
            // fired and never read the response, so a non-ok reply was
            // swallowed: the dropzone reported success and the modal closed
            // over a row with no retention on it and no reason given.
            // `applyEvidenceRetention` throws instead, which surfaces the
            // partial save through the dropzone's existing error path.
            if (vars.retentionUntil && uploaded?.id) {
                await applyEvidenceRetention(
                    apiUrl,
                    uploaded.id,
                    vars.retentionUntil,
                    { signal },
                );
            }

            return uploaded;
        },
        // Optimistic pending row prepended to the list. Identical
        // shape to the legacy single-file flow so every column
        // renderer (status badge, retention pill, file-type icon)
        // works without special-casing. The temp row sticks until
        // the post-success revalidation overwrites the cache with
        // the authoritative server-side list.
        optimisticUpdate: (current, vars) => {
            const pendingRow = {
                id: vars.tempId,
                title:
                    vars.applyTitle && title ? title : vars.file.name,
                fileName: vars.file.name,
                fileMimeType: vars.file.type || null,
                type: 'FILE',
                status: 'PENDING_UPLOAD',
                owner: null,
                // EP-3 — the list row now reads many-to-many links + category.
                evidenceControlLinks: [],
                category: null,
                retentionUntil: null,
                isArchived: false,
                expiredAt: null,
                deletedAt: null,
                fileRecordId: null,
            };
            // PR-5 — cache value is `CappedList<unknown>`; preserve the
            // `truncated` flag, only prepend to `rows`.
            return {
                rows: [pendingRow, ...(current?.rows ?? [])],
                truncated: current?.truncated ?? false,
            };
        },
        // A new evidence item shifts the dashboard's Evidence KPI +
        // status/expiry cards — refresh the executive card stack.
        invalidate: [CACHE_KEYS.dashboard.executive()],
    });

    // Dropzone's `onUpload` — invoked once per file at submit time.
    // The mutation owns the optimistic-row + revalidation flow per
    // call; this handler only bridges the dropzone's progress
    // callback into the mutation's input + generates a fresh
    // tempId so concurrent uploads don't collide.
    const handleDropzoneUpload = useCallback(
        async (
            file: File,
            ctx: { onProgress: (p: number | null) => void; signal: AbortSignal },
        ) => {
            const total = dropzoneRef.current?.getEntries().length ?? 1;
            const applyTitle = total === 1;
            const tempId = `temp:${crypto.randomUUID()}`;
            try {
                const uploaded = await mutation.trigger({
                    file,
                    applyTitle,
                    controlId,
                    category,
                    folder,
                    retentionUntil,
                    onProgress: ctx.onProgress,
                    signal: ctx.signal,
                    tempId,
                });
                telemetry.trackSuccess({ evidenceId: uploaded?.id });
                // Fan out to sibling filter variants — the primary
                // key revalidation only refreshes the unfiltered
                // baseline. Without this, a user uploading while
                // filtered to "type:FILE" would not see the new row
                // until they cleared the filter.
                await swrMutate(
                    (key) =>
                        typeof key === 'string' &&
                        (key === evidenceUrlPrefix ||
                            key.startsWith(`${evidenceUrlPrefix}?`)),
                    undefined,
                    { revalidate: true },
                );
                return uploaded;
            } catch (err) {
                telemetry.trackError(err);
                const msg =
                    err instanceof UploadHttpError
                        ? (() => {
                              const body = err.parsedBody as
                                  | { error?: string; message?: string }
                                  | null;
                              return (
                                  body?.error || body?.message || err.message
                              );
                          })()
                        : err instanceof Error
                          ? err.message
                          : tx('upload.uploadFailed');
                setError(msg);
                throw err;
            }
        },
        [
            mutation,
            controlId,
            category,
            folder,
            retentionUntil,
            telemetry,
            swrMutate,
            evidenceUrlPrefix,
        ],
    );

    const onPick = useCallback((files: File[]) => {
        setError('');
        // Add to existing count so multi-pick across drops accumulates.
        setQueuedCount((prev) => prev + files.length);
    }, []);

    const onAllSettled = useCallback((settled: FileUploadEntry[]) => {
        setUploadingAll(false);
        // Use the entries argument from FileDropzone — `getEntries()`
        // returns the ref-snapshot which still reflects the previous
        // commit at the moment `onAllSettled` fires (the ref-syncing
        // useEffect in FileDropzone hasn't run yet on this microtask).
        // Without using the live argument, the modal stayed open after
        // a successful POST in `evidence-upload-modal.spec.ts`.
        const allOk =
            settled.length > 0 && settled.every((e) => e.status === 'success');
        if (allOk) {
            // Drop the modal once every queued file landed cleanly.
            close();
        }
    }, [close]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (uploadingAll) return;
        const entries = dropzoneRef.current?.getEntries() ?? [];
        const queued = entries.filter((x) => x.status === 'queued');
        if (queued.length === 0) {
            setError(tx('upload.fileRequired'));
            return;
        }
        setError('');
        telemetry.trackSubmit({
            count: queued.length,
            hasTitle: title.trim().length > 0,
            hasControlLink: Boolean(controlId),
            hasRetention: Boolean(retentionUntil),
        });
        setUploadingAll(true);
        dropzoneRef.current?.startAll().catch(() => {
            // Errors land in `mutation.onError` per file — the
            // imperative chain only signals "all done" via
            // `onAllSettled`, so no extra surface needed here.
        });
    };

    const cancel = () => {
        if (uploadingAll) {
            dropzoneRef.current?.cancelAll();
            setUploadingAll(false);
        }
        close();
    };

    const submitDisabled = queuedCount === 0 || uploadingAll;

    return (
        <>
        {spConnId && (
            <SharePointFilePicker
                showModal={spPickerOpen}
                setShowModal={setSpPickerOpen}
                connectionId={spConnId}
                multiple
                onConfirm={handleSpImport}
            />
        )}
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={tx('upload.title')}
            description={tx('upload.descriptionModal')}
            preventDefaultClose={uploadingAll}
        >
            <Modal.Header
                title={tx('upload.title')}
                description={tx('upload.descriptionHeader')}
            />
            <Modal.Form id="upload-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="upload-error"
                            role="alert"
                            data-testid="upload-evidence-error"
                        >
                            {error}
                        </div>
                    )}

                    <fieldset className="space-y-default" disabled={uploadingAll}>
                        {/* Multi-file dropzone */}
                        <div>
                            <label
                                className="mb-1 block text-sm text-content-default"
                                htmlFor="file-input"
                            >
                                {tx('upload.filesLabel')} <RequiredMarker />
                            </label>
                            <FileDropzone
                                ref={dropzoneRef}
                                inputId="file-input"
                                accept={EVIDENCE_ACCEPT}
                                multiple
                                autoStart={false}
                                maxFileSizeMB={MAX_FILE_SIZE_MB}
                                disabled={uploadingAll}
                                onPick={onPick}
                                onUpload={handleDropzoneUpload}
                                onAllSettled={onAllSettled}
                                hint={tx('upload.dropHint', { mb: MAX_FILE_SIZE_MB })}
                            />
                            {spConnId && (
                                <div className="mt-default flex items-center gap-default">
                                    <span className="text-xs text-content-muted">{tx('upload.or')}</span>
                                    <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => setSpPickerOpen(true)}
                                        disabled={uploadingAll}
                                    >
                                        {tx('upload.importSharePoint')}
                                    </Button>
                                </div>
                            )}
                            {/* EP-4 — the SharePoint connection probe errored
                                (fetch threw or non-ok). Surface it so the user
                                knows the check failed rather than assuming
                                SharePoint just isn't connected. */}
                            {spProbeError && !spConnId && (
                                <div className="mt-default">
                                    <InlineNotice variant="warning" title={tx('upload.spProbeErrorTitle')}>
                                        {tx('upload.spProbeErrorBody')}
                                    </InlineNotice>
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                            {/* Title (single-file only — see UX note below) */}
                            <div>
                                <label
                                    className="mb-1 block text-sm text-content-default"
                                    htmlFor="upload-title-input"
                                >
                                    {tx('upload.titleLabel')}
                                </label>
                                <input
                                    id="upload-title-input"
                                    type="text"
                                    className="input w-full"
                                    placeholder={
                                        queuedCount > 1
                                            ? tx('upload.titlePlaceholderMulti')
                                            : tx('upload.titlePlaceholderSingle')
                                    }
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    autoComplete="off"
                                    disabled={queuedCount > 1}
                                />
                                {queuedCount > 1 && (
                                    <p className="mt-1 text-xs text-content-muted">
                                        {tx('upload.titleMultiHint')}
                                    </p>
                                )}
                            </div>

                            {/* Retention date.
                              Epic 58 — uses the shared DatePicker; the
                              YMD-string state is the wire format the
                              retention API consumes. `disabledDays`
                              mirrors the previous `min=today` constraint. */}
                            <div>
                                <div className="mb-1 flex items-center gap-1.5">
                                    <label
                                        className="text-sm text-content-default"
                                        htmlFor="retention-date-input"
                                    >
                                        {tx('upload.retainLabel')}
                                    </label>
                                    <InfoTooltip
                                        aria-label={tx('upload.retainTooltipAria')}
                                        iconClassName="h-3.5 w-3.5"
                                        content={tx('upload.retainTooltip')}
                                    />
                                </div>
                                <DatePicker
                                    id="retention-date-input"
                                    className="w-full"
                                    placeholder={tx('upload.retainPlaceholder')}
                                    clearable
                                    align="start"
                                    value={parseYMD(retentionUntil)}
                                    onChange={(next) => {
                                        setRetentionUntil(toYMD(next) ?? '');
                                    }}
                                    disabledDays={{
                                        before: startOfUtcDay(new Date()),
                                    }}
                                    aria-label={tx('upload.retainAria')}
                                />
                                <p className="mt-1 text-xs text-content-muted">
                                    {tx('upload.retainHint')}
                                </p>
                            </div>
                        </div>

                        {/* Control link — Epic 55: searchable Combobox */}
                        <FormField
                            label={tx('upload.linkControlLabel')}
                            description={
                                controls.length === 0
                                    ? tx('upload.controlsUnavailable')
                                    : tx('upload.searchControlsDesc', { count: controls.length })
                            }
                        >
                            <Combobox<false, ControlOption>
                                id="control-select"
                                name="controlId"
                                options={controlOptions}
                                selected={
                                    controlOptions.find(
                                        (o) => o.value === controlId,
                                    ) ?? null
                                }
                                setSelected={(option) =>
                                    setControlId(option?.value ?? '')
                                }
                                placeholder={tx('upload.noControlLink')}
                                searchPlaceholder={tx('upload.searchControls')}
                                emptyState={tx('upload.noControlsMatch')}
                                matchTriggerWidth
                                forceDropdown
                                buttonProps={{ className: 'w-full' }}
                                caret
                            />
                        </FormField>

                        {/* EP-3 — Category. Free text applied to every
                            file in the batch. */}
                        <FormField
                            label={tx('upload.categoryLabel')}
                            description={tx('upload.categoryDesc')}
                        >
                            <input
                                id="upload-evidence-category-input"
                                type="text"
                                className="input w-full"
                                placeholder={tx('upload.categoryPlaceholder')}
                                value={category}
                                onChange={(e) => setCategory(e.target.value)}
                                autoComplete="off"
                            />
                        </FormField>

                        {/* B8 follow-up — Folder. Applies to every
                            file in the batch; datalist seeds it
                            from existing evidence folders. */}
                        <FormField
                            label={tx('upload.folderLabel')}
                            description={tx('upload.folderDesc')}
                        >
                            <input
                                id="upload-evidence-folder-input"
                                data-testid="upload-evidence-folder-input"
                                type="text"
                                className="input w-full"
                                placeholder={tx('upload.folderPlaceholder')}
                                list="evidence-folder-suggestions"
                                value={folder}
                                onChange={(e) => setFolder(e.target.value)}
                                autoComplete="off"
                            />
                        </FormField>
                    </fieldset>
                </Modal.Body>

                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="upload-evidence-cancel-btn"
                        onClick={cancel}
                    >
                        {uploadingAll ? tx('upload.stop') : tx('upload.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="submit-upload-btn"
                        disabled={submitDisabled}
                    >
                        {uploadingAll
                            ? tx('upload.uploading')
                            : queuedCount > 1
                              ? tx('upload.uploadMulti', { count: queuedCount })
                              : tx('upload.upload')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
        </>
    );
}
