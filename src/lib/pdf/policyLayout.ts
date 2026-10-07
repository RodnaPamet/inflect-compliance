/**
 * Policy-document PDF layout helpers (B9).
 *
 * Specialised stamping for the policy export. Distinct from the
 * generic `addCoverPage` + `addMetadataPage` used by Risk Register
 * / Audit Readiness because a published policy carries metadata
 * those reports don't:
 *
 *   • A brand wordmark "logo" stamped on the cover (text-rendered,
 *     no image asset to manage).
 *   • A classification block (Public / Internal / Confidential /
 *     Restricted) with a coloured chip so the reader sees the
 *     handling tier at a glance.
 *   • Effective + review dates rendered alongside the version
 *     number — published policies need a one-line provenance row,
 *     not a separate metadata page.
 *   • A clickable Table of Contents — every TOC row links to its
 *     section via PDFKit's `addNamedDestination` / `goTo: name`
 *     annotation pair. Pages stamp their own destination at top of
 *     section.
 *   • Explicit `addPage()` between sections so a long Purpose
 *     section doesn't bleed into Scope mid-paragraph.
 *
 * Page header / footer reuse the generic `applyHeadersAndFooters`
 * stamping pass — the chrome doesn't differ; what differs is which
 * `ReportMeta.watermark` value is wired (the classification chip
 * uses its OWN field, not the watermark).
 */
import {
    BRAND,
    MARGINS,
    PAGE_WIDTH,
    CONTENT_WIDTH,
} from './pdfKitFactory';
import { SAFE_BOTTOM_Y } from './layout';
import { formatDateShort } from '@inflect/ui/lib/format-date';

// ─── Classification ────────────────────────────────────────────────

export type PolicyClassification =
    | 'PUBLIC'
    | 'INTERNAL'
    | 'CONFIDENTIAL'
    | 'RESTRICTED';

const CLASSIFICATION_COLOUR: Record<PolicyClassification, string> = {
    PUBLIC: '#22c55e', //  brand.green
    INTERNAL: '#7c3aed', //  brand.purple
    CONFIDENTIAL: '#f59e0b', //  brand.amber
    RESTRICTED: '#ef4444', //  brand.red
};

export const CLASSIFICATION_LABEL: Record<PolicyClassification, string> = {
    PUBLIC: 'Public',
    INTERNAL: 'Internal',
    CONFIDENTIAL: 'Confidential',
    RESTRICTED: 'Restricted',
};

// ─── Policy meta ───────────────────────────────────────────────────

export interface PolicyPdfMeta {
    /** The tenant the policy lives in. Rendered as the "logo" wordmark. */
    tenantName: string;
    /** The policy title — appears as the cover page H1. */
    policyTitle: string;
    /** Optional category — surfaces alongside the version row. */
    category?: string | null;
    /** Lifecycle version number (1 = initial, 2+ = published). */
    versionNumber: number;
    /** Optional effective date (ISO string). Today's date if omitted. */
    effectiveAt?: string | null;
    /** Optional next-review date (ISO string). */
    nextReviewAt?: string | null;
    /** Optional owner name. */
    ownerName?: string | null;
    /**
     * The policy's handling classification. Drives the cover chip
     * + the per-page footer suffix.
     */
    classification: PolicyClassification;
    generatedAt: string;
}

// ─── Cover page ────────────────────────────────────────────────────

/**
 * Render the policy front page (cover). Sets the cursor below the
 * cover by calling `addPage()` at the end so the caller can
 * continue with TOC + body uninterrupted.
 */
export function addPolicyCoverPage(
    doc: PDFKit.PDFDocument,
    meta: PolicyPdfMeta,
): void {
    // Top navy band — narrower than the generic cover so the brand
    // wordmark sits in a defined header area.
    doc.rect(0, 0, PAGE_WIDTH, 100).fill(BRAND.navy);

    // Brand wordmark "logo" — text-rendered. The dot + "Inflect" is
    // the canonical lockup; the dot is `BRAND.purple` so it tracks
    // the same accent the other cover pages use.
    doc.fontSize(8)
        .fillColor(BRAND.slateLight)
        .font('Helvetica')
        .text('POWERED BY', MARGINS.left, 35, { width: 200 });

    doc.fontSize(18)
        .fillColor(BRAND.white)
        .font('Helvetica-Bold')
        .text('● Inflect', MARGINS.left, 50, { width: 200 });

    // Tenant name on the right (the policy's "publisher").
    doc.fontSize(10)
        .fillColor(BRAND.slateLight)
        .font('Helvetica')
        .text(meta.tenantName, PAGE_WIDTH - MARGINS.right - 200, 40, {
            width: 200,
            align: 'right',
        });
    doc.fontSize(9)
        .text('Policy Document', PAGE_WIDTH - MARGINS.right - 200, 56, {
            width: 200,
            align: 'right',
        });

    // Title block — middle of the page.
    doc.fontSize(28)
        .fillColor(BRAND.navy)
        .font('Helvetica-Bold')
        .text(meta.policyTitle, MARGINS.left, 200, {
            width: CONTENT_WIDTH,
        });

    // Category subtitle (optional).
    if (meta.category) {
        doc.fontSize(13)
            .fillColor(BRAND.slate)
            .font('Helvetica')
            .text(meta.category, MARGINS.left, doc.y + 4, {
                width: CONTENT_WIDTH,
            });
    }

    // Brand-purple separator under the title block.
    doc.rect(MARGINS.left, doc.y + 16, 80, 4).fill(BRAND.purple);

    // Classification chip — coloured pill matching the level.
    const chipY = doc.y + 36;
    const chipColour = CLASSIFICATION_COLOUR[meta.classification];
    const chipLabel = `CLASSIFICATION · ${CLASSIFICATION_LABEL[meta.classification].toUpperCase()}`;
    doc.fontSize(9)
        .fillColor(BRAND.white)
        .font('Helvetica-Bold');
    const chipWidth = doc.widthOfString(chipLabel) + 24;
    doc.roundedRect(MARGINS.left, chipY, chipWidth, 22, 11).fill(chipColour);
    doc.fillColor(BRAND.white).text(chipLabel, MARGINS.left + 12, chipY + 6, {
        width: chipWidth,
        height: 16,
        lineBreak: false,
    });
    doc.y = chipY + 40;

    // Provenance row — version, effective date, review date, owner.
    doc.fontSize(9).fillColor(BRAND.slate).font('Helvetica');
    const provLines: Array<[string, string]> = [
        ['Version', `v${meta.versionNumber}`],
        [
            'Effective from',
            meta.effectiveAt ? formatDateShort(meta.effectiveAt) : formatDateShort(meta.generatedAt),
        ],
    ];
    if (meta.nextReviewAt) {
        provLines.push(['Next review', formatDateShort(meta.nextReviewAt)]);
    }
    if (meta.ownerName) {
        provLines.push(['Owner', meta.ownerName]);
    }
    for (const [k, v] of provLines) {
        doc.font('Helvetica-Bold').fillColor(BRAND.slate).text(
            `${k}: `,
            MARGINS.left,
            doc.y,
            { continued: true },
        );
        doc.font('Helvetica').fillColor(BRAND.navy).text(v);
    }

    // Page-break to start the TOC on a clean page.
    doc.addPage();
}

// ─── Clickable TOC ────────────────────────────────────────────────

export interface PolicyTocEntry {
    /** Section heading exactly as rendered. */
    title: string;
    /**
     * The stable destination name registered via
     * `addNamedDestination(...)` on the page that opens this
     * section. The TOC row's link annotation uses
     * `link({ goTo: name })` so a click jumps directly.
     */
    destName: string;
}

/**
 * Render a clickable Table of Contents. Each row carries a
 * `link` annotation routing to a `addNamedDestination(name)`
 * registered when the section opens.
 *
 * The caller must:
 *   1. Pass the entries in the desired display order.
 *   2. Before writing the FIRST line of each section's content,
 *      call `doc.addNamedDestination(entry.destName)`. (PDFKit
 *      registers the destination at the current page + scroll
 *      position.)
 */
export function addPolicyToc(
    doc: PDFKit.PDFDocument,
    entries: PolicyTocEntry[],
): void {
    // Title.
    doc.fontSize(16)
        .fillColor(BRAND.navy)
        .font('Helvetica-Bold')
        .text('Table of Contents', MARGINS.left, MARGINS.top + 20);

    const underlineY = doc.y + 4;
    doc.moveTo(MARGINS.left, underlineY)
        .lineTo(MARGINS.left + 60, underlineY)
        .strokeColor(BRAND.purple)
        .lineWidth(2)
        .stroke();

    doc.font('Helvetica');
    doc.y = underlineY + 16;

    // Rows.
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const lineY = doc.y;
        const rowText = `${i + 1}. ${entry.title}`;

        doc.fontSize(11).fillColor(BRAND.navy).font('Helvetica');
        // Reserve the full content width so the underline sits past
        // the visible glyphs — keeps the link target hit-box
        // generous.
        doc.text(rowText, MARGINS.left, lineY, {
            width: CONTENT_WIDTH,
            // PDFKit accepts `goTo` directly on TextOptions to wire
            // an internal-document link annotation pointing at the
            // named destination registered by addPolicySectionTitle.
            goTo: entry.destName,
            underline: false,
            // `height:` locks the text cell — see STAMP_TEXT_HEIGHT
            // discussion in layout.ts for why this matters.
            height: 18,
        });

        // Underline the link in subtle purple so it reads as
        // interactive without screaming.
        const lineEndY = doc.y + 14;
        doc.moveTo(MARGINS.left, lineEndY)
            .lineTo(
                MARGINS.left + doc.widthOfString(rowText, { fontSize: 11 } as PDFKit.Mixins.TextOptions),
                lineEndY,
            )
            .strokeColor(BRAND.purple)
            .lineWidth(0.4)
            .stroke();

        doc.y = lineEndY + 8;
    }

    // Page break — body starts on the next page.
    doc.addPage();
}

// ─── Section helpers ──────────────────────────────────────────────

/**
 * Open a new section: emits the named destination at the current
 * cursor (which the TOC link points to), the section title with
 * brand-purple underline, and resets the cursor to the body.
 *
 * `addPage()` is the caller's responsibility — this helper is
 * intentionally pageless so the caller can choose whether each
 * section forces a new page.
 */
export function addPolicySectionTitle(
    doc: PDFKit.PDFDocument,
    title: string,
    destName: string,
): void {
    // Register the destination at the TOP of the page — that's
    // where a TOC click should land.
    doc.addNamedDestination(destName);

    doc.fontSize(16)
        .fillColor(BRAND.navy)
        .font('Helvetica-Bold')
        .text(title, MARGINS.left, doc.y);

    const underlineY = doc.y + 4;
    doc.moveTo(MARGINS.left, underlineY)
        .lineTo(MARGINS.left + 60, underlineY)
        .strokeColor(BRAND.purple)
        .lineWidth(2)
        .stroke();

    doc.font('Helvetica');
    doc.y = underlineY + 14;
}

/**
 * Render a markdown-ish body paragraph. Honours the same
 * page-break safety as the generic `addParagraph`, but uses the
 * policy-document-tuned line gap so longer-form prose reads as a
 * document, not a report table.
 */
export function addPolicyBodyParagraph(
    doc: PDFKit.PDFDocument,
    text: string,
): void {
    if (doc.y + 30 > SAFE_BOTTOM_Y) {
        doc.addPage();
        doc.y = MARGINS.top + 20;
    }

    doc.fontSize(10)
        .fillColor(BRAND.navy)
        .font('Helvetica')
        .text(text, MARGINS.left, doc.y, {
            width: CONTENT_WIDTH,
            lineGap: 4,
            paragraphGap: 6,
        });
    doc.y += 8;
}
