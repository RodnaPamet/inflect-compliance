"use client";

/**
 * `<EvidenceGallery>` — visual exploration view for evidence rows.
 *
 * Companion to the table view that's already wired through
 * `<DataTable>`. The same filter context drives both — toggling
 * between views in `EvidenceClient` swaps the renderer, not the
 * data, so search / filter / retention-tab state preserves cleanly.
 *
 * What the gallery is good at:
 *
 *   - Image evidence — inline thumbnails (lazy-loaded) make a stack
 *     of screenshots scannable in a way the table never could.
 *   - PDF evidence — stylized cards with the PDF icon + filename +
 *     freshness/retention/status badges. A click opens the download
 *     URL (which the existing tenant-scoped download route serves
 *     either as a stream or a presigned redirect).
 *   - Mixed file types — the dropzone, list, and gallery all share
 *     the `resolveFileTypeIcon` mapping, so non-previewable kinds
 *     (CSV / DOCX / ZIP / Link / Text) fall back to a clean icon
 *     card without breaking the grid.
 *
 * Performance posture:
 *
 *   - Native `<img loading="lazy">` for image thumbnails — every
 *     mainstream browser since 2020 handles the intersection-based
 *     deferral natively without a JS framework.
 *   - `decoding="async"` so the main thread doesn't block on a
 *     thousand decodes when scrolling fast.
 *   - One DOM node per card (no per-card React Query subscription).
 *     Scaling past ~500 cards would warrant `react-virtual` or
 *     similar, but that's beyond this prompt — the dataset cap on
 *     the existing list endpoint is identical.
 */

import { useMemo, type CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { isScanServable } from '@/lib/evidence-scan';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Download } from '@/components/ui/icons/nucleo';
import {
    FileTypeIcon,
    resolveFileTypeIcon,
} from '@/components/ui/file-type-icon';
import { FreshnessBadge } from '@/components/ui/FreshnessBadge';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';

// ─── Types ──────────────────────────────────────────────────────────

export interface EvidenceGalleryRow {
    id: string;
    title: string;
    fileName?: string | null;
    type: string;
    status: string;
    /** Set when the row has a stored file (FILE kind). */
    fileRecordId?: string | null;
    /** Optional MIME + AV verdict — repository includes them via fileRecord. */
    fileRecord?: { mimeType?: string | null; scanStatus?: string | null } | null;
    fileMimeType?: string | null;
    /**
     * Review-currency anchor for the freshness badge — `nextReviewDate ??
     * expiredAt`, the SAME value the table cell uses via
     * `reviewCurrencyAnchor`.
     *
     * The old doc claimed this was `updatedAt`-driven; it was neither.
     * `EvidenceRow` never carried a `lastRefreshedAt` field at all, so
     * `row.lastRefreshedAt` resolved to undefined and EVERY gallery card
     * rendered "no refresh recorded" — while the same rows in the table
     * showed real freshness. Toggling table→gallery silently changed the
     * meaning of identical data.
     */
    lastRefreshedAt?: string | Date | null;
    /** Optional review date — used to derive the anchor when the caller
     *  passes raw rows rather than pre-computing `lastRefreshedAt`. */
    nextReviewDate?: string | Date | null;
    retentionUntil?: string | null;
    isArchived?: boolean;
    expiredAt?: string | null;
    deletedAt?: string | null;
}

export interface EvidenceGalleryProps<T extends EvidenceGalleryRow> {
    rows: T[];
    /**
     * SSR-hydration-safe "now" for the freshness badges. Supplied by the
     * page (`useHydratedNow()`), exactly as the table cell does — without
     * it each badge falls back to its own `new Date()`, which is
     * non-deterministic under SSR and can disagree with the table.
     */
    now?: Date;
    loading?: boolean;
    emptyState?: React.ReactNode;
    /** Build a download URL for a file row. Returning null hides the
     *  thumbnail/preview affordance (e.g. permissions filter). */
    fileUrl: (row: T) => string | null;
    /**
     * Optional click handler — passes the row. When omitted, image
     * cards are clickable links to `fileUrl(row)` and non-previewable
     * cards are static (the table view's actions remain the canonical
     * mutation surface).
     */
    onRowClick?: (row: T) => void;
    /** Status badge resolver (re-uses the table's STATUS_BADGE map). */
    statusBadgeVariant?: (status: string) => StatusBadgeVariant;
    /** Localized status label resolver (re-uses the table's statusLabel). */
    statusLabel?: (status: string) => string;
    /** Retention status resolver (re-uses the table's getRetentionStatus). */
    retentionStatus?: (
        row: T,
    ) => { label: string; badge: StatusBadgeVariant } | null;
    /**
     * Bulk-selection parity with the table. When both are supplied,
     * each card renders a selection checkbox wired to the SAME
     * selection state the table uses.
     */
    selectedIds?: ReadonlySet<string>;
    onToggleSelect?: (id: string, next: boolean) => void;
    /** Localized aria-label for the per-card download control. */
    downloadLabel?: string;
    /** A11y: gallery region label. */
    'aria-label'?: string;
    /** Outer test id. */
    'data-testid'?: string;
    /** Override grid breakpoints. */
    style?: CSSProperties;
}

// ─── Component ──────────────────────────────────────────────────────

export function EvidenceGallery<T extends EvidenceGalleryRow>({
    rows,
    now,
    loading,
    emptyState,
    fileUrl,
    onRowClick,
    statusBadgeVariant,
    statusLabel,
    retentionStatus,
    selectedIds,
    onToggleSelect,
    downloadLabel = 'Download',
    'aria-label': ariaLabel = 'Evidence gallery',
    'data-testid': dataTestId = 'evidence-gallery',
    style,
}: EvidenceGalleryProps<T>) {
    const items = useMemo(() => rows, [rows]);

    if (loading && rows.length === 0) {
        return (
            <div
                className="grid grid-cols-1 gap-default sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                aria-busy="true"
                data-testid={`${dataTestId}-loading`}
            >
                {Array.from({ length: 6 }).map((_, i) => (
                    <div
                        key={i}
                        className="h-56 animate-pulse rounded-lg bg-bg-elevated/60"
                    />
                ))}
            </div>
        );
    }

    if (rows.length === 0) {
        return (
            <Card
                elevation="inset"
                className="text-center text-sm text-content-muted p-8"
                density="none"
                data-testid={`${dataTestId}-empty`}
            >
                {emptyState ?? 'No evidence to show.'}
            </Card>
        );
    }

    return (
        <div
            role="grid"
            aria-label={ariaLabel}
            data-testid={dataTestId}
            className="grid grid-cols-1 gap-default sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            style={style}
        >
            {items.map((row) => (
                <GalleryCard
                    key={row.id}
                    row={row}
                    now={now}
                    fileUrl={fileUrl}
                    onRowClick={onRowClick}
                    statusBadgeVariant={statusBadgeVariant}
                    statusLabel={statusLabel}
                    retentionStatus={retentionStatus}
                    selected={selectedIds?.has(row.id) ?? false}
                    onToggleSelect={onToggleSelect}
                    selectable={!!(selectedIds && onToggleSelect)}
                    downloadLabel={downloadLabel}
                />
            ))}
        </div>
    );
}

// ─── Card ───────────────────────────────────────────────────────────

interface GalleryCardProps<T extends EvidenceGalleryRow> {
    row: T;
    /** Shared hydration-safe clock for the freshness badge. */
    now?: Date;
    fileUrl: (row: T) => string | null;
    onRowClick?: (row: T) => void;
    statusBadgeVariant?: (status: string) => StatusBadgeVariant;
    statusLabel?: (status: string) => string;
    retentionStatus?: (row: T) => { label: string; badge: StatusBadgeVariant } | null;
    selectable?: boolean;
    selected?: boolean;
    onToggleSelect?: (id: string, next: boolean) => void;
    downloadLabel?: string;
}

function GalleryCard<T extends EvidenceGalleryRow>({
    row,
    now,
    fileUrl,
    onRowClick,
    statusBadgeVariant,
    statusLabel,
    retentionStatus,
    selectable,
    selected,
    onToggleSelect,
    downloadLabel = 'Download',
}: GalleryCardProps<T>) {
    const mime =
        row.fileRecord?.mimeType ??
        row.fileMimeType ??
        null;
    const match = resolveFileTypeIcon(row.fileName, mime, row.type);
    const url = fileUrl(row);
    // R5-P2 #1 — never auto-fetch a thumbnail/PDF (or offer download) for a file
    // the AV gate would block; fall through to the file-type icon instead.
    const scanServable = isScanServable(row.fileRecord?.scanStatus);
    const isImage = match.label === 'Image' && url !== null && scanServable;
    const isPdf = match.label === 'PDF' && url !== null && scanServable;

    const retention = retentionStatus?.(row) ?? null;
    const statusVariant: StatusBadgeVariant = statusBadgeVariant?.(row.status) ?? 'neutral';

    const isPending = String(row.id).startsWith('temp:');

    const onClick = () => {
        if (isPending) return;
        if (onRowClick) onRowClick(row);
    };

    return (
        <Card
            elevation="inset"
            density="none"
            role="gridcell"
            data-testid={`evidence-gallery-card-${row.id}`}
            data-file-kind={match.label.toLowerCase()}
            className={cn(
                'group relative flex flex-col overflow-hidden transition-colors duration-150 ease-out hover:border-border-emphasis hover:bg-bg-muted',
                onRowClick && !isPending && 'cursor-pointer',
            )}
            onClick={onClick}
            onKeyDown={(e) => {
                if (!onRowClick || isPending) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick();
                }
            }}
            tabIndex={onRowClick && !isPending ? 0 : -1}
        >
            {/* Thumbnail / preview */}
            <div className="relative h-40 w-full overflow-hidden bg-bg-muted">
                {/* Bulk-selection checkbox — parity with the table.
                    Stops propagation so ticking the box doesn't open the
                    detail sheet. */}
                {selectable && !isPending && (
                    <div
                        className="absolute left-2 top-2 z-10"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                    >
                        <Checkbox
                            checked={selected}
                            onCheckedChange={(next) =>
                                onToggleSelect?.(row.id, next === true)
                            }
                            aria-label={row.title}
                            className="bg-bg-default"
                            data-testid={`evidence-gallery-select-${row.id}`}
                        />
                    </div>
                )}
                {/* Download affordance — every file-backed card, not just
                    PDFs. Non-file cards (LINK/TEXT) resolve `url === null`
                    and render nothing here. */}
                {url && !isPending && scanServable && (
                    <a
                        href={url}
                        download
                        aria-label={downloadLabel}
                        className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border-subtle bg-bg-default/90 text-content-muted transition-colors hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(e) => e.stopPropagation()}
                        data-testid={`evidence-gallery-download-${row.id}`}
                    >
                        <Download className="size-3.5" />
                    </a>
                )}
                {isImage ? (
                    // eslint-disable-next-line @next/next/no-img-element -- The src is a runtime tenant-scoped /api download URL with auth cookies; next/image needs declared remote-pattern allowlists + known dimensions, neither of which fits a per-tenant evidence thumbnail. `loading="lazy" decoding="async"` provides the perf characteristics that matter.
                    <img
                        src={url!}
                        alt={row.title}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                        data-testid={`evidence-gallery-thumb-${row.id}`}
                        onError={(e) => {
                            // Fallback: hide the broken-image glyph and
                            // let the file-type icon below stand in.
                            (e.target as HTMLImageElement).style.display =
                                'none';
                        }}
                    />
                ) : isPdf ? (
                    <PdfPreviewPlaceholder
                        url={url!}
                        title={row.title}
                        rowId={String(row.id)}
                    />
                ) : (
                    <div
                        className="flex h-full w-full items-center justify-center"
                        data-testid={`evidence-gallery-iconfallback-${row.id}`}
                    >
                        <FileTypeIcon
                            fileName={row.fileName ?? null}
                            mime={mime}
                            domainKind={row.type}
                            size={48}
                        />
                    </div>
                )}
                {isPending && (
                    <div className="absolute inset-0 flex items-center justify-center bg-bg-default/60 backdrop-blur-sm">
                        <span className="text-xs text-content-muted">
                            Uploading…
                        </span>
                    </div>
                )}
            </div>

            {/* Body */}
            <div className="flex flex-1 flex-col gap-tight p-3">
                <div className="flex items-start gap-tight">
                    <FileTypeIcon
                        fileName={row.fileName ?? null}
                        mime={mime}
                        domainKind={row.type}
                        size={14}
                        className="mt-0.5"
                    />
                    <div className="min-w-0">
                        <p
                            className="truncate text-sm font-medium text-content-emphasis"
                            title={row.title}
                        >
                            {row.title}
                        </p>
                        {row.fileName && row.fileName !== row.title && (
                            <p
                                className="truncate text-xs text-content-subtle"
                                title={row.fileName}
                            >
                                {row.fileName}
                            </p>
                        )}
                    </div>
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                    <FreshnessBadge
                        lastRefreshedAt={row.lastRefreshedAt ?? row.nextReviewDate ?? row.expiredAt ?? null}
                        now={now}
                        compact
                        data-testid={`evidence-gallery-freshness-${row.id}`}
                    />
                    {retention && (
                        <StatusBadge variant={retention.badge}>
                            {retention.label}
                        </StatusBadge>
                    )}
                    {row.status && row.status !== 'PENDING_UPLOAD' && (
                        <StatusBadge variant={statusVariant}>
                            {statusLabel?.(row.status) ?? row.status}
                        </StatusBadge>
                    )}
                </div>
            </div>
        </Card>
    );
}

// ─── PDF placeholder ────────────────────────────────────────────────
//
// We deliberately don't `<embed>` PDFs — embedding hundreds of PDF
// viewers in a grid is a known browser-perf footgun, and most operators
// just need to recognise the document and click through to the real
// viewer in a tab. The placeholder uses the same file-type icon
// vocabulary as the rest of the app + a "Preview" CTA pointing at the
// download URL.

function PdfPreviewPlaceholder({
    url,
    title,
    rowId,
}: {
    url: string;
    title: string;
    rowId: string;
}) {
    return (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-rose-500/10 to-rose-500/5 transition-colors hover:from-rose-500/20 hover:to-rose-500/10"
            data-testid={`evidence-gallery-pdfthumb-${rowId}`}
            aria-label={`Open PDF: ${title}`}
            onClick={(e) => e.stopPropagation()}
        >
            <FileTypeIcon fileName="x.pdf" size={48} />
            <span className="text-xs text-content-muted">Open PDF</span>
        </a>
    );
}
