/**
 * PDF Generator Hardening Tests
 *
 * Verifies watermark, metadata page, totals row, and large dataset performance.
 */
import { ReportType } from '@/lib/pdf/types';
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import { addCoverPage, addMetadataPage, applyHeadersAndFooters } from '@/lib/pdf/layout';
import { renderTable, autoColumnWidths } from '@/lib/pdf/table';
import { addSectionTitle, addSummaryMetrics, addSpacer } from '@/lib/pdf/sections';
import type { ReportMeta, DataSourceNote } from '@/lib/pdf/types';

describe('ReportType enum', () => {
    it('has the three expected report types', () => {
        expect(ReportType.AUDIT_READINESS).toBe('AUDIT_READINESS');
        expect(ReportType.RISK_REGISTER).toBe('RISK_REGISTER');
        expect(ReportType.GAP_ANALYSIS).toBe('GAP_ANALYSIS');
    });
});

describe('PDF document factory', () => {
    it('creates a document that emits valid PDF bytes', (done) => {
        const meta: ReportMeta = {
            tenantName: 'Test Corp',
            reportTitle: 'Test Report',
            generatedAt: new Date().toISOString(),
        };

        const doc = createPdfDocument(meta);
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => {
            const pdf = Buffer.concat(chunks);
            expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
            expect(pdf.length).toBeGreaterThan(100);
            done();
        });

        doc.end();
    });

    it('renders cover + metadata + table + totals without errors', (done) => {
        const meta: ReportMeta = {
            tenantName: 'Test Corp',
            reportTitle: 'Full Test',
            reportSubtitle: 'With all sections',
            generatedAt: new Date().toISOString(),
            framework: 'ISO27001',
            watermark: 'DRAFT',
            contentHash: 'abc123def456',
        };

        const dataSources: DataSourceNote[] = [
            { source: 'Test Source', description: 'Test description for data source.' },
        ];

        const doc = createPdfDocument(meta);
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => {
            const pdf = Buffer.concat(chunks);
            expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
            expect(pdf.length).toBeGreaterThan(500);
            done();
        });

        // Cover
        addCoverPage(doc, meta);

        // Metadata page
        addMetadataPage(doc, meta, dataSources);

        // Content page
        doc.addPage();

        // Section
        addSectionTitle(doc, 'Test Section');
        addSummaryMetrics(doc, [
            { label: 'Total', value: 42 },
            { label: 'Done', value: 10 },
        ]);
        addSpacer(doc);

        // Table with totals
        const widths = autoColumnWidths([1, 2, 1]);
        renderTable(doc, [
            { key: 'id', header: 'ID', width: widths[0] },
            { key: 'name', header: 'Name', width: widths[1] },
            { key: 'status', header: 'Status', width: widths[2], align: 'center' },
        ], [
            { id: '1', name: 'Test item one', status: 'PASS' },
            { id: '2', name: 'Test item two with a longer name that should wrap', status: 'FAIL' },
            { id: '3', name: 'Item three', status: 'PENDING' },
        ], undefined, {
            values: { id: 'TOTAL', name: '3 items', status: '' },
        });

        // Headers/footers/watermarks
        applyHeadersAndFooters(doc, meta);

        doc.end();
    });

    it('generates FINAL watermark without errors', (done) => {
        const meta: ReportMeta = {
            tenantName: 'Audit Corp',
            reportTitle: 'Final Report',
            generatedAt: new Date().toISOString(),
            watermark: 'FINAL',
        };

        const doc = createPdfDocument(meta);
        const chunks: Buffer[] = [];

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => {
            const pdf = Buffer.concat(chunks);
            expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
            done();
        });

        addCoverPage(doc, meta);
        doc.addPage();
        addSectionTitle(doc, 'Content');
        applyHeadersAndFooters(doc, meta);
        doc.end();
    });
});

/**
 * ─── Removed 2026-09-06: the 1000-row wall-clock ceiling ─────────────
 *
 * This block asserted `expect(Date.now() - startTime).toBeLessThan(30_000)`
 * over a 1000-row render, and its own comment conceded where the number
 * came from: "under the full-suite parallel run, CPU contention pushes
 * this far beyond the 5 s headline". That is the defect in one
 * sentence — the ceiling was sized by the runner rather than by the
 * subject. Measured on an 8-core box, `--runInBand`: the render costs
 * 1126-1357 ms, so the ceiling sat 22-27x above it, and the entire slack
 * was there to absorb contention.
 *
 * That slack is bigger than the regression. Making `renderTable`
 * re-measure every row inside the draw loop — the exact thing its own
 * "Pre-measure all row heights (O(n) — avoids re-measuring)" comment
 * says it does not do, and a doubling of the measuring pass — moved the
 * render to 1428 ms. Inside the healthy band, and 21x under the ceiling.
 * So: could fail with nothing broken, could not fail with something
 * broken.
 *
 * The replacement asserts the same claim as WORK. `doc.heightOfString`
 * is reached from exactly one place, `measureRowHeight`, once per cell,
 * so the count is `(rows + totals row) x columns` — the same integer on
 * any machine under any load. Two mutations, each the sole assertion
 * that fires (1 failed, 4 passed):
 *
 *   * re-measure every row in the draw loop — 6006 → 12006 calls
 *   * re-measure once per page break — 6006 → 6378 calls
 *
 * The second is a 6% increase in work. No wall-clock ceiling wide
 * enough to survive a shared runner could ever see it; an exact count
 * sees it without a clock. This table renders 65 pages, which the
 * `pageCount` assertion pins so that second case stays in scope.
 *
 * Same defect class and same remedy as the sites retired alongside it:
 * tests/unit/encryption-middleware.perf.test.ts,
 * tests/unit/observability/shutdown-helpers.test.ts,
 * tests/unit/framework-tree-builder.test.ts.
 *
 * KNOWN BLIND SPOT, and it is the same trade as the encryption file: a
 * count sees REDUNDANT work, not SLOWER work. A `heightOfString` that
 * became 4x more expensive per call is invisible here. The 30 s ceiling
 * could not see that on this hardware either — 4x of 1.2 s is still
 * 6x under it — but on a runner slow enough to make the ceiling tight
 * it could have, and that is what is given up.
 */
describe('Large dataset rendering', () => {
    const PERF_ROWS = 1000;

    it('measures each cell exactly once across a 1000-row, many-page table', (done) => {
        const meta: ReportMeta = {
            tenantName: 'Perf Corp',
            reportTitle: 'Performance Test',
            generatedAt: new Date().toISOString(),
            watermark: 'DRAFT',
        };

        const widths = autoColumnWidths([0.5, 2, 1, 1, 1.5, 2]);
        const columns = [
            { key: 'num', header: '#', width: widths[0], align: 'center' as const },
            { key: 'title', header: 'Risk', width: widths[1] },
            { key: 'likelihood', header: 'L', width: widths[2], align: 'center' as const },
            { key: 'impact', header: 'I', width: widths[3], align: 'center' as const },
            { key: 'treatment', header: 'Treatment', width: widths[4] },
            { key: 'notes', header: 'Notes', width: widths[5] },
        ];
        const rows = Array.from({ length: PERF_ROWS }, (_, i) => ({
            num: String(i + 1),
            title: `Risk item ${i + 1} — description with enough text to test multi-line cell wrapping behavior`,
            likelihood: String(Math.ceil(Math.random() * 5)),
            impact: String(Math.ceil(Math.random() * 5)),
            treatment: ['Mitigate', 'Accept', 'Transfer', 'Avoid'][i % 4],
            notes: i % 3 === 0 ? 'This is a longer note that should wrap across multiple lines in the cell' : '—',
        }));

        // One `measureRowHeight` pass per data row plus the totals row,
        // one `heightOfString` inside it per column. Derived from the
        // fixture rather than typed as a literal, so adding a column
        // moves the expectation because the table moved.
        const expectedMeasuredCells = (rows.length + 1) * columns.length;

        const doc = createPdfDocument(meta);
        const chunks: Buffer[] = [];
        let pageCount = 0;

        // Spy the document INSTANCE, not the prototype: this counts the
        // work that this render asked for and nothing else.
        const heightOfString = jest.spyOn(doc, 'heightOfString');

        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => {
            const pdf = Buffer.concat(chunks);

            try {
                // Valid PDF
                expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
                // Should be substantial (1000 rows = many pages)
                expect(pdf.length).toBeGreaterThan(10000);
                // The table really does span many pages, so a
                // re-measure driven by page breaks is in scope here.
                expect(pageCount).toBeGreaterThan(10);

                expect(heightOfString).toHaveBeenCalledTimes(expectedMeasuredCells);
            } catch (err) {
                heightOfString.mockRestore();
                done(err as Error);
                return;
            }

            heightOfString.mockRestore();
            done();
        });

        addCoverPage(doc, meta);
        addMetadataPage(doc, meta, [
            { source: 'Performance Test', description: `${PERF_ROWS} rows of synthetic data` },
        ]);
        doc.addPage();

        renderTable(doc, columns, rows, undefined, {
            values: { num: '', title: `${PERF_ROWS} risks total`, likelihood: '', impact: '', treatment: '', notes: '' },
        });

        applyHeadersAndFooters(doc, meta);
        pageCount = doc.bufferedPageRange().count;

        doc.end();
    }, 60_000); // Liveness only — nothing here asserts on elapsed time.
});
