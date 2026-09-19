/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Audit Readiness PDF generator — computed off the readiness spine
 * (`generateReadinessReport`), NOT the old SoA engine.
 *
 * Strategy: mock the data-fetching boundary (generateReadinessReport,
 * resolveInstalledFrameworkKey, prisma) and let the REAL pdfkit-backed
 * layout/table/section helpers run under node. The generator's own branches
 * are exercised by varying the mocked readiness payload:
 *   - gaps === 0 && unmapped === 0 (audit-ready paragraph) vs not (gap paragraph)
 *   - unmappedRequirements empty (no Unmapped table) vs populated (Unmapped table + sort)
 *   - bySection empty vs populated (Coverage-by-section rows + TOTAL footer)
 *   - tenant name present vs absent ('Tenant' fallback)
 *   - options.framework present (forwarded) vs absent (resolveInstalledFrameworkKey path)
 *   - watermark option vs default 'NONE'
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

import { generateAuditReadinessPdf } from '@/app-layer/reports/pdf/auditReadiness';
import { makeRequestContext } from '../../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function unmapped(over: Partial<any> = {}): any {
    return {
        code: over.code ?? 'A.5.1',
        title: over.title ?? 'Policies for information security',
        section: over.section ?? 'Organizational',
    };
}

function section(over: Partial<any> = {}): any {
    return {
        section: over.section ?? 'Organizational',
        total: over.total ?? 10,
        mapped: over.mapped ?? 8,
        coveragePercent: over.coveragePercent ?? 80,
    };
}

/**
 * Build a `generateReadinessReport` payload. Numbers default to a
 * partially-ready ISO framework; override per-branch.
 */
function readinessReport(over: Partial<any> = {}): any {
    const bySection = over.bySection ?? [section()];
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
        bySection,
        unmappedRequirements,
        notApplicableControls: over.notApplicableControls ?? [],
        controlsMissingEvidence: over.controlsMissingEvidence ?? [],
        overdueTasks: over.overdueTasks ?? [],
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

describe('generateAuditReadinessPdf', () => {
    it('audit-ready (0 gaps, 0 unmapped): renders the ready paragraph', async () => {
        // Branch: gapRequirements === 0 && coverage.unmapped === 0 → "Audit-ready …".
        mockGenerateReadinessReport.mockResolvedValue(
            readinessReport({
                summary: { gapRequirements: 0, readinessScore: 100, implementedRequirements: 10 },
                coverage: { unmapped: 0 },
                unmappedRequirements: [],
            }),
        );

        const doc = await generateAuditReadinessPdf(ctx, { framework: 'ISO27001' });
        const buf = await renderToBuffer(doc);

        expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
        // options.framework is forwarded straight to the readiness spine.
        expect(mockGenerateReadinessReport).toHaveBeenCalledWith(ctx, 'ISO27001');
        // Explicit framework passed → the installed-framework resolver is NOT hit.
        expect(mockResolveInstalledFrameworkKey).not.toHaveBeenCalled();
    });

    it('not-ready (gaps + unmapped): renders the gap paragraph + Unmapped table', async () => {
        // Branch: gaps > 0 → readiness-score gap paragraph; unmappedRequirements
        // populated → Unmapped Requirements table with numeric-aware sort.
        mockGenerateReadinessReport.mockResolvedValue(
            readinessReport({
                summary: { gapRequirements: 3, readinessScore: 40 },
                unmappedRequirements: [
                    unmapped({ code: 'A.5.10', title: 'Later', section: 'Org' }),
                    unmapped({ code: 'A.5.2', title: 'Earlier', section: 'Org' }),
                    unmapped({ code: 'A.5.3', title: 'No section', section: null }),
                ],
            }),
        );

        const doc = await generateAuditReadinessPdf(ctx, { framework: 'ISO27001', watermark: 'DRAFT' });
        const buf = await renderToBuffer(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('no explicit framework → resolves the installed framework key', async () => {
        // Branch: options.framework absent → resolveInstalledFrameworkKey(ctx).
        mockResolveInstalledFrameworkKey.mockResolvedValue('SOC2');
        mockGenerateReadinessReport.mockResolvedValue(
            readinessReport({ framework: { key: 'SOC2', name: 'SOC 2', version: null }, hasStatementOfApplicability: false }),
        );

        const doc = await generateAuditReadinessPdf(ctx);
        const buf = await renderToBuffer(doc);

        expect(buf.length).toBeGreaterThan(0);
        expect(mockResolveInstalledFrameworkKey).toHaveBeenCalledWith(ctx);
        expect(mockGenerateReadinessReport).toHaveBeenCalledWith(ctx, 'SOC2');
    });

    it('framework without a version renders the bare name', async () => {
        // Branch: framework.version falsy → frameworkName === framework.name.
        mockGenerateReadinessReport.mockResolvedValue(
            readinessReport({ framework: { key: 'SOC2', name: 'SOC 2', version: null }, hasStatementOfApplicability: false }),
        );

        const doc = await generateAuditReadinessPdf(ctx, { framework: 'SOC2' });
        const buf = await renderToBuffer(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('absent tenant name falls back to "Tenant"', async () => {
        // Branch: tenant?.name || 'Tenant'.
        mockTenantFindUnique.mockResolvedValue(null);
        mockGenerateReadinessReport.mockResolvedValue(readinessReport());

        const doc = await generateAuditReadinessPdf(ctx, { framework: 'ISO27001' });
        const buf = await renderToBuffer(doc);
        expect(buf.length).toBeGreaterThan(0);
    });

    it('empty readiness payload still renders (no sections, no unmapped)', async () => {
        // Branch: zero sections + zero unmapped — TOTAL footer still rendered,
        // no Unmapped Requirements table.
        mockGenerateReadinessReport.mockResolvedValue(
            readinessReport({
                bySection: [],
                unmappedRequirements: [],
                coverage: { total: 0, mapped: 0, unmapped: 0, coveragePercent: 0 },
                summary: {
                    totalRequirements: 0, mappedRequirements: 0, coveragePercent: 0,
                    implementedRequirements: 0, gapRequirements: 0, exceptedRequirements: 0,
                    readinessScore: 0,
                },
            }),
        );

        const doc = await generateAuditReadinessPdf(ctx, { framework: 'ISO27001' });
        const buf = await renderToBuffer(doc);
        expect(buf.length).toBeGreaterThan(0);
    });
});
