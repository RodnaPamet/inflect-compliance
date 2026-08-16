"use client";

/**
 * `<FileDropzone>` — generic, reusable drag-and-drop upload primitive.
 *
 * Three things every upload UI in the codebase needs:
 *   1. a drop zone that highlights on drag-over,
 *   2. a click-to-browse fallback,
 *   3. visible per-file progress + success/error feedback.
 *
 * The component handles all three. It does NOT know about the
 * evidence API (or any specific endpoint). The consumer passes an
 * `onUpload(file, ctx)` handler that receives the file plus a
 * `(progress) => void` callback and an `AbortSignal`. Use
 * `uploadWithProgress` from `@/lib/upload/upload-with-progress` if you
 * want a one-line XHR uploader — it's separate so non-UI callers can
 * reuse it.
 *
 * Reusable by design: evidence is the first caller (Epic 43); future
 * surfaces (policy attachments, audit-pack imports, vendor
 * questionnaire artefacts) can drop this component in unchanged.
 *
 * What this is NOT:
 *   - A folder uploader (no `webkitdirectory` — out of scope for Epic 43.1).
 *   - A resumable / chunked uploader (browser fetch streaming is still
 *     flag-gated; XHR + retry is the realistic compromise today).
 *   - A previewer (the consumer renders previews via the children API
 *     if it cares — most evidence flows want a list, not a thumbnail).
 */

import {
    type ComponentProps,
    type DragEvent,
    type ForwardedRef,
    forwardRef,
    type ReactNode,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from 'react';
import { CheckCircle2, UploadCloud, X } from 'lucide-react';

import { FileTypeIcon } from '@/components/ui/file-type-icon';
import { formatBytes } from '@/lib/evidence-upload-limits';

// ─── Types ──────────────────────────────────────────────────────────

export type FileUploadStatus =
    | 'queued'
    | 'uploading'
    | 'success'
    | 'error'
    | 'aborted';

export interface FileUploadEntry {
    /** Stable id for the row (random per-mount). */
    id: string;
    file: File;
    status: FileUploadStatus;
    /** 0–100 when known; null while indeterminate. */
    percent: number | null;
    /** Human-readable error string. Set when `status === 'error'`. */
    error?: string;
    /** Server response on success. Whatever the upload handler returns. */
    response?: unknown;
}

export interface FileUploadHandlerCtx {
    onProgress: (percent: number | null) => void;
    signal: AbortSignal;
}

export type FileUploadHandler = (
    file: File,
    ctx: FileUploadHandlerCtx,
) => Promise<unknown>;

export interface FileDropzoneProps {
    /** Standard <input accept> string. e.g. ".pdf,.png,image/*". */
    accept?: string;
    /** Hard cap per file (MB). Files over this size are rejected before upload. */
    maxFileSizeMB?: number;
    /** Allow more than one file at a time. Default: true. */
    multiple?: boolean;
    /** Disable interaction (also stops drop). */
    disabled?: boolean;
    /** Upload one file. Receives a progress + signal context. */
    onUpload: FileUploadHandler;
    /** Fired once per file once it reaches a terminal state (success/error/aborted). */
    onFileSettled?: (entry: FileUploadEntry) => void;
    /** Fired once after every queued upload reaches a terminal state. */
    onAllSettled?: (entries: FileUploadEntry[]) => void;
    /** Fired whenever a new file is queued (drop/click). */
    onPick?: (files: File[]) => void;
    /**
     * When true (default), uploads start immediately on drop / pick.
     * Set to false for submit-driven flows: drops queue files in
     * `'queued'` state and the consumer triggers uploads via
     * `ref.current.startAll()`. Useful for forms where metadata
     * gets entered alongside the file and the upload only fires on
     * Submit.
     */
    autoStart?: boolean;
    /**
     * Auto-clear the row list `clearAfterMs` ms after every entry has
     * settled successfully. Set to `null` (default) to leave the rows
     * visible — the consumer can clear via the "Clear completed" button.
     */
    clearAfterMs?: number | null;
    /** Heading inside the drop area when no files are queued. */
    title?: ReactNode;
    /** Subhead beneath the title. */
    hint?: ReactNode;
    /**
     * Compact layout — a much shorter drop area (~1/3 height) for dense
     * side-rail / panel contexts (e.g. the Controls right-rail evidence
     * box). Keeps full width; trims the vertical padding + icon. Default
     * false (the roomy full-height surface).
     */
    compact?: boolean;
    /** Outer wrapper class. */
    className?: string;
    /** Outer DOM id (for label/htmlFor wiring + E2E selectors). */
    id?: string;
    /**
     * DOM `id` on the hidden `<input type="file">`. Forwarded so E2E
     * selectors that drive uploads via `setInputFiles('#…')` keep
     * working when migrating from older single-file primitives.
     */
    inputId?: string;
    /** Test id for the outer dropzone. */
    'data-testid'?: string;
}

/**
 * Imperative handle exposed via `ref`. Usable from a parent that wants
 * submit-driven uploads or programmatic cancellation.
 */
export interface FileDropzoneHandle {
    /** Start uploads for every entry currently in `'queued'` state. */
    startAll: () => Promise<void>;
    /** Abort all in-flight uploads + remove queued/uploading rows. */
    cancelAll: () => void;
    /** Read the current entry list (snapshot). */
    getEntries: () => FileUploadEntry[];
}

// ─── Utilities ──────────────────────────────────────────────────────

function uid(): string {
    return typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `f-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

// formatBytes moved to @/lib/evidence-upload-limits — it had two other
// copies, one of which had lost the sub-kilobyte branch.

/** Whether the dragged item is a file (vs text/etc). */
function dragHasFiles(e: DragEvent): boolean {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types && Array.from(dt.types).includes('Files')) return true;
    return dt.files?.length > 0;
}

// Match an `<input accept>` token list against a File. Mirrors the
// browser's own filter so the click + drag paths agree.
function fileMatchesAccept(file: File, accept: string): boolean {
    if (!accept.trim()) return true;
    const tokens = accept
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    if (tokens.length === 0) return true;
    const name = file.name.toLowerCase();
    const mime = file.type.toLowerCase();
    return tokens.some((t) => {
        if (t.startsWith('.')) return name.endsWith(t);
        if (t.endsWith('/*')) return mime.startsWith(t.slice(0, -1));
        return mime === t;
    });
}

// ─── Component ──────────────────────────────────────────────────────

function FileDropzoneInner(
    {
        accept = '',
        maxFileSizeMB = 25,
        multiple = true,
        disabled = false,
        onUpload,
        onFileSettled,
        onAllSettled,
        onPick,
        autoStart = true,
        clearAfterMs = null,
        title,
        hint,
        compact = false,
        className = '',
        id,
        inputId,
        'data-testid': dataTestId = 'file-dropzone',
    }: FileDropzoneProps,
    ref: ForwardedRef<FileDropzoneHandle>,
) {
    const [entries, setEntries] = useState<FileUploadEntry[]>([]);
    const [dragActive, setDragActive] = useState(false);
    const [hint_, setHintMessage] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    // Aborters per row so we can cancel an in-flight upload.
    const abortersRef = useRef<Map<string, AbortController>>(new Map());

    // Snapshot of entries via ref so `useEffect`-reset logic can read
    // the current list without subscribing to it.
    const entriesRef = useRef(entries);
    useEffect(() => {
        entriesRef.current = entries;
    }, [entries]);

    // ── Cleanup any in-flight uploads on unmount ─────────────────────
    useEffect(() => {
        const aborters = abortersRef.current;
        return () => {
            for (const ac of aborters.values()) ac.abort();
        };
    }, []);

    // ── Auto-clear completed rows after a delay ──────────────────────
    useEffect(() => {
        if (clearAfterMs == null) return;
        if (entries.length === 0) return;
        const allDone =
            entries.length > 0 && entries.every((e) => e.status === 'success');
        if (!allDone) return;
        const t = setTimeout(() => {
            // Only clear if still all-success — a re-drop in the
            // meantime would have queued new entries.
            if (
                entriesRef.current.length === entries.length &&
                entriesRef.current.every((e) => e.status === 'success')
            ) {
                setEntries([]);
            }
        }, clearAfterMs);
        return () => clearTimeout(t);
    }, [clearAfterMs, entries]);

    // ── Patch a single entry by id ───────────────────────────────────
    const patch = useCallback(
        (id: string, next: Partial<FileUploadEntry>) => {
            setEntries((prev) =>
                prev.map((e) => (e.id === id ? { ...e, ...next } : e)),
            );
        },
        [],
    );

    // ── Run the upload for one queued entry ──────────────────────────
    //
    // Returns the FINAL settled entry so callers can compose
    // `onAllSettled` from the live values WITHOUT depending on
    // `entriesRef.current` — the ref is updated by a `useEffect` that
    // fires AFTER the React commit, so reading it inside the same
    // microtask as `setEntries` produces the previous (queued) entry,
    // not the success/error one. That race silently kept the upload
    // modal open after a successful POST in
    // `evidence-upload-modal.spec.ts`.
    const runOne = useCallback(
        async (entry: FileUploadEntry): Promise<FileUploadEntry> => {
            const ac = new AbortController();
            abortersRef.current.set(entry.id, ac);
            patch(entry.id, { status: 'uploading', percent: 0 });
            let settled: FileUploadEntry;
            try {
                const response = await onUpload(entry.file, {
                    onProgress: (percent) => patch(entry.id, { percent }),
                    signal: ac.signal,
                });
                settled = {
                    ...entry,
                    status: 'success',
                    percent: 100,
                    response,
                };
                setEntries((prev) =>
                    prev.map((e) => (e.id === entry.id ? settled : e)),
                );
                onFileSettled?.(settled);
            } catch (err) {
                const aborted =
                    (err as Error)?.name === 'UploadAbortedError' ||
                    ac.signal.aborted;
                const message =
                    err instanceof Error ? err.message : String(err);
                settled = {
                    ...entry,
                    status: aborted ? 'aborted' : 'error',
                    error: aborted ? 'Cancelled' : message,
                };
                setEntries((prev) =>
                    prev.map((e) => (e.id === entry.id ? settled : e)),
                );
                onFileSettled?.(settled);
            } finally {
                abortersRef.current.delete(entry.id);
            }
            return settled;
        },
        [onUpload, onFileSettled, patch],
    );

    // ── Validate + queue a list of files ─────────────────────────────
    const accept_ = accept;
    const maxBytes = maxFileSizeMB * 1024 * 1024;
    const queueFiles = useCallback(
        (files: FileList | File[]) => {
            setHintMessage(null);
            const list = Array.from(files);
            if (list.length === 0) return;

            const accepted: FileUploadEntry[] = [];
            const rejections: string[] = [];

            const sliceTo = multiple ? list : list.slice(0, 1);
            for (const file of sliceTo) {
                if (accept_ && !fileMatchesAccept(file, accept_)) {
                    rejections.push(`${file.name}: file type not accepted`);
                    continue;
                }
                if (file.size > maxBytes) {
                    rejections.push(
                        `${file.name}: exceeds ${maxFileSizeMB} MB limit`,
                    );
                    continue;
                }
                accepted.push({
                    id: uid(),
                    file,
                    status: 'queued',
                    percent: null,
                });
            }

            if (rejections.length > 0) {
                setHintMessage(rejections.join(' · '));
            }
            if (accepted.length === 0) return;

            setEntries((prev) => (multiple ? [...prev, ...accepted] : accepted));
            onPick?.(accepted.map((a) => a.file));

            if (!autoStart) return;

            // Kick off the uploads. Sequential is friendlier for big
            // files (browsers cap concurrent connections per origin
            // anyway); parallelising at the dropzone layer offers
            // little practical gain but adds complexity.
            (async () => {
                const settled: FileUploadEntry[] = [];
                for (const entry of accepted) {

                    settled.push(await runOne(entry));
                }
                onAllSettled?.(settled);
            })();
        },
        [
            accept_,
            autoStart,
            maxBytes,
            maxFileSizeMB,
            multiple,
            onAllSettled,
            onPick,
            runOne,
        ],
    );

    // ── Imperative API ───────────────────────────────────────────────
    const startAll = useCallback(async () => {
        const queued = entriesRef.current.filter((e) => e.status === 'queued');
        if (queued.length === 0) return;
        const settled: FileUploadEntry[] = [];
        for (const entry of queued) {

            settled.push(await runOne(entry));
        }
        onAllSettled?.(settled);
    }, [onAllSettled, runOne]);
    const cancelAll = useCallback(() => {
        for (const ac of abortersRef.current.values()) ac.abort();
        abortersRef.current.clear();
        setEntries([]);
    }, []);
    const getEntries = useCallback(() => entriesRef.current.slice(), []);

    useImperativeHandle(
        ref,
        () => ({ startAll, cancelAll, getEntries }),
        [startAll, cancelAll, getEntries],
    );

    // ── DOM event handlers ───────────────────────────────────────────
    const onClick = useCallback(() => {
        if (disabled) return;
        inputRef.current?.click();
    }, [disabled]);

    const onKey: ComponentProps<'div'>['onKeyDown'] = useCallback(
        (e: React.KeyboardEvent) => {
            if (disabled) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                inputRef.current?.click();
            }
        },
        [disabled],
    );

    const onDragOver = (e: DragEvent) => {
        if (disabled) return;
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setDragActive(true);
    };
    const onDragEnter = onDragOver;
    const onDragLeave = (e: DragEvent) => {
        if (disabled) return;
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
        if (disabled) return;
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            queueFiles(e.dataTransfer.files);
        }
    };

    const onInputChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
        if (e.target.files && e.target.files.length > 0) {
            queueFiles(e.target.files);
            // Reset so re-selecting the same file fires onChange.
            e.target.value = '';
        }
    };

    // ── Cancel / clear actions ───────────────────────────────────────
    const cancelEntry = (id: string) => {
        const ac = abortersRef.current.get(id);
        if (ac) ac.abort();
        setEntries((prev) => prev.filter((e) => e.id !== id));
    };
    const clearCompleted = () => {
        setEntries((prev) =>
            prev.filter((e) => e.status === 'queued' || e.status === 'uploading'),
        );
    };

    // ── Render ───────────────────────────────────────────────────────
    const hasEntries = entries.length > 0;
    const completedCount = useMemo(
        () => entries.filter((e) => e.status === 'success').length,
        [entries],
    );

    return (
        <div className={className}>
            <div
                id={id}
                role="button"
                tabIndex={disabled ? -1 : 0}
                aria-disabled={disabled || undefined}
                aria-label={
                    typeof title === 'string'
                        ? title
                        : 'File upload dropzone'
                }
                data-testid={dataTestId}
                data-drag-active={dragActive ? 'true' : 'false'}
                onClick={onClick}
                onKeyDown={onKey}
                onDragOver={onDragOver}
                onDragEnter={onDragEnter}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                className={[
                    'group relative flex w-full flex-col items-center justify-center rounded-lg border-2 border-dashed transition-all',
                    // Compact (~1/3 height) for dense side-rail panels; roomy default otherwise.
                    compact ? 'min-h-[3.5rem] py-2' : 'min-h-[10rem]',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)] focus-visible:ring-offset-2',
                    disabled
                        ? 'cursor-not-allowed border-border-default bg-bg-muted opacity-60'
                        : dragActive
                          ? 'cursor-copy border-[var(--brand-default)] bg-bg-muted'
                          : 'cursor-pointer border-border-default bg-bg-subtle hover:border-border-emphasis hover:bg-bg-muted',
                ].join(' ')}
            >
                <UploadCloud
                    size={compact ? 18 : 28}
                    className={`transition-transform ${
                        dragActive ? 'scale-110 text-[var(--brand-default)]' : 'text-content-muted'
                    }`}
                    aria-hidden
                />
                <div className={`${compact ? 'mt-1' : 'mt-2'} text-center ${compact ? 'text-xs' : 'text-sm'}`}>
                    <p className="text-content-emphasis">
                        {title ?? (
                            <>
                                Drag and drop {multiple ? 'files' : 'a file'} or
                                click to browse
                            </>
                        )}
                    </p>
                    {hint && (
                        <p className="mt-0.5 text-xs text-content-muted">
                            {hint}
                        </p>
                    )}
                </div>
                <input
                    ref={inputRef}
                    id={inputId}
                    type="file"
                    accept={accept}
                    multiple={multiple}
                    disabled={disabled}
                    onChange={onInputChange}
                    onClick={(e) => e.stopPropagation()}
                    className="sr-only"
                    data-testid="file-dropzone-input"
                    aria-hidden
                    tabIndex={-1}
                />
            </div>

            {hint_ && (
                <p
                    role="alert"
                    className="mt-2 text-xs text-content-error"
                    data-testid="file-dropzone-hint"
                >
                    {hint_}
                </p>
            )}

            {hasEntries && (
                <ul
                    className="mt-3 space-y-tight"
                    data-testid="file-dropzone-list"
                >
                    {entries.map((entry) => (
                        <li
                            key={entry.id}
                            data-file-status={entry.status}
                            data-testid={`file-dropzone-row-${entry.id}`}
                            className="flex items-center gap-compact rounded-md border border-border-default bg-bg-subtle px-3 py-2"
                        >
                            <FileTypeIcon
                                fileName={entry.file.name}
                                mime={entry.file.type}
                                size={18}
                            />
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-compact">
                                    <span
                                        className="truncate text-sm text-content-emphasis"
                                        title={entry.file.name}
                                    >
                                        {entry.file.name}
                                    </span>
                                    <span className="shrink-0 text-xs text-content-muted">
                                        {formatBytes(entry.file.size)}
                                    </span>
                                </div>
                                <div className="mt-1 flex items-center gap-tight">
                                    <ProgressBar entry={entry} />
                                    <StatusLabel entry={entry} />
                                </div>
                            </div>
                            {entry.status === 'uploading' && (
                                <button
                                    type="button"
                                    aria-label={`Cancel upload of ${entry.file.name}`}
                                    className="text-content-muted hover:text-content-emphasis"
                                    onClick={() => cancelEntry(entry.id)}
                                    data-testid={`file-dropzone-cancel-${entry.id}`}
                                >
                                    <X size={14} />
                                </button>
                            )}
                            {entry.status === 'success' && (
                                <CheckCircle2
                                    size={16}
                                    className="text-content-success"
                                    aria-label="Uploaded"
                                />
                            )}
                            {(entry.status === 'error' ||
                                entry.status === 'aborted') && (
                                <button
                                    type="button"
                                    aria-label={`Remove ${entry.file.name} from list`}
                                    className="text-content-muted hover:text-content-emphasis"
                                    onClick={() =>
                                        setEntries((prev) =>
                                            prev.filter((e) => e.id !== entry.id),
                                        )
                                    }
                                    data-testid={`file-dropzone-remove-${entry.id}`}
                                >
                                    <X size={14} />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {hasEntries && completedCount > 0 && (
                <div className="mt-2 flex justify-end">
                    <button
                        type="button"
                        className="text-xs text-content-muted hover:text-content-emphasis"
                        onClick={clearCompleted}
                        data-testid="file-dropzone-clear-completed"
                    >
                        Clear completed ({completedCount})
                    </button>
                </div>
            )}
        </div>
    );
}

export const FileDropzone = forwardRef<FileDropzoneHandle, FileDropzoneProps>(
    FileDropzoneInner,
);
FileDropzone.displayName = 'FileDropzone';

// ─── Internal helpers ───────────────────────────────────────────────

function ProgressBar({ entry }: { entry: FileUploadEntry }) {
    const pct = entry.status === 'success' ? 100 : (entry.percent ?? 0);
    const indeterminate =
        entry.status === 'uploading' && entry.percent === null;
    const colorClass =
        entry.status === 'error'
            ? 'bg-bg-error-emphasis'
            : entry.status === 'aborted'
              ? 'bg-content-subtle'
              : entry.status === 'success'
                ? 'bg-bg-success-emphasis'
                : 'bg-[var(--brand-default)]';
    return (
        <div
            className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate ? undefined : pct}
            aria-label={`Upload progress for ${entry.file.name}`}
            data-testid={`file-dropzone-progress-${entry.id}`}
        >
            <div
                className={`h-full ${colorClass} transition-[width] duration-150 ${indeterminate ? 'animate-pulse w-1/3' : ''}`}
                style={indeterminate ? undefined : { width: `${pct}%` }}
            />
        </div>
    );
}

function StatusLabel({ entry }: { entry: FileUploadEntry }) {
    let text: string;
    switch (entry.status) {
        case 'queued':
            text = 'Queued';
            break;
        case 'uploading':
            text = entry.percent == null ? 'Uploading…' : `${entry.percent}%`;
            break;
        case 'success':
            text = 'Uploaded';
            break;
        case 'aborted':
            text = 'Cancelled';
            break;
        case 'error':
        default:
            text = entry.error ?? 'Failed';
            break;
    }
    return (
        <span
            className={`shrink-0 text-xs ${
                entry.status === 'error'
                    ? 'text-content-error'
                    : entry.status === 'success'
                      ? 'text-content-success'
                      : 'text-content-muted'
            }`}
            data-testid={`file-dropzone-status-${entry.id}`}
        >
            {text}
        </span>
    );
}
