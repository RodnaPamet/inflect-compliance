/**
 * RQ-10 — report renderers (CSV + PDF + PPTX).
 *
 * `renderCsv` is pure (deterministic Buffer); `renderPdf` reuses the branded
 * `src/lib/pdf` pipeline; `renderPptx` produces a board slide deck via
 * pptxgenjs.
 *
 * @module reports/risk-report-render
 */
import PptxGenJS from 'pptxgenjs';
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import { addCoverPage, applyHeadersAndFooters } from '@/lib/pdf/layout';
import { addSectionTitle, addSummaryMetrics } from '@/lib/pdf/sections';
import { renderTable, autoColumnWidths } from '@/lib/pdf/table';
import { formatCompactCurrency } from '@/lib/risk-coherence';
import { formatTailAwareAle } from '@/lib/tail-language';
import { neutralizeCsvCell } from '@/lib/csv/format-csv';

export interface ReportData {
    /** RQ3-OB-A — tenant display currency (default €). */
    currencySymbol?: string;
    title: string;
    tenantName: string;
    generatedAt: string;
    totals: { totalRiskCount: number; quantifiedCount: number; totalAle: number; avgAle: number | null; maxAle: number | null };
    var: { mean: number | null; p95: number | null; p99: number | null } | null;
    appetite: { status: string; portfolioAle: number } | null;
    /** RQ3-4 — aleP90 from the per-risk percentile cache (null = no tail data). */
    topRisks: Array<{ title: string; category: string | null; ale: number; aleP90: number | null }>;
    bia: { withRto: number; withRpo: number; totalRevenueAtRisk: number };
}

// RQ3-OB-A — reports speak the tenant's currency via the canonical
// formatter; callers thread `currencySymbol` on ReportData.
const moneyFor = (data: ReportData) => (n: number | null | undefined) =>
    formatCompactCurrency(n, data.currencySymbol ?? '€');
const csvCell = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    // Neutralise first: the report TITLE is a user-created template name and
    // lands in row 1. Local name kept (it is this module's row formatter), but
    // the security half now comes from the shared helper so the two cannot
    // drift apart.
    const n = neutralizeCsvCell(s);
    return /[",\n]/.test(n) ? `"${n.replace(/"/g, '""')}"` : n;
};

/** CSV export — portfolio KPIs + top risks. Deterministic. */
export function renderCsv(data: ReportData): Buffer {
    const lines: string[] = [];
    lines.push(`Report,${csvCell(data.title)}`);
    lines.push(`Generated,${csvCell(data.generatedAt)}`);
    lines.push('');
    lines.push('Metric,Value');
    lines.push(`Total risks,${data.totals.totalRiskCount}`);
    lines.push(`Quantified risks,${data.totals.quantifiedCount}`);
    lines.push(`Total ALE,${Math.round(data.totals.totalAle)}`);
    lines.push(`Average ALE,${data.totals.avgAle == null ? '' : Math.round(data.totals.avgAle)}`);
    lines.push(`Max single ALE,${data.totals.maxAle == null ? '' : Math.round(data.totals.maxAle)}`);
    if (data.var) {
        lines.push(`Mean ALE (Monte Carlo),${data.var.mean == null ? '' : Math.round(data.var.mean)}`);
        lines.push(`VaR-95,${data.var.p95 == null ? '' : Math.round(data.var.p95)}`);
        lines.push(`VaR-99,${data.var.p99 == null ? '' : Math.round(data.var.p99)}`);
    }
    if (data.appetite) lines.push(`Appetite status,${csvCell(data.appetite.status)}`);
    lines.push(`BIA: risks with RTO,${data.bia.withRto}`);
    lines.push(`BIA: total revenue at risk,${Math.round(data.bia.totalRevenueAtRisk)}`);
    lines.push('');
    lines.push('Top risks by ALE');
    // RQ3-4 — the bad-year column ships raw (CSV is data, not prose);
    // empty when no simulation tail exists for the risk.
    lines.push('Risk,Category,ALE,Bad year (P90)');
    for (const r of data.topRisks) {
        lines.push([
            csvCell(r.title),
            csvCell(r.category),
            Math.round(r.ale),
            r.aleP90 != null && r.aleP90 > r.ale ? Math.round(r.aleP90) : '',
        ].join(','));
    }
    return Buffer.from(lines.join('\n'), 'utf8');
}

/** PDF export — branded cover + KPI summary + top-risks table. */
export async function renderPdf(data: ReportData): Promise<Buffer> {
    const money = moneyFor(data);
    const meta = { tenantName: data.tenantName, reportTitle: data.title, reportSubtitle: 'Risk quantification report', generatedAt: data.generatedAt };
    const doc = createPdfDocument(meta);
    addCoverPage(doc, meta);
    doc.addPage();

    addSectionTitle(doc, 'Portfolio summary');
    addSummaryMetrics(doc, [
        { label: 'Total risks', value: data.totals.totalRiskCount },
        { label: 'Quantified', value: data.totals.quantifiedCount },
        { label: 'Total ALE', value: money(data.totals.totalAle) },
        ...(data.var ? [{ label: 'VaR-95', value: money(data.var.p95) }] : []),
        ...(data.appetite ? [{ label: 'Appetite', value: data.appetite.status }] : []),
    ]);

    addSectionTitle(doc, 'Top risks by ALE');
    const widths = autoColumnWidths([3, 2, 2]);
    const columns = [
        { key: 'title', header: 'Risk', width: widths[0] },
        { key: 'category', header: 'Category', width: widths[1] },
        { key: 'ale', header: 'ALE', width: widths[2], align: 'right' as const },
    ];
    // RQ3-4 — each row speaks both registers through the one formatter.
    const rows = data.topRisks.map((r) => ({
        title: r.title,
        category: r.category ?? '—',
        ale: formatTailAwareAle(r.ale, r.aleP90, { money, compact: true }) ?? money(r.ale),
    }));
    renderTable(doc, columns, rows);

    applyHeadersAndFooters(doc, meta);
    return docToBuffer(doc);
}

/** Collect a finalized PDFKit document into a Buffer. */
function docToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}

/** PPTX export — a board slide deck: title, portfolio VaR KPIs, top risks. */
export async function renderPptx(data: ReportData): Promise<Buffer> {
    const money = moneyFor(data);
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
    pptx.layout = 'WIDE';

    // ── Title slide ──
    const title = pptx.addSlide();
    title.addText(data.title, { x: 0.6, y: 2.4, w: 12, h: 1, fontSize: 32, bold: true });
    title.addText(`${data.tenantName} · ${data.generatedAt.slice(0, 10)}`, { x: 0.6, y: 3.5, w: 12, h: 0.5, fontSize: 16, color: '6B7280' });

    // ── Portfolio VaR KPIs ──
    const kpis = pptx.addSlide();
    kpis.addText('Portfolio summary', { x: 0.6, y: 0.4, w: 12, h: 0.6, fontSize: 24, bold: true });
    const cards: Array<[string, string]> = [
        ['Total risks', String(data.totals.totalRiskCount)],
        ['Quantified', String(data.totals.quantifiedCount)],
        ['Total ALE', money(data.totals.totalAle)],
        ['Max single ALE', money(data.totals.maxAle)],
    ];
    if (data.var) { cards.push(['VaR-95', money(data.var.p95)]); cards.push(['VaR-99', money(data.var.p99)]); }
    if (data.appetite) cards.push(['Appetite', data.appetite.status]);
    cards.push(['Revenue at risk', money(data.bia.totalRevenueAtRisk)]);
    cards.forEach(([label, value], i) => {
        const col = i % 4, row = Math.floor(i / 4);
        const x = 0.6 + col * 3.1, y = 1.5 + row * 1.7;
        kpis.addText(value, { x, y, w: 2.9, h: 0.7, fontSize: 22, bold: true });
        kpis.addText(label, { x, y: y + 0.7, w: 2.9, h: 0.4, fontSize: 12, color: '6B7280' });
    });

    // ── Top risks table ──
    const top = pptx.addSlide();
    top.addText('Top risks by ALE', { x: 0.6, y: 0.4, w: 12, h: 0.6, fontSize: 24, bold: true });
    const rows: PptxGenJS.TableRow[] = [
        [
            { text: 'Risk', options: { bold: true } },
            { text: 'Category', options: { bold: true } },
            { text: 'ALE', options: { bold: true, align: 'right' } },
        ],
        ...data.topRisks.map((r): PptxGenJS.TableRow => [
            { text: r.title },
            { text: r.category ?? '—' },
            // RQ3-4 — board deck rows carry the bad-year register.
            { text: formatTailAwareAle(r.ale, r.aleP90, { money, compact: true }) ?? money(r.ale), options: { align: 'right' } },
        ]),
    ];
    top.addTable(rows, { x: 0.6, y: 1.3, w: 12, fontSize: 12, border: { type: 'solid', color: 'E5E7EB', pt: 1 } });

    const out = await pptx.write({ outputType: 'nodebuffer' });
    return out as Buffer;
}
