/**
 * PDF Layout Helpers
 *
 * Cover page, page header/footer, watermark, and metadata page.
 */
import type { ReportMeta, DataSourceNote } from './types';
import { BRAND, MARGINS, PAGE_WIDTH, PAGE_HEIGHT, CONTENT_WIDTH } from './pdfKitFactory';
import { formatDateTime, formatDateTimeLong, formatDateShort } from '@inflect/ui/lib/format-date';

// ─── Cover Page ───

export function addCoverPage(doc: PDFKit.PDFDocument, meta: ReportMeta): void {
    // Background band
    doc.rect(0, 0, PAGE_WIDTH, 280).fill(BRAND.navy);

    // Tenant name (top-left)
    doc.fontSize(11).fillColor(BRAND.slateLight)
        .text(meta.tenantName, MARGINS.left, 40, { width: CONTENT_WIDTH });

    // Report title
    doc.fontSize(28).fillColor(BRAND.white)
        .text(meta.reportTitle, MARGINS.left, 100, { width: CONTENT_WIDTH });

    if (meta.reportSubtitle) {
        doc.fontSize(14).fillColor(BRAND.slateLight)
            .text(meta.reportSubtitle, MARGINS.left, 145, { width: CONTENT_WIDTH });
    }

    // Date + framework. Epic 58 — route the "Generated:" timestamp
    // through the canonical formatter so the cover page matches the
    // rest of the app (en-GB, UTC). Previously used an inline
    // `toLocaleDateString` that followed the server's host timezone —
    // an evidence PDF could show "10:00" while the app UI of the
    // same moment showed "12:00" if the server ran in CET.
    doc.fontSize(10).fillColor(BRAND.slateLight)
        .text(`Generated: ${formatDateTime(meta.generatedAt)}`, MARGINS.left, 200);

    if (meta.framework) {
        doc.text(`Framework: ${meta.framework}`, MARGINS.left, 216);
    }

    // Decorative purple line
    doc.rect(MARGINS.left, 250, 80, 4).fill(BRAND.purple);

    // "CONFIDENTIAL" label
    doc.fontSize(9).fillColor(BRAND.slate)
        .text('CONFIDENTIAL', MARGINS.left, 310);

    doc.fontSize(9).fillColor(BRAND.slate)
        .text('This document contains sensitive compliance information and is intended for authorized personnel only.', MARGINS.left, 326, { width: CONTENT_WIDTH });

    // Watermark badge on cover
    if (meta.watermark && meta.watermark !== 'NONE') {
        const badgeColor = meta.watermark === 'DRAFT' ? '#ef4444' : '#22c55e';
        doc.fontSize(12).fillColor(badgeColor).font('Helvetica-Bold')
            .text(meta.watermark, PAGE_WIDTH - MARGINS.right - 80, 40, { width: 80, align: 'right' });
        doc.font('Helvetica');
    }

    // Move cursor past cover
    doc.y = 400;
}

// ─── Report Metadata Page ───

export function addMetadataPage(doc: PDFKit.PDFDocument, meta: ReportMeta, dataSources?: DataSourceNote[]): void {
    doc.addPage();

    // Title
    doc.fontSize(16).fillColor(BRAND.navy).font('Helvetica-Bold')
        .text('Report Information', MARGINS.left, MARGINS.top + 20);

    const lineY = doc.y + 4;
    doc.moveTo(MARGINS.left, lineY).lineTo(MARGINS.left + 60, lineY)
        .strokeColor(BRAND.purple).lineWidth(2).stroke();

    doc.font('Helvetica');
    doc.y = lineY + 16;

    // Key-value pairs. Epic 58 — audit-quality timestamp through the
    // canonical formatter (en-GB + UTC + weekday + seconds). The
    // previous inline `toLocaleString` silently followed the host's
    // timezone, which meant the same PDF could produce different
    // audit timestamps depending on which region the build ran in.
    const kvPairs: [string, string][] = [
        ['Organization', meta.tenantName],
        ['Report Title', meta.reportTitle],
        ['Generated At', formatDateTimeLong(meta.generatedAt)],
    ];
    if (meta.framework) kvPairs.push(['Framework', meta.framework]);
    if (meta.watermark && meta.watermark !== 'NONE') kvPairs.push(['Status', meta.watermark]);
    if (meta.contentHash) kvPairs.push(['Content Hash (SHA-256)', meta.contentHash]);

    for (const [key, value] of kvPairs) {
        doc.fontSize(9).fillColor(BRAND.slate).font('Helvetica-Bold')
            .text(`${key}: `, MARGINS.left, doc.y, { continued: true });
        doc.font('Helvetica').fillColor(BRAND.navy)
            .text(value);
    }

    doc.y += 20;

    // Data Sources
    if (dataSources && dataSources.length > 0) {
        doc.fontSize(12).fillColor(BRAND.navy).font('Helvetica-Bold')
            .text('Data Sources', MARGINS.left, doc.y);
        doc.font('Helvetica');
        doc.y += 8;

        for (const ds of dataSources) {
            doc.fontSize(9).fillColor(BRAND.navy).font('Helvetica-Bold')
                .text(`• ${ds.source}`, MARGINS.left + 8, doc.y);
            doc.font('Helvetica').fillColor(BRAND.slate)
                .text(ds.description, MARGINS.left + 16, doc.y, { width: CONTENT_WIDTH - 16 });
            doc.y += 4;
        }
    }

    doc.y += 16;

    // Disclaimer
    doc.fontSize(8).fillColor(BRAND.slate)
        .text('This report reflects the state of the system at the time of generation. Data may have changed since this report was produced. This document is generated automatically and should be reviewed by authorized personnel before use in formal audit proceedings.', MARGINS.left, doc.y, { width: CONTENT_WIDTH, lineGap: 2 });
}

// ─── Page Header ───

/**
 * Fixed text-cell height (pt) passed to every `text()` call inside
 * the header / footer / watermark stamping pass.
 *
 * Why this is load-bearing — root cause of the trailing-blank-page bug:
 *
 *   PDFKit's `text(str, x, y, opts)` auto-paginates if after writing
 *   the text cursor (`doc.y`) crosses the bottom margin. The footer
 *   renders at `y = PAGE_HEIGHT - 30 = 811.89`, which is ALREADY
 *   below the bottom margin (`PAGE_HEIGHT - MARGINS.bottom = 791.89`).
 *   A single text write there ends with the cursor past the margin;
 *   the SECOND text write (page number) then triggers auto-paginate
 *   and silently appends a blank page. With N real pages, the
 *   stamping loop appends N blank pages — every Audit Readiness /
 *   SoA export emitted N trailing blanks.
 *
 *   `lineBreak: false` (the prior workaround) ONLY suppresses
 *   word-wrap. `doc.save() / doc.restore()` only preserves the
 *   graphics state, NOT the text cursor. Setting `doc.y` between
 *   writes is too late — auto-paginate has already fired.
 *
 *   The supported way to bypass pdfkit's pagination check is to
 *   pass `height:` on the text options. PDFKit treats the write as
 *   bounded and skips the post-write cursor check.
 *
 * The fix is applied uniformly across header + footer + watermark
 * (defence in depth — a future stamp that doesn't quite reach the
 * margin today might cross it after a font / margin change).
 */
const STAMP_TEXT_HEIGHT = 12;

export function addHeader(doc: PDFKit.PDFDocument, meta: ReportMeta): void {
    const y = 20;
    doc.save();

    // Left: tenant name
    doc.fontSize(7).fillColor(BRAND.slate)
        .text(meta.tenantName, MARGINS.left, y, { width: 200, lineBreak: false, height: STAMP_TEXT_HEIGHT });

    // Center: report title
    const titleWidth = doc.widthOfString(meta.reportTitle, { fontSize: 7 } as PDFKit.Mixins.TextOptions);
    doc.text(meta.reportTitle, (PAGE_WIDTH - titleWidth) / 2, y, { width: 300, lineBreak: false, align: 'center', height: STAMP_TEXT_HEIGHT });

    // Right: date. Epic 58 — canonical `formatDateShort` returns the
    // same "DD/MM/YYYY" the inline call produced, but locked to UTC
    // so the header is stable across server regions and matches the
    // cover/metadata timestamps that Epic 58 also canonicalised.
    const dateStr = formatDateShort(meta.generatedAt);
    doc.text(dateStr, PAGE_WIDTH - MARGINS.right - 100, y, { width: 100, align: 'right', lineBreak: false, height: STAMP_TEXT_HEIGHT });

    // Bottom line
    doc.moveTo(MARGINS.left, y + 14).lineTo(PAGE_WIDTH - MARGINS.right, y + 14)
        .strokeColor(BRAND.medGray).lineWidth(0.5).stroke();

    doc.restore();
}

// ─── Page Footer ───

export function addFooter(doc: PDFKit.PDFDocument, meta: ReportMeta, pageNum: number, totalPages: number): void {
    const y = PAGE_HEIGHT - 30;
    doc.save();

    // Top line
    doc.moveTo(MARGINS.left, y - 6).lineTo(PAGE_WIDTH - MARGINS.right, y - 6)
        .strokeColor(BRAND.medGray).lineWidth(0.5).stroke();

    // Left: confidential + hash. `height` short-circuits pdfkit's
    // auto-pagination (see STAMP_TEXT_HEIGHT comment above).
    const hashSuffix = meta.contentHash ? ` | Hash: ${meta.contentHash.slice(0, 12)}…` : '';
    doc.fontSize(7).fillColor(BRAND.slate)
        .text(`CONFIDENTIAL — Inflect Compliance${hashSuffix}`, MARGINS.left, y, { lineBreak: false, height: STAMP_TEXT_HEIGHT });

    // Right: page number — second write on the same line; without
    // `height` this is the call that historically triggered the
    // trailing-blank-page cascade.
    doc.text(`Page ${pageNum} of ${totalPages}`, PAGE_WIDTH - MARGINS.right - 80, y, { width: 80, align: 'right', lineBreak: false, height: STAMP_TEXT_HEIGHT });

    doc.restore();
}

// ─── Watermark ───

export function addWatermark(doc: PDFKit.PDFDocument, text: string): void {
    doc.save();

    doc.fontSize(60)
        .fillColor(BRAND.slate)
        .opacity(0.06);

    // Diagonal watermark centered on page
    const textWidth = doc.widthOfString(text);
    const cx = PAGE_WIDTH / 2;
    const cy = PAGE_HEIGHT / 2;

    doc.translate(cx, cy)
        .rotate(-35, { origin: [0, 0] })
        // `height` defends against future watermark-text changes
        // shifting `doc.y` past the bottom margin (same pdfkit
        // auto-paginate trap that broke the footer; see
        // STAMP_TEXT_HEIGHT comment on `addHeader`).
        .text(text, -textWidth / 2, -30, { lineBreak: false, height: 80 });

    doc.restore();
    // Reset opacity
    doc.opacity(1);
}

// ─── Wire headers/footers/watermarks to all pages ───

/**
 * Stamp header / footer / watermark onto every buffered page.
 *
 * Page-numbering convention: the cover (page index 0) gets neither
 * a header nor a page-number footer — it's a title page, numbering
 * starts on the first content page (which is the metadata page,
 * displayed as "Page 1 of N"). N is the count of pages that show
 * a number — i.e., total pages minus the cover.
 *
 * Total-page count comes from `doc.bufferedPageRange().count`. The
 * caller must NOT mutate the document after invoking this function
 * (subsequent writes wouldn't be reflected in the stamped footers)
 * — `addPage` calls inside content builders must already be done.
 * The auto-paginate trap (see `STAMP_TEXT_HEIGHT` comment on
 * `addHeader`) is what historically created N blank trailing pages
 * during THIS loop; with `height:` on every text write inside
 * `addHeader` / `addFooter` / `addWatermark`, the loop is now
 * idempotent w.r.t. the page count.
 */
export function applyHeadersAndFooters(doc: PDFKit.PDFDocument, meta: ReportMeta): void {
    const pages = doc.bufferedPageRange();
    const watermarkText = meta.watermark && meta.watermark !== 'NONE' ? meta.watermark : null;

    // Page index 0 is the cover. Numbered pages start at index 1.
    // The "X of N" label uses N = numbered-page count = total - 1
    // so the first numbered page reads "Page 1 of M", not "Page 2".
    const numberedPageTotal = Math.max(0, pages.count - 1);

    for (let i = pages.start; i < pages.start + pages.count; i++) {
        doc.switchToPage(i);

        // Cover gets no header + no page-number footer (just clean
        // title page). The Confidential note + page number both
        // belong to the numbered range.
        if (i === pages.start) {
            continue;
        }

        addHeader(doc, meta);
        // i - pages.start = 1 for first numbered page (the
        // metadata page), 2 for the next, etc. — matches the
        // `numberedPageTotal` shape.
        addFooter(doc, meta, i - pages.start, numberedPageTotal);

        if (watermarkText) {
            addWatermark(doc, watermarkText);
        }
    }
}

// ─── Safe zone: Y beyond which we should page-break ───

export const SAFE_BOTTOM_Y = PAGE_HEIGHT - MARGINS.bottom - 20;
