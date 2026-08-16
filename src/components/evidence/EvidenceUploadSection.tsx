'use client';

/**
 * Canonical drag-and-drop evidence uploader for the entity quick-view panels
 * and detail evidence sections (control / task / risk / asset). Wraps the
 * shared `<FileDropzone>` and links each uploaded file to its parent entity
 * in the SAME upload POST (`/evidence/uploads` accepts
 * `controlId`/`taskId`/`riskId`/`assetId`). Replaces the old `<input
 * type="file">` + URL `EvidenceAddForm` style with the drag-drop surface.
 *
 * Self-contained: it owns the upload lifecycle (FileDropzone) and, when a
 * `listEndpoint` is supplied, fetches + renders the attached-evidence list so
 * the panel reflects uploads immediately. Pass `onUploaded` to also refresh a
 * list the consumer owns (e.g. the risk detail `<EvidenceSubTable>`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileDropzone, type FileUploadEntry } from '@/components/ui/FileDropzone';
import { Button } from '@/components/ui/button';
import { Download, ArrowUpRight } from '@/components/ui/icons/nucleo';
import { uploadWithProgress } from '@/lib/upload/upload-with-progress';
import { EVIDENCE_ACCEPT, EVIDENCE_MAX_FILE_MB, EVIDENCE_UPLOAD_HINT } from '@/lib/evidence-upload-limits';

// Mirrors the evidence upload modal's accept list + hint copy so every
// evidence surface advertises the same supported types + size cap.
// The comment above used to say this mirrored the upload modal's list and
// hint. It did — and saying so is not the same as sharing them.
const EVIDENCE_HINT = EVIDENCE_UPLOAD_HINT;
const MAX_FILE_MB = EVIDENCE_MAX_FILE_MB;

/** Raw `Evidence` row as returned by the evidence-tab GET. */
interface RawEvidence {
    id: string;
    title?: string | null;
    fileName?: string | null;
    /** FileRecord id for FILE evidence — drives the signed-URL download. */
    fileRecordId?: string | null;
    /** EvidenceType — 'FILE' | 'LINK' | 'TEXT' | 'SCREENSHOT'. */
    type?: string | null;
    /** For LINK evidence, `content` holds the URL. */
    content?: string | null;
}

/** Raw `ControlEvidenceLink` row (control evidence tab only). */
interface RawLink {
    id: string;
    /** 'FILE' | 'LINK' | 'INTEGRATION_RESULT'. */
    kind?: string | null;
    /** FileRecord id for kind='FILE'. */
    fileId?: string | null;
    /** External URL for kind='LINK'. */
    url?: string | null;
    note?: string | null;
}

/** A normalised, render-ready evidence row — name + exactly one target. */
interface DisplayItem {
    id: string;
    name: string;
    /** FileRecord id → signed-URL download. */
    downloadId?: string;
    /** External URL → open in a new tab. */
    externalUrl?: string;
}

/** Last path segment of a URL (or the host) as a friendly label. */
function labelFromUrl(url: string): string {
    try {
        const u = new URL(url);
        return u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    } catch {
        return url;
    }
}

/**
 * Merge the evidence-tab GET payload (`{ evidence, links }`) into one clean
 * list. The control upload path writes BOTH an `Evidence` row (FILE, with a
 * title + fileRecordId) AND a `ControlEvidenceLink` bridge row (kind='FILE',
 * fileId) for the same file — so we dedupe link rows whose `fileId` already
 * appears as an Evidence `fileRecordId` (or whose URL is already shown). That
 * removes the blank, unclickable "Evidence" duplicate row. Every emitted item
 * carries a usable name and a download OR external target (TEXT evidence with
 * neither stays as a plain label).
 */
export function normalizeEvidence(data: { evidence?: RawEvidence[]; links?: RawLink[] }): DisplayItem[] {
    const out: DisplayItem[] = [];
    const seenFiles = new Set<string>();
    const seenUrls = new Set<string>();

    for (const e of data.evidence ?? []) {
        const externalUrl = e.type === 'LINK' ? e.content || undefined : undefined;
        const downloadId = e.fileRecordId || undefined;
        out.push({
            id: e.id,
            name:
                e.title ||
                e.fileName ||
                (externalUrl ? labelFromUrl(externalUrl) : 'Attached file'),
            downloadId,
            externalUrl,
        });
        if (downloadId) seenFiles.add(downloadId);
        if (externalUrl) seenUrls.add(externalUrl);
    }

    for (const l of data.links ?? []) {
        if (l.kind === 'FILE') {
            const fid = l.fileId || undefined;
            if (!fid || seenFiles.has(fid)) continue; // upload-bridge duplicate of an Evidence row
            seenFiles.add(fid);
            out.push({ id: l.id, name: l.note || 'Attached file', downloadId: fid });
        } else if (l.kind === 'LINK') {
            const url = l.url || undefined;
            if (!url || seenUrls.has(url)) continue;
            seenUrls.add(url);
            out.push({ id: l.id, name: l.note || labelFromUrl(url), externalUrl: url });
        }
        // INTEGRATION_RESULT (and anything else) has no rail-displayable target.
    }

    return out;
}

export interface EvidenceUploadSectionProps {
    tenantSlug: string;
    /** Which entity field the upload POST tags the evidence with. */
    linkField: 'controlId' | 'taskId' | 'riskId' | 'assetId';
    linkId: string;
    canWrite: boolean;
    /**
     * Optional tenant-scoped GET (no `/api/t/<slug>` prefix) returning
     * `{ links?, evidence? }`. When set, the section renders the attached
     * list below the dropzone and refreshes it after each upload.
     */
    listEndpoint?: string;
    /** Called after a batch of uploads settles (e.g. to refetch a parent list). */
    onUploaded?: () => void;
    /** Field label above the dropzone. Default "Files". */
    label?: string;
    /**
     * Optional URL-link affordance shown beneath the dropzone. Tenant-scoped
     * POST path (no `/api/t/<slug>` prefix) that links a URL as evidence —
     * e.g. `/controls/<id>/evidence` or `/risks/<id>/evidence/attached`.
     */
    urlLinkEndpoint?: string;
    /**
     * Builds the POST body for a URL link. Defaults to `{ url, note }`; the
     * control evidence route wants `{ kind: 'LINK', url, note }`.
     */
    urlLinkBody?: (url: string, note: string) => Record<string, unknown>;
    /**
     * Compact dropzone — a much shorter drop area for dense side-rail
     * panels (e.g. the Controls right-rail). Forwarded to FileDropzone.
     */
    compactDropzone?: boolean;
}

export function EvidenceUploadSection({
    tenantSlug,
    linkField,
    linkId,
    canWrite,
    listEndpoint,
    onUploaded,
    label,
    urlLinkEndpoint,
    urlLinkBody,
    compactDropzone = false,
}: EvidenceUploadSectionProps) {
    const t = useTranslations('panels.evidenceUpload');
    const labelText = label ?? t('files');
    const [items, setItems] = useState<DisplayItem[] | null>(null);
    const [url, setUrl] = useState('');
    const [note, setNote] = useState('');
    const [linking, setLinking] = useState(false);
    const [linkError, setLinkError] = useState('');

    // Items inserted optimistically from an upload's 201 response, kept until a
    // refetch confirms them. This makes a just-uploaded file appear instantly
    // and survive a momentarily-stale list GET (read-after-write lag), which is
    // why the control evidence list could lag behind the task one.
    const optimisticRef = useRef<DisplayItem[]>([]);

    const applyServerItems = useCallback((serverItems: DisplayItem[]) => {
        // Drop optimistic rows the server now returns (deduped by real id);
        // keep any not-yet-visible ones pinned to the top.
        const pending = optimisticRef.current.filter(
            (o) => !serverItems.some((s) => s.id === o.id),
        );
        optimisticRef.current = pending;
        setItems([...pending, ...serverItems]);
    }, []);

    const refetch = useCallback(async () => {
        if (!listEndpoint) return;
        try {
            // `no-store`: the list must reflect a just-uploaded/linked row
            // immediately — a cached GET would hide it even after a re-open.
            const res = await fetch(`/api/t/${tenantSlug}${listEndpoint}`, {
                cache: 'no-store',
            });
            if (!res.ok) return;
            const data = (await res.json()) as {
                evidence?: RawEvidence[];
                links?: RawLink[];
            };
            applyServerItems(normalizeEvidence(data));
        } catch {
            /* non-fatal — the dropzone still works */
        }
    }, [tenantSlug, listEndpoint, applyServerItems]);

    useEffect(() => {
        void refetch();
    }, [refetch]);

    const handleUpload = useCallback(
        (
            file: File,
            ctx: { onProgress: (percent: number | null) => void; signal: AbortSignal },
        ) => {
            const fd = new FormData();
            fd.append('file', file);
            fd.append(linkField, linkId);
            // Resolve to the created Evidence row (201 body) so we can show it
            // immediately without waiting on a consistent list refetch.
            return uploadWithProgress<RawEvidence>(
                `/api/t/${tenantSlug}/evidence/uploads`,
                fd,
                {
                    onProgress: (p) => ctx.onProgress(p.percent),
                    signal: ctx.signal,
                },
            );
        },
        [tenantSlug, linkField, linkId],
    );

    // Each successful file upload returns its created Evidence row — show it
    // optimistically the instant the upload settles.
    const onFileSettled = useCallback((entry: FileUploadEntry) => {
        if (entry.status !== 'success' || !entry.response) return;
        const [item] = normalizeEvidence({
            evidence: [entry.response as RawEvidence],
            links: [],
        });
        if (!item || optimisticRef.current.some((o) => o.id === item.id)) return;
        optimisticRef.current = [item, ...optimisticRef.current];
        setItems((prev) => {
            const base = prev ?? [];
            return base.some((i) => i.id === item.id) ? base : [item, ...base];
        });
    }, []);

    const onAllSettled = useCallback(() => {
        void refetch();
        onUploaded?.();
    }, [refetch, onUploaded]);

    const linkUrl = useCallback(async () => {
        const trimmed = url.trim();
        if (!trimmed || !urlLinkEndpoint) return;
        setLinking(true);
        setLinkError('');
        try {
            const body = urlLinkBody
                ? urlLinkBody(trimmed, note)
                : { url: trimmed, note: note.trim() || undefined };
            const res = await fetch(`/api/t/${tenantSlug}${urlLinkEndpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || err.message || t('failedLink'));
            }
            setUrl('');
            setNote('');
            void refetch();
            onUploaded?.();
        } catch (e) {
            setLinkError(e instanceof Error ? e.message : t('failedLink'));
        } finally {
            setLinking(false);
        }
    }, [url, note, urlLinkEndpoint, urlLinkBody, tenantSlug, refetch, onUploaded, t]);

    return (
        <div className="space-y-default" data-testid="evidence-upload-section">
            {canWrite && (
                <div>
                    <label className="mb-1 block text-xs font-medium text-content-muted">
                        {labelText}
                    </label>
                    <FileDropzone
                        accept={EVIDENCE_ACCEPT}
                        maxFileSizeMB={MAX_FILE_MB}
                        multiple
                        compact={compactDropzone}
                        hint={EVIDENCE_HINT}
                        onUpload={handleUpload}
                        onFileSettled={onFileSettled}
                        onAllSettled={onAllSettled}
                        data-testid="evidence-upload-dropzone"
                    />
                </div>
            )}
            {canWrite && urlLinkEndpoint && (
                <div
                    className="space-y-tight border-t border-border-subtle pt-default"
                    data-testid="evidence-link-url-form"
                >
                    <label className="block text-xs font-medium text-content-muted">
                        {t('orLinkUrl')}
                    </label>
                    <input
                        type="url"
                        className="input w-full"
                        placeholder={t('urlPlaceholder')}
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        data-testid="evidence-link-url"
                    />
                    <input
                        type="text"
                        className="input w-full"
                        placeholder={t('noteOptional')}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                    />
                    {linkError && (
                        <p className="text-xs text-content-error">{linkError}</p>
                    )}
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void linkUrl()}
                        disabled={!url.trim() || linking}
                        data-testid="evidence-link-url-submit"
                        text={linking ? t('linking') : t('linkUrl')}
                    />
                </div>
            )}
            {listEndpoint && items && items.length > 0 && (
                <ul className="space-y-tight" data-testid="evidence-attached-list">
                    {items.map((it) => {
                        // Download (FileRecord) takes precedence over external URL.
                        const href = it.downloadId
                            ? `/api/t/${tenantSlug}/evidence/files/${it.downloadId}/download`
                            : it.externalUrl || null;
                        const isFile = Boolean(it.downloadId);
                        return (
                            <li
                                key={it.id}
                                className="flex items-center gap-tight rounded-md border border-border-subtle bg-bg-default px-2.5 py-1.5 text-xs text-content-default"
                            >
                                {href ? (
                                    <a
                                        href={href}
                                        {...(isFile
                                            ? { download: it.name || undefined }
                                            : { target: '_blank', rel: 'noopener noreferrer' })}
                                        className="flex flex-1 items-center gap-tight truncate text-content-link hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)] rounded-sm"
                                        title={isFile ? t('downloadTitle', { name: it.name }) : t('openTitle', { name: it.name })}
                                        data-testid="evidence-attached-link"
                                    >
                                        {isFile ? (
                                            <Download aria-hidden className="size-3.5 shrink-0" />
                                        ) : (
                                            <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
                                        )}
                                        <span className="truncate">{it.name}</span>
                                    </a>
                                ) : (
                                    <span className="truncate" title={it.name}>
                                        {it.name}
                                    </span>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
