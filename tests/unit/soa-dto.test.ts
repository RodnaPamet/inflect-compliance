/**
 * NOTE: src/lib/dto/soa.ts is a pure type-declaration module — it exports
 * only `interface`s (SoAMappedControlDTO, SoAEntryDTO, SoASummaryDTO,
 * SoAReportDTO) and contains no executable runtime code. There are no
 * functions or constants to invoke. These tests therefore act as compile-time
 * type-conformance contracts: each object below must structurally satisfy its
 * declared interface (the build/typecheck fails otherwise), and we assert the
 * concrete shapes to document the DTO contract and exercise the import.
 */
import type {
    SoAMappedControlDTO,
    SoAEntryDTO,
    SoASummaryDTO,
    SoAReportDTO,
} from '@/lib/dto/soa';

describe('SoA DTOs (type-conformance contracts)', () => {
    it('SoAMappedControlDTO accepts a fully-populated control', () => {
        const control: SoAMappedControlDTO = {
            controlId: 'ctrl-1',
            code: 'A.5.1',
            title: 'Information security policies',
            status: 'IMPLEMENTED',
            applicability: 'APPLICABLE',
            justification: 'Required by policy baseline',
            owner: 'Jane Doe',
            frequency: 'ANNUAL',
        };

        expect(control.controlId).toBe('ctrl-1');
        expect(control.applicability).toBe('APPLICABLE');
        expect(control.justification).toBe('Required by policy baseline');
    });

    it('SoAMappedControlDTO accepts nullable fields as null', () => {
        const control: SoAMappedControlDTO = {
            controlId: 'ctrl-2',
            code: null,
            title: 'Unmapped control',
            status: 'NOT_IMPLEMENTED',
            applicability: 'NOT_APPLICABLE',
            justification: null,
            owner: null,
            frequency: null,
        };

        expect(control.code).toBeNull();
        expect(control.owner).toBeNull();
        expect(control.frequency).toBeNull();
    });

    it('SoAEntryDTO supports an applicable entry with mapped controls and rollups', () => {
        const entry: SoAEntryDTO = {
            requirementId: 'req-1',
            requirementCode: 'A.5.1',
            requirementTitle: 'Policies for information security',
            section: 'Organizational',
            applicable: true,
            justification: null,
            implementationStatus: 'IMPLEMENTED',
            verdict: null,
            exceptedUntil: null,
            mappedControls: [
                {
                    controlId: 'ctrl-1',
                    code: 'A.5.1',
                    title: 'Information security policies',
                    status: 'IMPLEMENTED',
                    applicability: 'APPLICABLE',
                    justification: null,
                    owner: 'Jane Doe',
                    frequency: 'ANNUAL',
                },
            ],
            evidenceCount: 3,
            openTaskCount: 1,
            lastTestResult: 'PASS',
        };

        expect(entry.applicable).toBe(true);
        expect(entry.mappedControls).toHaveLength(1);
        expect(entry.evidenceCount).toBe(3);
        expect(entry.lastTestResult).toBe('PASS');
    });

    it('SoAEntryDTO supports a not-applicable entry requiring justification', () => {
        const entry: SoAEntryDTO = {
            requirementId: 'req-2',
            requirementCode: 'A.7.4',
            requirementTitle: 'Physical security monitoring',
            section: 'Physical',
            applicable: false,
            justification: 'No physical premises in scope',
            implementationStatus: null,
            verdict: null,
            exceptedUntil: null,
            mappedControls: [],
            evidenceCount: 0,
            openTaskCount: 0,
            lastTestResult: null,
        };

        expect(entry.applicable).toBe(false);
        expect(entry.justification).toBe('No physical premises in scope');
        expect(entry.mappedControls).toEqual([]);
    });

    it('SoAEntryDTO supports an unmapped entry (applicable === null)', () => {
        const entry: SoAEntryDTO = {
            requirementId: 'req-3',
            requirementCode: 'A.8.34',
            requirementTitle: 'Protection during audit testing',
            section: null,
            applicable: null,
            justification: null,
            implementationStatus: null,
            verdict: null,
            exceptedUntil: null,
            mappedControls: [],
            evidenceCount: 0,
            openTaskCount: 0,
            lastTestResult: null,
        };

        expect(entry.applicable).toBeNull();
        expect(entry.section).toBeNull();
    });

    it('SoASummaryDTO holds rollup counts that reconcile', () => {
        const summary: SoASummaryDTO = {
            total: 93,
            applicable: 80,
            notApplicable: 10,
            unmapped: 3,
            implemented: 55,
            excepted: 0,
            missingJustification: 2,
        };

        expect(summary.applicable + summary.notApplicable + summary.unmapped).toBe(
            summary.total
        );
        expect(summary.implemented).toBeLessThanOrEqual(summary.applicable);
    });

    it('SoAReportDTO composes the full report envelope', () => {
        const summary: SoASummaryDTO = {
            total: 1,
            applicable: 1,
            notApplicable: 0,
            unmapped: 0,
            implemented: 1,
            excepted: 0,
            missingJustification: 0,
        };
        const report: SoAReportDTO = {
            tenantId: 'tenant-1',
            tenantSlug: 'acme',
            framework: 'ISO27001',
            frameworkName: 'ISO 27001:2022',
            hasStatementOfApplicability: true,
            generatedAt: '2026-06-28T00:00:00.000Z',
            entries: [
                {
                    requirementId: 'req-1',
                    requirementCode: 'A.5.1',
                    requirementTitle: 'Policies for information security',
                    section: 'Organizational',
                    applicable: true,
                    justification: null,
                    implementationStatus: 'IMPLEMENTED',
                    verdict: null,
                    exceptedUntil: null,
                    mappedControls: [],
                    evidenceCount: 0,
                    openTaskCount: 0,
                    lastTestResult: null,
                },
            ],
            summary,
        };

        expect(report.framework).toBe('ISO27001');
        expect(report.frameworkName).toBe('ISO 27001:2022');
        expect(report.entries).toHaveLength(1);
        expect(report.summary.total).toBe(1);
        expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
    });
});
