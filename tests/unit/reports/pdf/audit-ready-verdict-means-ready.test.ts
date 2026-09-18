/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * The "Audit-ready" verdict in the audit-readiness PDF must mean audit-ready.
 *
 * #2618 — the branch fired on `gapRequirements === 0 && unmapped === 0` alone,
 * whatever the evidence position. Combined with a `readinessScore` that
 * saturated at 0 on a large catalogue, the auditor-facing PDF printed:
 *
 *     "Audit-ready — readiness score 0/100. Every requirement is mapped and
 *      implemented."
 *
 * — a sentence that contradicts itself in the same breath.
 *
 * The existing suite for this generator renders to a buffer and asserts
 * `%PDF-`, which passes whichever sentence is printed. This file asserts the
 * TEXT, by capturing what reaches `addParagraph`.
 */
const paragraphs: string[] = [];

jest.mock('@/lib/pdf/sections', () => {
    const actual = jest.requireActual('@/lib/pdf/sections');
    return {
        ...actual,
        addParagraph: (doc: any, text: string, ...rest: any[]) => {
            paragraphs.push(text);
            return actual.addParagraph(doc, text, ...rest);
        },
    };
});

const mockGenerateReadinessReport = jest.fn();
jest.mock('@/app-layer/usecases/framework/coverage', () => ({
    generateReadinessReport: (...args: any[]) => mockGenerateReadinessReport(...args),
}));
jest.mock('@/app-layer/usecases/soa', () => ({
    resolveInstalledFrameworkKey: jest.fn(async () => 'ISO27001'),
}));
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenant: { findUnique: jest.fn(async () => ({ name: 'Acme Corp' })) } },
}));

import { generateAuditReadinessPdf } from '@/app-layer/reports/pdf/auditReadiness';
import { makeRequestContext } from '../../../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

function report(summary: Record<string, unknown>, unmappedCount = 0): any {
    return {
        framework: { key: 'ISO27001', name: 'ISO/IEC 27001', version: '2022' },
        hasStatementOfApplicability: true,
        generatedAt: new Date('2026-09-18').toISOString(),
        coverage: { total: 10, mapped: 10, unmapped: unmappedCount, coveragePercent: 100 },
        bySection: [],
        unmappedRequirements: [],
        notApplicableControls: [],
        controlsMissingEvidence: [],
        overdueTasks: [],
        summary: {
            totalRequirements: 10, mappedRequirements: 10, coveragePercent: 100,
            implementedRequirements: 10, gapRequirements: 0, exceptedRequirements: 0,
            notApplicableCount: 0, missingEvidenceCount: 0, overdueTaskCount: 0,
            readinessScore: 100,
            ...summary,
        },
    };
}

/** The readiness verdict is the paragraph under "Readiness Status". */
function verdict(): string {
    const line = paragraphs.find((p) => p.includes('readiness score') || p.includes('Readiness score'));
    if (!line) throw new Error(`no readiness paragraph among ${paragraphs.length} captured`);
    return line;
}

beforeEach(() => {
    paragraphs.length = 0;
    jest.clearAllMocks();
});

describe('the Audit-ready verdict (#2618)', () => {
    it('captures paragraph text at all (positive control)', async () => {
        mockGenerateReadinessReport.mockResolvedValue(report({}));
        await generateAuditReadinessPdf(ctx, { framework: 'ISO27001' });
        // Without this, every assertion below could pass on an empty capture.
        expect(paragraphs.length).toBeGreaterThan(0);
        expect(verdict()).toContain('Audit-ready');
    });

    it('says Audit-ready only when requirements, evidence AND tasks are clear', async () => {
        mockGenerateReadinessReport.mockResolvedValue(report({}));
        await generateAuditReadinessPdf(ctx, { framework: 'ISO27001' });
        expect(verdict()).toBe(
            'Audit-ready — readiness score 100/100. Every requirement is mapped and implemented, ' +
                'every applicable control carries current evidence, and no task is overdue.',
        );
    });

    it.each([
        ['unevidenced controls', { missingEvidenceCount: 7, readinessScore: 60 }],
        ['overdue tasks', { overdueTaskCount: 4, readinessScore: 80 }],
        ['both', { missingEvidenceCount: 7, overdueTaskCount: 4, readinessScore: 40 }],
    ])('withholds Audit-ready when requirements are complete but there are %s', async (_label, over) => {
        mockGenerateReadinessReport.mockResolvedValue(report(over));
        await generateAuditReadinessPdf(ctx, { framework: 'ISO27001' });

        const line = verdict();
        expect(line).not.toContain('Audit-ready');
        // …and still reports the requirement position honestly.
        expect(line).toContain('Every requirement is mapped and implemented, but');
    });

    it('never pairs the Audit-ready claim with a contradicting score', async () => {
        // The exact shape of the original defect: a saturated score beside a
        // claim of readiness. Both halves are now impossible — the score cannot
        // reach 0 from a fully-implemented posture, and the claim needs a clean
        // evidence position — so this asserts the pairing, not either half.
        for (const over of [
            { missingEvidenceCount: 50, readinessScore: 40 },
            { missingEvidenceCount: 0, overdueTaskCount: 30, readinessScore: 80 },
            { missingEvidenceCount: 93, overdueTaskCount: 93, readinessScore: 40 },
        ]) {
            paragraphs.length = 0;
            mockGenerateReadinessReport.mockResolvedValue(report(over));
            await generateAuditReadinessPdf(ctx, { framework: 'ISO27001' });
            const line = verdict();
            expect({ over, contradiction: line.includes('Audit-ready') && /score (0|[1-4]?\d)\/100/.test(line) })
                .toEqual({ over, contradiction: false });
        }
    });

    it('still reports the requirement gap when requirements are incomplete', async () => {
        mockGenerateReadinessReport.mockResolvedValue(report({ gapRequirements: 3, readinessScore: 55 }, 2));
        await generateAuditReadinessPdf(ctx, { framework: 'ISO27001' });
        expect(verdict()).toBe(
            'Readiness score 55/100. 3 mapped requirement(s) not yet implemented; 2 unmapped.',
        );
    });
});
