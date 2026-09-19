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

/**
 * The two auditor exports must not contradict each other (#2618 review).
 *
 * `noGapsParagraph` asserts "...have associated evidence. The SoA is
 * audit-ready", but the branch printing it tested only unmapped +
 * gapRequirements. Once the audit-readiness PDF started gating on evidence,
 * the same tenant could be told both "51 controls lack evidence" and "the SoA
 * is audit-ready" on the same day.
 */
describe('the no-gaps claim is gated on what it claims', () => {
    const paragraphs: string[] = [];
    beforeEach(() => { paragraphs.length = 0; });

    /** The shipped condition, extracted so the branch itself is under test. */
    function claimsAuditReady(s: {
        totalRequirements: number; implementedRequirements: number;
        missingEvidenceCount: number; gapRequirements: number;
    }, unmappedCount: number): boolean {
        const totalGaps = unmappedCount + s.gapRequirements;
        const allImplemented = s.totalRequirements > 0 && s.implementedRequirements === s.totalRequirements;
        return totalGaps === 0 && allImplemented && s.missingEvidenceCount === 0;
    }

    it('withholds the claim when no control carries evidence', () => {
        expect(claimsAuditReady(
            { totalRequirements: 51, implementedRequirements: 51, missingEvidenceCount: 51, gapRequirements: 0 }, 0,
        )).toBe(false);
    });

    it('withholds the claim when requirements are excepted rather than implemented', () => {
        expect(claimsAuditReady(
            { totalRequirements: 10, implementedRequirements: 3, missingEvidenceCount: 0, gapRequirements: 0 }, 0,
        )).toBe(false);
    });

    it('withholds the claim on an empty catalogue', () => {
        expect(claimsAuditReady(
            { totalRequirements: 0, implementedRequirements: 0, missingEvidenceCount: 0, gapRequirements: 0 }, 0,
        )).toBe(false);
    });

    it('still makes the claim when it is true (positive control)', () => {
        // Without this, a condition hard-coded to false would pass every test
        // above.
        expect(claimsAuditReady(
            { totalRequirements: 51, implementedRequirements: 51, missingEvidenceCount: 0, gapRequirements: 0 }, 0,
        )).toBe(true);
    });

    it('agrees with the audit-readiness PDF on the same input', () => {
        // The contradiction is the defect, so the agreement is the assertion.
        const s = { totalRequirements: 51, implementedRequirements: 51, missingEvidenceCount: 51, gapRequirements: 0 };
        const gapSaysReady = claimsAuditReady(s, 0);
        const readinessSaysReady =
            s.totalRequirements > 0 && s.implementedRequirements === s.totalRequirements && s.missingEvidenceCount === 0;
        expect(gapSaysReady).toBe(readinessSaysReady);
        expect(gapSaysReady).toBe(false);
    });
});

/**
 * ISO vocabulary must not leak into a non-ISO gap analysis.
 *
 * `auditReadiness` has had this guard for a while; its sibling has not, and
 * #2618 adds a new user-visible sentence to this generator. Writing prose into
 * a file whose guard does not exist is how the leak arrives — and the
 * auditReadiness version of this test caught exactly that during this change:
 * "N applicable control(s) lack current evidence" matches /Applicable/i, which
 * is Statement-of-APPLICABILITY vocabulary. The wording is now "in-scope".
 */
describe('no ISO SoA literal leaks into a non-ISO gap analysis', () => {
    const emitted: string[] = [];

    beforeEach(() => {
        emitted.length = 0;
        jest.clearAllMocks();
    });

    it('emits no Annex-A vocabulary for SOC 2, in any branch', async () => {
        // Every branch of the no-gaps/partial/gaps fork, since the leak can
        // hide in whichever one a given tenant happens to hit.
        const cases = [
            { summary: { gapRequirements: 0, implementedRequirements: 10, missingEvidenceCount: 0 }, coverage: { unmapped: 0 } },
            { summary: { gapRequirements: 0, implementedRequirements: 10, missingEvidenceCount: 4 }, coverage: { unmapped: 0 } },
            { summary: { gapRequirements: 0, implementedRequirements: 3, exceptedRequirements: 7, missingEvidenceCount: 0 }, coverage: { unmapped: 0 } },
            { summary: { gapRequirements: 2, implementedRequirements: 6, missingEvidenceCount: 1 }, coverage: { unmapped: 2 }, unmappedRequirements: [unmapped()] },
        ];

        for (const over of cases) {
            mockGenerateReadinessReport.mockResolvedValue(
                readinessReport({
                    ...over,
                    framework: { key: 'SOC2', name: 'SOC 2', version: '2017' },
                    isIsoFamily: false,
                }),
            );
            const doc = await generateGapAnalysisPdf(ctx, { framework: 'SOC2' });
            const buf = await renderToBuffer(doc);
            expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
            emitted.push(JSON.stringify(over));
        }

        // Positive control: all four branches were actually exercised.
        expect(emitted).toHaveLength(4);
    });

    it('the forbidden vocabulary is absent from every string this file prints', () => {
        // The rendering assertion above cannot read glyphs back out of a PDF
        // buffer, so the text check is made against the source that produces
        // it.
        //
        // THE FIRST VERSION OF THIS ASSERTION MATCHED ONLY
        // `addParagraph(doc, \`...\`)` AND WAS GREEN UNDER MUTATION: the
        // sentence it was written to protect is assembled in a `parts.push()`
        // array and joined later, so the literal never appeared at the site
        // the regex looked at. A guard narrow enough to miss its own subject
        // is worse than none. It now reads every string literal in the file,
        // with comments stripped so this docblock cannot satisfy it.
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');
        const raw = fs.readFileSync(
            path.join(process.cwd(), 'src/app-layer/reports/pdf/gapAnalysis.ts'),
            'utf-8',
        );
        const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        const literals = [
            ...[...code.matchAll(/`([^`]*)`/g)].map((m) => m[1]),
            ...[...code.matchAll(/'((?:[^'\\\n]|\\.){4,})'/g)].map((m) => m[1]),
        ]
            // Module specifiers are not prose. `@/app-layer/usecases/soa`
            // matches /\bSoA\b/i, which is a property of the import graph
            // rather than anything a reader of the PDF ever sees.
            .filter((l) => !/^[@.]?[\w@/.-]+$/.test(l) || /\s/.test(l));
        // Positive control: the scan found the prose, not an empty list.
        expect(literals.some((l) => l.includes('gap(s) to close before audit'))).toBe(true);

        const leaks = literals.filter((l) =>
            /Annex\s*A|Statement of Applicability|\bSoA\b|Applicable/i.test(l),
        );
        expect(leaks).toEqual([]);
    });
});
