/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PR-U acceptance — shown == exported, and no ISO literal leaks for non-ISO.
 *
 * The Audit Readiness PDF is computed off the SAME readiness spine
 * (`generateReadinessReport`) the on-screen readiness view renders. This test
 * mocks the PDF primitives (not pdf-parse — that text extraction is
 * environment-fragile) and inspects the DATA the generator hands them:
 *
 *   (a) the summary-metric VALUES equal the readiness payload numbers exactly
 *       (so the exported headline == the on-screen headline), and
 *   (b) for a NON-ISO framework (hasStatementOfApplicability:false), NO ISO SoA literal
 *       (Annex A / Statement of Applicability / SoA / Applicable / Justification)
 *       appears in any string the generator emits.
 */

const mockGenerateReadinessReport = jest.fn();
const mockResolveInstalledFrameworkKey = jest.fn();

// Capture buffers for every PDF primitive that receives display strings.
const summaryMetricsCalls: any[][] = [];
const sectionTitles: string[] = [];
const paragraphs: string[] = [];
const tableCalls: Array<{ columns: any[]; rows: any[]; totals: any }> = [];

jest.mock('@/app-layer/usecases/framework/coverage', () => ({
    generateReadinessReport: (...a: any[]) => mockGenerateReadinessReport(...a),
}));
jest.mock('@/app-layer/usecases/soa', () => ({
    resolveInstalledFrameworkKey: (...a: any[]) => mockResolveInstalledFrameworkKey(...a),
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenant: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme' }) } },
}));

jest.mock('@/lib/pdf/pdfKitFactory', () => ({
    createPdfDocument: () => ({ addPage: jest.fn(), y: 0 }),
    BRAND: {}, MARGINS: {}, CONTENT_WIDTH: 500,
}));
jest.mock('@/lib/pdf/layout', () => ({
    addCoverPage: jest.fn(),
    addMetadataPage: jest.fn(),
    applyHeadersAndFooters: jest.fn(),
}));
jest.mock('@/lib/pdf/table', () => ({
    renderTable: (_doc: any, columns: any[], rows: any[], _opts: any, totals: any) => {
        tableCalls.push({ columns, rows, totals });
        return 0;
    },
    autoColumnWidths: (ratios: number[]) => ratios.map(() => 100),
}));
jest.mock('@/lib/pdf/sections', () => ({
    addSectionTitle: (_doc: any, title: string) => { sectionTitles.push(title); },
    addSummaryMetrics: (_doc: any, metrics: any[]) => { summaryMetricsCalls.push(metrics); },
    addParagraph: (_doc: any, text: string) => { paragraphs.push(text); },
    addSpacer: jest.fn(),
}));

import { generateAuditReadinessPdf } from '@/app-layer/reports/pdf/auditReadiness';
import { makeRequestContext } from '../../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

// A non-ISO (SOC 2) framework with known, distinctive numbers.
const NON_ISO_PAYLOAD = {
    framework: { key: 'SOC2', name: 'SOC 2', version: null },
    hasStatementOfApplicability: false,
    generatedAt: '2026-07-16T00:00:00.000Z',
    coverage: { total: 20, mapped: 12, unmapped: 8, coveragePercent: 60 },
    bySection: [
        { section: 'Security', total: 12, mapped: 8, coveragePercent: 67 },
        { section: 'Availability', total: 8, mapped: 4, coveragePercent: 50 },
    ],
    unmappedRequirements: [
        { code: 'CC6.1', title: 'Logical access', section: 'Security' },
        { code: 'CC7.2', title: 'Monitoring', section: 'Security' },
    ],
    notApplicableControls: [],
    controlsMissingEvidence: [],
    overdueTasks: [],
    summary: {
        totalRequirements: 20,
        mappedRequirements: 12,
        coveragePercent: 60,
        implementedRequirements: 3,
        gapRequirements: 2,
        exceptedRequirements: 1,
        notApplicableCount: 0,
        missingEvidenceCount: 1,
        overdueTaskCount: 1,
        readinessScore: 55,
    },
};

/** Every display string the generator handed the mocked PDF primitives. */
function allEmittedStrings(): string {
    const parts: string[] = [];
    parts.push(...sectionTitles, ...paragraphs);
    for (const metrics of summaryMetricsCalls) {
        for (const m of metrics) parts.push(String(m.label), String(m.value));
    }
    for (const t of tableCalls) {
        for (const c of t.columns) parts.push(String(c.header), String(c.key));
        for (const r of t.rows) parts.push(...Object.values(r).map((v) => String(v)));
        if (t.totals?.values) parts.push(...Object.values(t.totals.values).map((v) => String(v)));
    }
    return parts.join(' | ');
}

function metric(label: string): any {
    const metrics = summaryMetricsCalls.flat();
    return metrics.find((m) => m.label === label);
}

beforeEach(() => {
    jest.clearAllMocks();
    summaryMetricsCalls.length = 0;
    sectionTitles.length = 0;
    paragraphs.length = 0;
    tableCalls.length = 0;
    mockResolveInstalledFrameworkKey.mockResolvedValue('SOC2');
    mockGenerateReadinessReport.mockResolvedValue(NON_ISO_PAYLOAD);
});

describe('Audit Readiness PDF — shown == exported (non-ISO)', () => {
    it('summary-metric values equal the readiness payload numbers', async () => {
        await generateAuditReadinessPdf(ctx, { framework: 'SOC2' });

        const s = NON_ISO_PAYLOAD.summary;
        // Each headline number the export prints matches the on-screen readiness view.
        expect(metric('Total Requirements')?.value).toBe(s.totalRequirements);
        expect(metric('Mapped')?.value).toBe(s.mappedRequirements);
        expect(metric('Coverage')?.value).toBe(`${s.coveragePercent}%`);
        expect(metric('Implemented')?.value).toBe(s.implementedRequirements);
        expect(metric('Gaps')?.value).toBe(s.gapRequirements);
        expect(metric('Excepted')?.value).toBe(s.exceptedRequirements);
        expect(metric('Readiness')?.value).toBe(`${s.readinessScore}/100`);
    });

    it('the per-section coverage TOTAL footer equals the payload totals', async () => {
        await generateAuditReadinessPdf(ctx, { framework: 'SOC2' });

        const coverageTable = tableCalls.find((t) => t.totals?.values?.section === 'TOTAL');
        expect(coverageTable).toBeDefined();
        expect(coverageTable!.totals.values.total).toBe(String(NON_ISO_PAYLOAD.summary.totalRequirements));
        expect(coverageTable!.totals.values.mapped).toBe(String(NON_ISO_PAYLOAD.summary.mappedRequirements));
        expect(coverageTable!.totals.values.coverage).toBe(`${NON_ISO_PAYLOAD.summary.coveragePercent}%`);
    });

    it('leaks NO ISO SoA literal for a non-ISO framework', async () => {
        await generateAuditReadinessPdf(ctx, { framework: 'SOC2' });

        const emitted = allEmittedStrings();
        for (const rx of [
            /Annex\s*A/i,
            /Statement of Applicability/i,
            /\bSoA\b/,
            /Applicable/i,
            /Justification/i,
            /ISO\s*27001/i,
        ]) {
            expect(emitted).not.toMatch(rx);
        }
    });
});
