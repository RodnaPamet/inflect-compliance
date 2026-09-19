/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Gap Analysis PDF generator — computed off the readiness spine
 * (`generateReadinessReport`), NOT the old SoA engine. "Gap" here means the two
 * on-screen populations: unmapped (no mapping) + mapped-but-not-implemented.
 *
 * Strategy: mock the data-fetching boundary (generateReadinessReport,
 * resolveInstalledFrameworkKey, prisma) and let the REAL pdfkit-backed
 * layout/table/section helpers run under node. Branches exercised:
 *   - totalGaps === 0 (no-gaps paragraph) vs > 0 (gap-count paragraph)
 *   - unmappedRequirements empty ("No Unmapped Requirements") vs populated (table + sort)
 *   - tenant name present vs absent; watermark option vs default
 *   - options.framework present (forwarded) vs absent (resolve path)
 */

const mockGenerateReadinessReport = jest.fn();
const mockResolveInstalledFrameworkKey = jest.fn();
const mockTenantFindUnique = jest.fn();

jest.mock('@/app-layer/usecases/framework/coverage', () => ({
    generateReadinessReport: (...args: any[]) => mockGenerateReadinessReport(...args),
}));

jest.mock('@/app-layer/usecases/soa', () => ({
    resolveInstalledFrameworkKey: (...args: any[]) => mockResolveInstalledFrameworkKey(...args),
}));

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenant: { findUnique: (...args: any[]) => mockTenantFindUnique(...args) },
    },
}));

import { generateGapAnalysisPdf } from '@/app-layer/reports/pdf/gapAnalysis';
import { makeRequestContext } from '../../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function unmapped(over: Partial<any> = {}): any {
    return {
        code: over.code ?? 'A.5.1',
        title: over.title ?? 'Policies for information security',
        section: over.section ?? 'Organizational',
    };
}

function readinessReport(over: Partial<any> = {}): any {
    const unmappedRequirements = over.unmappedRequirements ?? [];
    const summary = {
        totalRequirements: 10,
        mappedRequirements: 8,
        coveragePercent: 80,
        implementedRequirements: 6,
        gapRequirements: 2,
        exceptedRequirements: 1,
        notApplicableCount: 0,
        missingEvidenceCount: 0,
        overdueTaskCount: 0,
        readinessScore: 72,
        ...(over.summary ?? {}),
    };
    return {
        framework: over.framework ?? { key: 'ISO27001', name: 'ISO 27001', version: '2022' },
        hasStatementOfApplicability: over.hasStatementOfApplicability ?? true,
        generatedAt: over.generatedAt ?? new Date().toISOString(),
        coverage: {
            total: summary.totalRequirements,
            mapped: summary.mappedRequirements,
            unmapped: over.coverage?.unmapped ?? unmappedRequirements.length,
            coveragePercent: summary.coveragePercent,
            ...(over.coverage ?? {}),
        },
        bySection: over.bySection ?? [],
        unmappedRequirements,
        notApplicableControls: [],
        controlsMissingEvidence: [],
        overdueTasks: [],
        summary,
    };
}

async function renderToBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.end();
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockTenantFindUnique.mockResolvedValue({ name: 'Acme Corp' });
    mockResolveInstalledFrameworkKey.mockResolvedValue('ISO27001');
});

describe('generateGapAnalysisPdf', () => {
    it('no gaps (0 unmapped, 0 mapped-not-implemented): no-gaps paragraph + "No Unmapped Requirements"', async () => {
        // Branch: totalGaps === 0 → labels.noGapsParagraph;
        // unmappedRequirements empty → "No Unmapped Requirements" section.
        mockGenerateReadinessReport.mockResolvedValue(
            readinessReport({
                summary: { gapRequirements: 0 },
                coverage: { unmapped: 0 },
                unmappedRequirements: [],
            }),
        );

        const doc = await generateGapAnalysisPdf(ctx, { framework: 'ISO27001' });
        const buf = await renderToBuffer(doc);

        expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
        expect(mockGenerateReadinessReport).toHaveBeenCalledWith(ctx, 'ISO27001');
        expect(mockResolveInstalledFrameworkKey).not.toHaveBeenCalled();
    });

    it('gaps present: gap-count paragraph + Unmapped Requirements table (sorted)', async () => {
        // Branch: totalGaps > 0 → gap-count paragraph; unmappedRequirements
        // populated → Unmapped table with numeric-aware sort + null-section '—'.
        mockGenerateReadinessReport.mockResolvedValue(
            readinessReport({
                summary: { gapRequirements: 2 },
                unmappedRequirements: [
                    unmapped({ code: 'A.5.10', section: 'Org' }),
                    unmapped({ code: 'A.5.2', section: 'Org' }),
                    unmapped({ code: 'A.6.1', section: null }),
                ],
            }),
        );

        const doc = await generateGapAnalysisPdf(ctx, { watermark: 'FINAL', framework: 'ISO27001' });
        const buf = await renderToBuffer(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('mapped-but-not-implemented only (no unmapped) still counts as gaps', async () => {
        // Branch: totalGaps = 0 unmapped + gapRequirements > 0 → gap paragraph,
        // but the Unmapped table falls to the "No Unmapped Requirements" arm.
        mockGenerateReadinessReport.mockResolvedValue(
            readinessReport({
                summary: { gapRequirements: 4 },
                coverage: { unmapped: 0 },
                unmappedRequirements: [],
            }),
        );

        const doc = await generateGapAnalysisPdf(ctx, { framework: 'ISO27001' });
        const buf = await renderToBuffer(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('no explicit framework → resolves the installed framework key', async () => {
        // Branch: options.framework absent → resolveInstalledFrameworkKey(ctx).
        mockResolveInstalledFrameworkKey.mockResolvedValue('NIS2');
        mockGenerateReadinessReport.mockResolvedValue(
            readinessReport({ framework: { key: 'NIS2', name: 'NIS2', version: null }, hasStatementOfApplicability: false }),
        );

        const doc = await generateGapAnalysisPdf(ctx);
        const buf = await renderToBuffer(doc);

        expect(buf.length).toBeGreaterThan(0);
        expect(mockResolveInstalledFrameworkKey).toHaveBeenCalledWith(ctx);
        expect(mockGenerateReadinessReport).toHaveBeenCalledWith(ctx, 'NIS2');
    });

    it('absent tenant name falls back to "Tenant"', async () => {
        // Branch: tenant?.name || 'Tenant'.
        mockTenantFindUnique.mockResolvedValue(null);
        mockGenerateReadinessReport.mockResolvedValue(
            readinessReport({ summary: { gapRequirements: 0 }, coverage: { unmapped: 0 } }),
        );

        const doc = await generateGapAnalysisPdf(ctx, { framework: 'ISO27001' });
        const buf = await renderToBuffer(doc);
        expect(buf.length).toBeGreaterThan(0);
    });
});
