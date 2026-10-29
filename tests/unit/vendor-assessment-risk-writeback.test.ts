/**
 * Vendor assessment → auto-Risk writeback: failure-domain separation.
 *
 * `applyAssessmentRiskWriteback` performs two post-commit effects that live in
 * SEPARATE transactions — `createRisk` then `addVendorLink`. They used to share
 * one try/catch that returned `createdRiskId: null` on any throw, so a failed
 * link write left a real Risk in the register that was both unlinked from the
 * vendor AND never reported to the reviewer.
 *
 * The invariant these tests pin: **a created Risk is never silently unlinked
 * and unreported.** If linking fails, the committed risk id still comes back.
 */

const mockTx = {
    vendorAssessment: { findFirst: jest.fn(), update: jest.fn() },
    vendorAssessmentAnswer: { updateMany: jest.fn(), findMany: jest.fn() },
    vendorAssessmentTemplateQuestion: { findMany: jest.fn() },
    vendorAssessmentTemplate: { findUnique: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) => fn(mockTx),
    ),
}));

const mockLogEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => s.trim()),
}));

const mockVendorFindFirst = jest.fn();
const mockVendorUpdateMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    prisma: {
        vendor: {
            findFirst: (...a: unknown[]) => mockVendorFindFirst(...a),
            updateMany: (...a: unknown[]) => mockVendorUpdateMany(...a),
        },
    },
}));

const mockCreateRisk = jest.fn();
jest.mock('@/app-layer/usecases/risk', () => ({
    createRisk: (...a: unknown[]) => mockCreateRisk(...a),
}));

const mockAddVendorLink = jest.fn();
const mockListVendorLinks = jest.fn();
jest.mock('@/app-layer/usecases/vendor', () => ({
    addVendorLink: (...a: unknown[]) => mockAddVendorLink(...a),
    listVendorLinks: (...a: unknown[]) => mockListVendorLinks(...a),
}));

const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerInfo = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: {
        error: (...a: unknown[]) => mockLoggerError(...a),
        warn: (...a: unknown[]) => mockLoggerWarn(...a),
        info: (...a: unknown[]) => mockLoggerInfo(...a),
        debug: jest.fn(),
    },
}));

jest.mock('@/app-layer/notifications/enqueue', () => ({
    enqueueEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/app-layer/policies/vendor.policies', () => ({
    assertCanApproveAssessment: jest.fn(),
}));

import { reviewAssessment } from '@/app-layer/usecases/vendor-assessment-review';

function makeCtx() {
    return {
        requestId: 'req-1',
        userId: 'user-reviewer',
        tenantId: 'tenant-1',
        role: 'ADMIN' as const,
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: false,
            canExport: false,
        },
        appPermissions: {} as never,
    };
}

/** Seed a SUBMITTED assessment that reviews to a CRITICAL rating. */
function seedCriticalAssessment() {
    mockTx.vendorAssessment.findFirst.mockResolvedValue({
        id: 'assess-1',
        tenantId: 'tenant-1',
        vendorId: 'vendor-1',
        status: 'SUBMITTED',
        templateId: 'tpl-1',
        // Required by the G-3 review path — a null templateVersionId routes to
        // the legacy decideAssessment flow and rejects before any writeback.
        templateVersionId: 'tplv-1',
        score: null,
        riskRating: null,
        vendor: { id: 'vendor-1', name: 'Acme Corp' },
        template: { scoringConfigJson: null },
    });
    mockTx.vendorAssessmentAnswer.findMany.mockResolvedValue([]);
    mockTx.vendorAssessmentTemplateQuestion.findMany.mockResolvedValue([]);
    mockTx.vendorAssessment.update.mockResolvedValue({
        id: 'assess-1',
        status: 'REVIEWED',
        score: 10,
        riskRating: 'CRITICAL',
    });
    mockVendorFindFirst.mockResolvedValue({ nextReviewAt: null });
    mockVendorUpdateMany.mockResolvedValue({ count: 1 });
    // No pre-existing ASSESSMENT_SOURCED marker → materialization proceeds.
    mockListVendorLinks.mockResolvedValue([]);
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('auto-Risk writeback — failure domains are separate', () => {
    it('reports the created risk id when linking SUCCEEDS', async () => {
        seedCriticalAssessment();
        mockCreateRisk.mockResolvedValue({ id: 'risk-happy' });
        mockAddVendorLink.mockResolvedValue(undefined);

        const res = await reviewAssessment(makeCtx(), 'assess-1', {
            finalRiskRating: 'CRITICAL',
        });

        expect(res.autoCreatedRiskId).toBe('risk-happy');
        expect(mockAddVendorLink).toHaveBeenCalledWith(
            expect.anything(),
            'vendor-1',
            expect.objectContaining({
                entityType: 'RISK',
                entityId: 'risk-happy',
                relation: 'ASSESSMENT_SOURCED',
            }),
        );
    });

    it('STILL reports the risk id when the vendor link write throws', async () => {
        // The regression this file exists for. The Risk row is committed; only
        // the marker-link write failed. Returning null here would strand a real
        // register entry that nobody was told about.
        seedCriticalAssessment();
        mockCreateRisk.mockResolvedValue({ id: 'risk-orphaned' });
        mockAddVendorLink.mockRejectedValue(new Error('link write failed'));

        const res = await reviewAssessment(makeCtx(), 'assess-1', {
            finalRiskRating: 'CRITICAL',
        });

        expect(res.autoCreatedRiskId).toBe('risk-orphaned');
    });

    it('logs the orphaned-risk link failure at ERROR, not warn', async () => {
        // Severity is load-bearing: this state needs manual reconciliation, and
        // the missing ASSESSMENT_SOURCED marker means a later review will
        // materialise a DUPLICATE risk. A warn would be lost in the noise.
        seedCriticalAssessment();
        mockCreateRisk.mockResolvedValue({ id: 'risk-orphaned' });
        mockAddVendorLink.mockRejectedValue(new Error('link write failed'));

        await reviewAssessment(makeCtx(), 'assess-1', { finalRiskRating: 'CRITICAL' });

        expect(mockLoggerError).toHaveBeenCalledWith(
            expect.stringContaining('link FAILED'),
            expect.objectContaining({ riskId: 'risk-orphaned', vendorId: 'vendor-1' }),
        );
    });

    it('reports null when risk CREATION itself fails (nothing was persisted)', async () => {
        seedCriticalAssessment();
        mockCreateRisk.mockRejectedValue(new Error('create failed'));

        const res = await reviewAssessment(makeCtx(), 'assess-1', {
            finalRiskRating: 'CRITICAL',
        });

        expect(res.autoCreatedRiskId).toBeNull();
        // Nothing to link if nothing was created.
        expect(mockAddVendorLink).not.toHaveBeenCalled();
    });

    it('does not re-materialise when an ASSESSMENT_SOURCED marker already exists', async () => {
        seedCriticalAssessment();
        mockListVendorLinks.mockResolvedValue([
            { entityType: 'RISK', relation: 'ASSESSMENT_SOURCED', entityId: 'risk-prior' },
        ]);

        const res = await reviewAssessment(makeCtx(), 'assess-1', {
            finalRiskRating: 'CRITICAL',
        });

        expect(res.autoCreatedRiskId).toBeNull();
        expect(mockCreateRisk).not.toHaveBeenCalled();
    });
});

describe('a completed review with no risk rating still counts as a review (#4462)', () => {
    it('rolls the next review date and stamps the review, without writing a tier or a risk', async () => {
        seedCriticalAssessment();
        mockVendorFindFirst.mockResolvedValue({ nextReviewAt: new Date('2020-01-01T00:00:00Z') });

        const before = Date.now();
        const res = await reviewAssessment(makeCtx(), 'assess-1', { finalRiskRating: null });

        expect(res.autoCreatedRiskId).toBeNull();
        expect(mockCreateRisk).not.toHaveBeenCalled();
        expect(mockVendorUpdateMany).toHaveBeenCalledTimes(1);
        const data = mockVendorUpdateMany.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('inherentRisk');
        expect(data.lastAssessmentReviewedAt).toBeInstanceOf(Date);
        const next = (data.nextReviewAt as Date).getTime();
        expect(next).toBeGreaterThanOrEqual(before + 364 * 86_400_000);
    });

    it('keeps a review date already set in the future', async () => {
        seedCriticalAssessment();
        const future = new Date(Date.now() + 30 * 86_400_000);
        mockVendorFindFirst.mockResolvedValue({ nextReviewAt: future });

        await reviewAssessment(makeCtx(), 'assess-1', { finalRiskRating: null });

        const data = mockVendorUpdateMany.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('nextReviewAt');
        expect(data.lastAssessmentReviewedAt).toBeInstanceOf(Date);
    });
});
