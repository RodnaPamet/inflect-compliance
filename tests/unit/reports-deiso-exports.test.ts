/**
 * PR-H — de-ISO export artifacts.
 *
 * The Audit Readiness / Gap Analysis PDFs (and the SoA CSV) were hard-branded
 * "ISO 27001:2022 / Annex A / 93 controls" even when run against SOC 2 / NIS2.
 *
 * These assert the pure label-derivation (report-labels.ts) that the generators
 * use — for a non-ISO framework every label names the real framework and zero
 * ISO literals leak; for ISO it still reads as Annex A / SoA. (Testing the pure
 * helper rather than the rendered PDF avoids pdf-parse's environment-dependent
 * text extraction.) Plus a lighter check that the generators forward the
 * selected framework to the readiness spine (generateReadinessReport).
 */
import {
    auditReadinessLabels,
    gapAnalysisLabels,
} from '@/app-layer/reports/pdf/report-labels';

const ISO_LEAKS = [/ISO\s*27001/i, /Annex\s*A/i, /\b93\b/];

const SOC2 = { frameworkName: 'SOC 2', hasStatementOfApplicability: false, requirementCount: 61 };
const ISO = { frameworkName: 'ISO 27001:2022', hasStatementOfApplicability: true, requirementCount: 93 };

function allStrings(o: object): string {
    return Object.values(o).join(' | ');
}

describe('report-labels — non-ISO framework (SOC 2) leaks no ISO literals', () => {
    it('Audit Readiness labels name SOC 2, never Annex A / ISO / 93', () => {
        const text = allStrings(auditReadinessLabels(SOC2));
        expect(text).toContain('SOC 2');
        expect(text).toContain('Coverage & Readiness');
        for (const rx of ISO_LEAKS) expect(text).not.toMatch(rx);
    });

    it('Gap Analysis labels name SOC 2, never Annex A / ISO / 93', () => {
        const text = allStrings(gapAnalysisLabels(SOC2, 4));
        expect(text).toContain('SOC 2');
        for (const rx of ISO_LEAKS) expect(text).not.toMatch(rx);
    });
});

describe('report-labels — ISO still reads as ISO', () => {
    it('Audit Readiness keeps Annex A / Statement of Applicability + the 93 count', () => {
        const l = auditReadinessLabels(ISO);
        expect(l.reportSubtitle).toMatch(/Statement of Applicability/);
        expect(l.applicabilitySection).toBe('Statement of Applicability');
        expect(l.tableSectionTitle).toBe('Statement of Applicability');
        expect(l.dataSourceDescription).toContain('93 Annex A controls');
    });

    it('Gap Analysis keeps Annex A requirements for ISO', () => {
        const l = gapAnalysisLabels(ISO, 2);
        expect(l.requirementsPhrase).toBe('ISO 27001:2022 Annex A requirements');
        expect(l.noGapsParagraph).toMatch(/Annex A/);
    });
});

// ─── The generators forward the selected framework to the readiness spine ───
const generateReadinessReportMock = jest.fn();
const resolveInstalledFrameworkKeyMock = jest.fn();
jest.mock('@/app-layer/usecases/framework/coverage', () => ({
    generateReadinessReport: (...args: unknown[]) => generateReadinessReportMock(...args),
}));
jest.mock('@/app-layer/usecases/soa', () => ({
    resolveInstalledFrameworkKey: (...args: unknown[]) => resolveInstalledFrameworkKeyMock(...args),
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenant: { findUnique: jest.fn().mockResolvedValue({ name: 'Acme' }) } },
}));

import { generateAuditReadinessPdf } from '@/app-layer/reports/pdf/auditReadiness';
import { generateGapAnalysisPdf } from '@/app-layer/reports/pdf/gapAnalysis';

const readinessDto = {
    framework: { key: 'SOC2', name: 'SOC 2', version: null },
    hasStatementOfApplicability: false,
    generatedAt: '2026-07-16T00:00:00.000Z',
    coverage: { total: 0, mapped: 0, unmapped: 0, coveragePercent: 0 },
    bySection: [],
    unmappedRequirements: [],
    notApplicableControls: [],
    controlsMissingEvidence: [],
    overdueTasks: [],
    summary: {
        totalRequirements: 0,
        mappedRequirements: 0,
        coveragePercent: 0,
        implementedRequirements: 0,
        gapRequirements: 0,
        exceptedRequirements: 0,
        notApplicableCount: 0,
        missingEvidenceCount: 0,
        overdueTaskCount: 0,
        readinessScore: 0,
    },
};

describe('generators forward the selected framework to the readiness spine', () => {
    beforeEach(() => {
        generateReadinessReportMock.mockReset();
        generateReadinessReportMock.mockResolvedValue(readinessDto);
        resolveInstalledFrameworkKeyMock.mockReset();
        resolveInstalledFrameworkKeyMock.mockResolvedValue('ISO27001');
    });

    it('Audit Readiness passes options.framework through, bypassing the resolver', async () => {
        await generateAuditReadinessPdf({ tenantId: 't1' } as never, { framework: 'SOC2' });
        expect(generateReadinessReportMock).toHaveBeenCalledWith(expect.anything(), 'SOC2');
        expect(resolveInstalledFrameworkKeyMock).not.toHaveBeenCalled();
    });

    it('Gap Analysis passes options.framework through, bypassing the resolver', async () => {
        await generateGapAnalysisPdf({ tenantId: 't1' } as never, { framework: 'SOC2' });
        expect(generateReadinessReportMock).toHaveBeenCalledWith(expect.anything(), 'SOC2');
        expect(resolveInstalledFrameworkKeyMock).not.toHaveBeenCalled();
    });

    it('Audit Readiness resolves the installed framework when none is passed', async () => {
        await generateAuditReadinessPdf({ tenantId: 't1' } as never);
        expect(resolveInstalledFrameworkKeyMock).toHaveBeenCalled();
        expect(generateReadinessReportMock).toHaveBeenCalledWith(expect.anything(), 'ISO27001');
    });
});
