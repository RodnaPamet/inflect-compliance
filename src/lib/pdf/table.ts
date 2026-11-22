/**
 * PDF Table Renderer
 *
 * Renders bordered tables with alternating rows, automatic page-break
 * with repeated headers, wrapped cell text, and optional totals row.
 */
import type { TableColumn, TableRenderOptions, TotalsRow } from './types';
import { BRAND, MARGINS, CONTENT_WIDTH } from './pdfKitFactory';
import { SAFE_BOTTOM_Y } from './layout';

const DEFAULTS: Required<TableRenderOptions> = {
    headerBg: BRAND.navy,
    headerColor: BRAND.white,
    altRowBg: '#f8fafc',
    fontSize: 8,
    rowPadding: 6,
    startY: 0,
};

/**
 * Render a data table on the PDF.
 * Supports multi-line wrapping, automatic page-break with repeated headers,
 * and an optional totals row.
 * Returns the final Y position after the table.
 */
export function renderTable(
    doc: PDFKit.PDFDocument,
    columns: TableColumn[],
    rows: Record<string, unknown>[],
    opts?: TableRenderOptions,
    totals?: TotalsRow,
): number {
    const o = { ...DEFAULTS, ...opts };
    let y = o.startY || doc.y;
    const x0 = MARGINS.left;

    // ─── Draw header row ───

    y = drawHeaderRow(doc, columns, x0, y, o);

    // ─── Pre-measure all row heights (O(n) — avoids re-measuring) ───

    const rowData: { texts: string[]; height: number }[] = [];
    for (let i = 0; i < rows.length; i++) {
        const texts = columns.map(col => String(rows[i][col.key] ?? '—'));
        const height = measureRowHeight(doc, columns, texts, o);
        rowData.push({ texts, height });
    }

    // ─── Draw data rows ───

    for (let i = 0; i < rowData.length; i++) {
        const { texts, height } = rowData[i];
        const isAlt = i % 2 === 1;

        // Page break check — repeat header on new page
        if (y + height > SAFE_BOTTOM_Y) {
            doc.addPage();
            y = MARGINS.top + 20;
            y = drawHeaderRow(doc, columns, x0, y, o);
        }

        // Row background
        if (isAlt) {
            doc.rect(x0, y, CONTENT_WIDTH, height).fill(o.altRowBg);
        }

        // Cell text (multi-line wrapping is handled by PDFKit lineBreak: true)
        drawRowCells(doc, columns, texts, x0, y, height, o);

        // Row bottom border
        doc.moveTo(x0, y + height).lineTo(x0 + CONTENT_WIDTH, y + height)
            .strokeColor(BRAND.medGray).lineWidth(0.3).stroke();

        y += height;
        doc.y = y;
    }

    // ─── Totals row ───

    if (totals) {
        const totalTexts = columns.map(col => totals.values[col.key] ?? '');
        const totalHeight = measureRowHeight(doc, columns, totalTexts, o) + 2;

        if (y + totalHeight > SAFE_BOTTOM_Y) {
            doc.addPage();
            y = MARGINS.top + 20;
            y = drawHeaderRow(doc, columns, x0, y, o);
        }

        // Totals background
        const totalsBg = totals.bg || BRAND.lightGray;
        doc.rect(x0, y, CONTENT_WIDTH, totalHeight).fill(totalsBg);

        // Top border (thicker)
        doc.moveTo(x0, y).lineTo(x0 + CONTENT_WIDTH, y)
            .strokeColor(BRAND.navy).lineWidth(1).stroke();

        // Cell text in bold
        let cellX = x0;
        for (let c = 0; c < columns.length; c++) {
            const col = columns[c];
            const text = totalTexts[c];
            if (text) {
                doc.fontSize(o.fontSize).fillColor(BRAND.navy).font('Helvetica-Bold')
                    .text(text, cellX + o.rowPadding, y + o.rowPadding + 1, {
                        width: col.width - o.rowPadding * 2,
                        align: col.align || 'left',
                        lineBreak: true,
                        // Draw no more than was measured (see drawRowCells).
                        height: totalHeight - o.rowPadding * 2,
                        ellipsis: true,
                    });
            }
            cellX += col.width;
        }
        doc.font('Helvetica');

        // Bottom border
        doc.moveTo(x0, y + totalHeight).lineTo(x0 + CONTENT_WIDTH, y + totalHeight)
            .strokeColor(BRAND.navy).lineWidth(1).stroke();

        y += totalHeight;
        doc.y = y;
    }

    return y;
}

// ─── Helpers ───

function drawHeaderRow(
    doc: PDFKit.PDFDocument,
    columns: TableColumn[],
    x0: number,
    y: number,
    o: Required<TableRenderOptions>,
): number {
    const headerHeight = o.fontSize + o.rowPadding * 2 + 4;

    // Header background
    doc.rect(x0, y, CONTENT_WIDTH, headerHeight).fill(o.headerBg);

    // Header text
    let cellX = x0;
    for (const col of columns) {
        doc.fontSize(o.fontSize).fillColor(o.headerColor).font('Helvetica-Bold')
            .text(col.header, cellX + o.rowPadding, y + o.rowPadding + 1, {
                width: col.width - o.rowPadding * 2,
                align: col.align || 'left',
                lineBreak: false,
            });
        cellX += col.width;
    }
    doc.font('Helvetica');

    return y + headerHeight;
}

function drawRowCells(
    doc: PDFKit.PDFDocument,
    columns: TableColumn[],
    texts: string[],
    x0: number,
    y: number,
    rowHeight: number,
    o: Required<TableRenderOptions>,
): void {
    let cellX = x0;
    for (let c = 0; c < columns.length; c++) {
        const col = columns[c];
        const text = texts[c];

        doc.fontSize(o.fontSize).fillColor(BRAND.navy).font('Helvetica');
        doc.text(text, cellX + o.rowPadding, y + o.rowPadding, {
            width: col.width - o.rowPadding * 2,
            align: col.align || 'left',
            lineBreak: true,
            // The text box is the row the layout measured and reserved. A
            // cell longer than the cap used to be drawn in full past the row
            // border, over the next rows and across a PDFKit auto page
            // break (#5316); the cap now clips it, with an ellipsis.
            height: rowHeight - o.rowPadding * 2,
            ellipsis: true,
        });

        cellX += col.width;
    }
}

function measureRowHeight(
    doc: PDFKit.PDFDocument,
    columns: TableColumn[],
    cellTexts: string[],
    o: Required<TableRenderOptions>,
): number {
    let maxH = o.fontSize + o.rowPadding * 2;

    for (let c = 0; c < columns.length; c++) {
        const col = columns[c];
        const textWidth = col.width - o.rowPadding * 2;
        const h = doc.fontSize(o.fontSize).heightOfString(cellTexts[c], { width: textWidth }) + o.rowPadding * 2;
        if (h > maxH) maxH = h;
    }

    return Math.min(maxH, maxRowHeight(o));
}

/**
 * The tallest a row may be: what fits on a fresh page below the repeated
 * header. A row is never taller than a page, so the page-break check before
 * it always leaves it room; only text longer than a whole page is clipped.
 * (A fixed 120pt cap clipped nothing — the text was drawn in full anyway and
 * overprinted the rows below it.)
 */
function maxRowHeight(o: Required<TableRenderOptions>): number {
    const headerHeight = o.fontSize + o.rowPadding * 2 + 4;
    return SAFE_BOTTOM_Y - (MARGINS.top + 20) - headerHeight;
}

/**
 * Auto-calculate column widths to fill CONTENT_WIDTH proportionally.
 * Pass relative weights and get absolute widths back.
 */
export function autoColumnWidths(weights: number[]): number[] {
    const total = weights.reduce((s, w) => s + w, 0);
    return weights.map(w => (w / total) * CONTENT_WIDTH);
}
