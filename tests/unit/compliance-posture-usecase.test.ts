/**
 * Unit tests — compliance-posture usecase wiring.
 *
 * Verifies gatherPostureSignals maps the executive dashboard + per-framework
 * coverage into the aggregate signals, and generateCompliancePostureSummary
 * runs signals → provider → output-guard → upsert (provider mocked).
 */
import { makeRequestContext } from '../helpers/make-context';

// ── Mocks (declared before importing the usecase) ──────────────────────

const mockGetExecutiveDashboard = jest.fn();
const mockListFrameworks = jest.fn();
const mockProviderGenerate = jest.fn();
const mockUpsert = jest.fn().mockResolvedValue({});
const mockLinkFindMany = jest.fn();

jest.mock('@/app-layer/usecases/dashboard', () => ({
    getExecutiveDashboard: (...a: unknown[]) => mockGetExecutiveDashboard(...a),
}));
jest.mock('@/app-layer/usecases/framework', () => ({
    listFrameworks: (...a: unknown[]) => mockListFrameworks(...a),
}));
jest.mock('@/app-layer/ai/compliance-posture/provider', () => ({
    getCompliancePostureProvider: () => ({ providerName: 'stub', generate: mockProviderGenerate }),
}));
jest.mock('@/lib/db-context', () => ({
    // Invoke the callback with a fake tenant-scoped client.
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            controlRequirementLink: { findMany: (...a: unknown[]) => mockLinkFindMany(...a) },
            compliancePostureSummary: { upsert: (...a: unknown[]) => mockUpsert(...a) },
        }),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
    gatherPostureSignals,
    generateCompliancePostureSummary,
} from '@/app-layer/usecases/compliance-posture';

function execFixture() {
    return {
        stats: { openFindings: 2, highRisks: 3 },
        controlCoverage: { applicable: 40, implemented: 30, inProgress: 5, notStarted: 5, coveragePercent: 75 },
        riskBySeverity: { critical: 1, high: 2, medium: 4, low: 3 },
        evidenceExpiry: { overdue: 3, dueSoon7d: 1, dueSoon30d: 2, current: 90 },
        taskSummary: { open: 8, overdue: 1 },
        policySummary: { total: 5, overdueReview: 2 },
        vendorSummary: { overdueReview: 1 },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetExecutiveDashboard.mockResolvedValue(execFixture());
    mockListFrameworks.mockResolvedValue([
        { id: 'fw-iso', key: 'ISO27001', name: 'ISO/IEC 27001', _count: { requirements: 93 } },
        { id: 'fw-soc', key: 'SOC2', name: 'SOC 2', _count: { requirements: 60 } },
    ]);
    /**
     * Each link now carries its CONTROL, because the signal reports two different
     * things about a framework and only one of them is a link count:
     * `requirementsMappedPercent` (a link exists) and
     * `requirementsImplementedPercent` (the mapped controls roll up to
     * implemented). A double that returns only `requirementId` can express the
     * first and not the second — which is exactly the state that let a tenant
     * who had installed a pack and done no work read 100% coverage.
     *
     * So the ISO rows are deliberately SPLIT: 20 implemented and 30 not, against
     * 50 mapped. A fixture where every control were implemented would make the
     * two percentages identical and the distinction untestable.
     */
    const link = (reqId: string, frameworkId: string, status: string) => ({
        requirementId: reqId,
        applicability: null, // inherit the control's own — the common case
        requirement: { frameworkId },
        control: { status, applicability: 'APPLICABLE', exceptions: [] },
    });
    mockLinkFindMany.mockResolvedValue([
        // ISO — 50 distinct mapped of 93 (~54%), of which 20 implemented (~22%),
        // plus a duplicate to prove distinct counting.
        ...Array.from({ length: 50 }, (_, i) =>
            link(`iso-${i}`, 'fw-iso', i < 20 ? 'IMPLEMENTED' : 'IN_PROGRESS'),
        ),
        link('iso-0', 'fw-iso', 'IMPLEMENTED'), // duplicate → distinct
        // SOC2 — 1 distinct mapped of 60 (~2%), the clear weakest, not implemented.
        link('soc-1', 'fw-soc', 'NOT_STARTED'),
    ]);
    mockProviderGenerate.mockResolvedValue({
        postureLabel: 'ESTABLISHED',
        maturityScore: 68,
        summaryText: 'Established posture.',
        advice: [{ title: 'Refresh evidence', detail: 'Overdue items.', priority: 'high' }],
        provider: 'stub',
        isFallback: false,
    });
});

describe('gatherPostureSignals', () => {
    it('maps executive dashboard counts into aggregate signals', async () => {
        const ctx = makeRequestContext('ADMIN');
        const signals = await gatherPostureSignals(ctx);

        expect(signals.controls.coveragePercent).toBe(75);
        expect(signals.risks).toEqual({ total: 10, critical: 1, high: 2, medium: 4, low: 3 });
        expect(signals.evidence.overdue).toBe(3);
        expect(signals.evidence.dueSoon).toBe(3); // 1 + 2
        expect(signals.findings.open).toBe(2);
        expect(signals.tasks).toEqual({ open: 8, overdue: 1 });
        expect(signals.policies.overdueReview).toBe(2);
        expect(signals.vendors.overdueReview).toBe(1);
    });

    it('computes distinct per-framework coverage, weakest first', async () => {
        const ctx = makeRequestContext('ADMIN');
        const signals = await gatherPostureSignals(ctx);

        // ISO: 50 distinct mapped of 93 (~54%); SOC2: 1 of 60 (~2%). Weakest
        // (SOC2) leads.
        expect(signals.frameworks[0].key).toBe('SOC2');
        expect(signals.frameworks[0].mapped).toBe(1);
        const iso = signals.frameworks.find((f) => f.key === 'ISO27001');
        expect(iso?.mapped).toBe(50);
        expect(iso?.total).toBe(93);

        // MAPPED AND IMPLEMENTED MUST DIFFER, and this is the assertion the
        // whole change exists for. 50 of ISO's 93 requirements have a control
        // linked (54%); only 20 of those controls are IMPLEMENTED (22%).
        // Reporting the first as "coverage" is what let a tenant who installed a
        // pack and did no work read 100%.
        expect(iso?.requirementsMappedPercent).toBe(54);
        expect(iso?.implemented).toBe(20);
        expect(iso?.requirementsImplementedPercent).toBe(22);

        // SOC2's single mapped control is NOT_STARTED: mapped but zero
        // implemented, the exact shape a freshly-installed pack produces.
        expect(signals.frameworks[0].requirementsMappedPercent).toBe(2);
        expect(signals.frameworks[0].implemented).toBe(0);
        expect(signals.frameworks[0].requirementsImplementedPercent).toBe(0);
    });
});

describe('generateCompliancePostureSummary', () => {
    it('runs signals → provider → guard → upsert and returns the result', async () => {
        const ctx = makeRequestContext('ADMIN');
        const result = await generateCompliancePostureSummary(ctx);

        expect(mockProviderGenerate).toHaveBeenCalledTimes(1);
        // Provider receives the aggregate signals.
        expect(mockProviderGenerate.mock.calls[0][0].controls.coveragePercent).toBe(75);

        // Upsert writes the guarded result to the tenant's row.
        expect(mockUpsert).toHaveBeenCalledTimes(1);
        const upsertArg = mockUpsert.mock.calls[0][0];
        expect(upsertArg.where).toEqual({ tenantId: 'tenant-1' });
        expect(upsertArg.create.postureLabel).toBe('ESTABLISHED');
        expect(upsertArg.update.maturityScore).toBe(68);

        expect(result.postureLabel).toBe('ESTABLISHED');
    });
});
