'use client';

/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

/**
 * Epic 43.3 — Bulk evidence import modal.
 *
 * Sits next to the single-file `<UploadEvidenceModal>` and drives the
 * ZIP bulk-import flow:
 *
 *   1. Operator drops a .zip into the FileDropzone (single-file mode,
 *      multi-zip uploads aren't a feature this prompt invents).
 *   2. POST `/evidence/imports` stages the archive + enqueues the
 *      `evidence-import` BullMQ job. Response carries `jobId`.
 *   3. We poll `GET /evidence/imports/:jobId` every 2s. Live progress
 *      surfaces extracted / skipped / errored counters as the worker
 *      iterates entries (BullMQ progress channel).
 *   4. On completion, invalidate the evidence query so the list
 *      shows the newly imported rows + close the modal.
 *
 * No business logic lives here — every safety bound is enforced by
 * the worker. The modal is a thin coordinator + status surface.
 */

import { useSWRConfig } from 'swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { EntityPicker } from '@/components/ui/entity-picker';
import {
    FileDropzone,
    type FileDropzoneHandle,
} from '@/components/ui/FileDropzone';
import {
    uploadWithProgress,
    UploadHttpError,
} from '@/lib/upload/upload-with-progress';

const POLL_INTERVAL_MS = 2000;
// EP-4 — after this many consecutive poll failures (throw / non-ok) the
// import status surfaces a failed-import error instead of polling forever.
const MAX_POLL_FAILURES = 5;

interface ImportProgress {
    extracted: number;
    skipped: number;
    errored: number;
    totalEntries: number;
}

interface ImportStatus {
    jobId: string;
    state:
        | 'waiting'
        | 'active'
        | 'completed'
        | 'failed'
        | 'delayed'
        | 'paused';
    progress?: ImportProgress | number;
    result?: {
        success?: boolean;
        details?: {
            extracted?: number;
            skipped?: number;
            errored?: number;
            evidenceIds?: string[];
            firstError?: string;
            skipReasons?: Array<{ path: string; reason: string }>;
        };
        errorMessage?: string;
    } | null;
    failedReason?: string | null;
}

export interface EvidenceBulkImportModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    tenantSlug: string;
    apiUrl: (path: string) => string;
}

export function EvidenceBulkImportModal({
    open,
    setOpen,
    tenantSlug,
    apiUrl,
}: EvidenceBulkImportModalProps) {
    const tx = useTranslations('evidence');
    const close = useCallback(() => setOpen(false), [setOpen]);
    // EvidenceClient reads from `useTenantSWR(CACHE_KEYS.evidence.list())`;
    // revalidate that key on import completion.
    const { mutate: swrMutate } = useSWRConfig();
    const dropzoneRef = useRef<FileDropzoneHandle>(null);

    const [error, setError] = useState('');
    const [jobId, setJobId] = useState<string | null>(null);
    const [status, setStatus] = useState<ImportStatus | null>(null);
    const [queuedCount, setQueuedCount] = useState(0);
    const [busy, setBusy] = useState(false);
    // EP-3 — optional default control + folder threaded onto every
    // imported row (creates an EvidenceControlLink + folder label).
    const [defaultControlId, setDefaultControlId] = useState('');
    const [importFolder, setImportFolder] = useState('');

    useEffect(() => {
        if (!open) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setError('');
        setJobId(null);
        setStatus(null);
        setQueuedCount(0);
        setBusy(false);
        setDefaultControlId('');
        setImportFolder('');
    }, [open]);

    // Poll loop — runs only while a jobId is set + the job is not
    // terminal. Cleared on close + on terminal-state observation.
    useEffect(() => {
        if (!jobId) return;
        let cancelled = false;
        // EP-4 — a transient network blip is retried, but a PERSISTENTLY
        // failing poll (fetch throws or a non-ok status MAX_POLL_FAILURES
        // times in a row) now surfaces a failed-import state instead of
        // silently stopping (non-ok) or retrying forever (throw). A
        // successful poll resets the counter.
        let consecutiveFailures = 0;
        const onPollFailure = () => {
            if (cancelled) return;
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_POLL_FAILURES) {
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setError(tx('bulkImport.pollFailed'));
                return; // stop polling — the operator can retry
            }
            setTimeout(tick, POLL_INTERVAL_MS);
        };
        const tick = async () => {
            try {
                const res = await fetch(
                    apiUrl(`/evidence/imports/${jobId}`),
                );
                if (!res.ok) {
                    onPollFailure();
                    return;
                }
                const next = (await res.json()) as ImportStatus;
                if (cancelled) return;
                consecutiveFailures = 0;
                setStatus(next);
                if (
                    next.state === 'completed' ||
                    next.state === 'failed'
                ) {
                    // Revalidate every `/evidence?…` SWR cache entry so the
                    // list page refreshes regardless of the active filter.
                    const evidenceUrlPrefix = apiUrl(CACHE_KEYS.evidence.list());
                    swrMutate(
                        (key) =>
                            typeof key === 'string' &&
                            (key === evidenceUrlPrefix ||
                                key.startsWith(`${evidenceUrlPrefix}?`)),
                        undefined,
                        { revalidate: true },
                    );
                    return; // stop polling
                }
                setTimeout(tick, POLL_INTERVAL_MS);
            } catch {
                // Network blip — retry up to MAX_POLL_FAILURES, then surface.
                onPollFailure();
            }
        };
        tick();
        return () => {
            cancelled = true;
        };
    }, [jobId, apiUrl, swrMutate, tx]);

    // Per-file upload handler driven by <FileDropzone>. Folds the former
    // useMutation (mutationFn + onSuccess + onError) into one async fn:
    // on success it seeds the jobId (kicking off the poll loop above); on
    // error it surfaces the message and re-throws so the dropzone's
    // per-file promise rejects.
    const onUpload = useCallback(
        async (
            file: File,
            ctx: {
                onProgress: (p: number | null) => void;
                signal: AbortSignal;
            },
        ) => {
            const formData = new FormData();
            formData.append('file', file);
            // EP-3 — thread the optional default control (as a repeated
            // `controlIds` field) + folder so imported rows get an
            // EvidenceControlLink + folder label.
            // `controlId`, singular — the whole import pipeline is singular
            // (route -> EvidenceImportPayload -> uploadEvidenceFile) and this
            // field holds exactly one id. Posting it as `controlIds` MEANT the
            // route's `formData.get('controlId')` found nothing, so the chosen
            // control WAS dropped on every import while the modal reported
            // success. Fixed — the name below is the singular one the route
            // reads; the paragraph is here so a rename does not undo it.
            if (defaultControlId) formData.append('controlId', defaultControlId);
            if (importFolder.trim()) formData.append('folder', importFolder.trim());
            try {
                const res = await uploadWithProgress<{ jobId: string }>(
                    apiUrl('/evidence/imports'),
                    formData,
                    {
                        onProgress: (p) => ctx.onProgress(p.percent),
                        signal: ctx.signal,
                    },
                );
                if (res?.jobId) setJobId(res.jobId);
                return res;
            } catch (err) {
                const msg =
                    err instanceof UploadHttpError
                        ? (() => {
                              const body = err.parsedBody as
                                  | { error?: string; message?: string }
                                  | null;
                              return body?.error || body?.message || err.message;
                          })()
                        : err instanceof Error
                          ? err.message
                          : tx('bulkImport.bulkImportFailed');
                setError(msg);
                setBusy(false);
                throw err;
            }
        },
        [apiUrl, defaultControlId, importFolder],
    );

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (busy) return;
        setError('');
        setBusy(true);
        dropzoneRef.current?.startAll().catch(() => {
            // mutation onError surfaces the message
        });
    };

    const cancel = () => {
        if (busy && !jobId) {
            dropzoneRef.current?.cancelAll();
        }
        close();
    };

    const progress =
        status?.progress && typeof status.progress === 'object'
            ? (status.progress as ImportProgress)
            : null;
    const result = status?.result?.details ?? null;
    const isTerminal =
        status?.state === 'completed' || status?.state === 'failed';

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="md"
            title={tx('bulkImport.title')}
            description={tx('bulkImport.descriptionModal')}
            preventDefaultClose={busy && !isTerminal}
        >
            <Modal.Header
                title={tx('bulkImport.title')}
                description={tx('bulkImport.descriptionHeader')}
            />
            <Modal.Form id="bulk-import-form" onSubmit={handleSubmit}>
                <Modal.Body>
                    {error && (
                        <div
                            className="mb-4 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error"
                            id="bulk-import-error"
                            role="alert"
                            data-testid="evidence-bulk-import-error"
                        >
                            {error}
                        </div>
                    )}

                    <FileDropzone
                        ref={dropzoneRef}
                        inputId="bulk-import-input"
                        accept=".zip,application/zip"
                        multiple={false}
                        autoStart={false}
                        maxFileSizeMB={100}
                        disabled={busy}
                        onPick={(files) => {
                            setQueuedCount(files.length);
                            setError('');
                        }}
                        onUpload={onUpload}
                        title={tx('bulkImport.dropTitle')}
                        hint={tx('bulkImport.dropHint')}
                    />

                    {/* EP-3 — optional metadata applied to every imported row. */}
                    <div className="mt-default grid grid-cols-1 gap-default sm:grid-cols-2">
                        <FormField
                            label={tx('bulkImport.defaultControlLabel')}
                            description={tx('bulkImport.defaultControlDesc')}
                        >
                            <EntityPicker
                                id="bulk-import-control-input"
                                tenantSlug={tenantSlug}
                                entityType="CONTROL"
                                value={defaultControlId}
                                onChange={setDefaultControlId}
                                placeholder={tx('bulkImport.defaultControlPlaceholder')}
                                testId="bulk-import-control-picker"
                            />
                        </FormField>
                        <FormField label={tx('bulkImport.folderLabel')}>
                            <input
                                id="bulk-import-folder-input"
                                type="text"
                                className="input w-full"
                                placeholder={tx('bulkImport.folderPlaceholder')}
                                list="evidence-folder-suggestions"
                                value={importFolder}
                                onChange={(e) => setImportFolder(e.target.value)}
                                disabled={busy}
                                autoComplete="off"
                            />
                        </FormField>
                    </div>

                    {jobId && (
                        <Card
                            elevation="inset"
                            density="none"
                            className="mt-4 p-3 text-sm"
                            data-testid="evidence-bulk-import-status"
                        >
                            <p className="text-content-emphasis">
                                {tx('bulkImport.jobLabel')} <span className="font-mono">{jobId}</span>{' '}
                                — {status?.state ?? tx('bulkImport.queued')}
                            </p>
                            {progress && (
                                <p className="mt-1 text-xs text-content-muted">
                                    {tx('bulkImport.progressLine', {
                                        extracted: progress.extracted,
                                        skipped: progress.skipped,
                                        errored: progress.errored,
                                        total: progress.totalEntries,
                                    })}
                                </p>
                            )}
                            {isTerminal && result && (
                                <ul className="mt-2 space-y-0.5 text-xs">
                                    <li className="text-content-success">
                                        {tx('bulkImport.extracted', { count: result.extracted ?? 0 })}
                                    </li>
                                    <li className="text-content-warning">
                                        {tx('bulkImport.skipped', { count: result.skipped ?? 0 })}
                                    </li>
                                    <li className="text-content-error">
                                        {tx('bulkImport.errored', { count: result.errored ?? 0 })}
                                    </li>
                                    {result.firstError && (
                                        <li className="text-content-error">
                                            {tx('bulkImport.firstError', { error: result.firstError })}
                                        </li>
                                    )}
                                </ul>
                            )}
                            {status?.state === 'failed' && (
                                <p className="mt-2 text-xs text-content-error">
                                    {status.failedReason ?? tx('bulkImport.jobFailed')}
                                </p>
                            )}
                        </Card>
                    )}
                </Modal.Body>

                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        id="bulk-import-cancel-btn"
                        onClick={cancel}
                    >
                        {isTerminal ? tx('bulkImport.close') : tx('bulkImport.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        id="bulk-import-submit-btn"
                        disabled={
                            queuedCount === 0 || busy || jobId !== null
                        }
                    >
                        {jobId
                            ? tx('bulkImport.importRunning')
                            : busy
                              ? tx('bulkImport.uploading')
                              : tx('bulkImport.startImport')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
