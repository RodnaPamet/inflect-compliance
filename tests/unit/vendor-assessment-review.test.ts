/**
 * Epic G-3 prompt 5 — reviewAssessment + closeAssessment unit tests.
 *
 * Pure-memory tests covering:
 *
 *   • permission gate (canAdmin)
 *   • status guard — only SUBMITTED can be reviewed
 *   • per-answer override application (set / clear / leave)
 *   • engine integration (config from template, post-override score)
 *   • final-rating resolution (manual override vs engine suggestion)
 *   • lifecycle transition (SUBMITTED → REVIEWED → CLOSED)
 *   • audit traceability (auto-sum + override count + final score)
 */

// ─── Mocks ─────────────────────────────────────────────────────────

const mockTx = {
    vendorAssessment: { findFirst: jest.fn(), update: jest.fn(),
        // The status transition is claimed with a conditional write (#5318).
        updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    vendorAssessmentAnswer: { updateMany: jest.fn(), findMany: jest.fn() },
    vendorAssessmentTemplateQuestion: { findMany: jest.fn() },
    vendorAssessmentTemplate: { findUnique: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) =>
            fn(mockTx),
    ),
}));

const mockLogEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => s.trim()),
}));

import {
    reviewAssessment,
    closeAssessment,
} from '@/app-layer/usecases/vendor-assessment-review';

// ─── Helpers ───────────────────────────────────────────────────────

function makeCtx(overrides: { canAdmin?: boolean } = {}) {
    return {
        requestId: 'req-1',
        userId: 'user-reviewer',
        tenantId: 'tenant-1',
        role: 'ADMIN' as const,
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: overrides.canAdmin ?? true,
            canAudit: false,
            canExport: false,
        },
        appPermissions: {} as never,
    };
}

function setupReviewMocks(opts: {
    status?: string;
    questions?: Array<{ id: string; weight?: number; required?: boolean }>;
    answers?: Array<{
        questionId: string;
        computedPoints: number;
        reviewerOverridePoints?: number | null;
    }>;
    scoringConfigJson?: unknown;
}) {
    mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({
        id: 'a-1',
        tenantId: 'tenant-1',
        status: opts.status ?? 'SUBMITTED',
        templateVersionId: 't-1',
        templateId: null,
    });
    mockTx.vendorAssessmentAnswer.updateMany.mockResolvedValue({ count: 1 });
    mockTx.vendorAssessmentTemplateQuestion.findMany.mockResolvedValueOnce(
        (opts.questions ?? []).map((q) => ({
            id: q.id,
            weight: q.weight ?? 1,
            required: q.required ?? false,
        })),
    );
    mockTx.vendorAssessmentAnswer.findMany.mockResolvedValueOnce(
        (opts.answers ?? []).map((a) => ({
            questionId: a.questionId,
            computedPoints: a.computedPoints,
            reviewerOverridePoints: a.reviewerOverridePoints ?? null,
        })),
    );
    mockTx.vendorAssessmentTemplate.findUnique.mockResolvedValueOnce({
        scoringConfigJson: opts.scoringConfigJson ?? null,
    });
    mockTx.vendorAssessment.update.mockResolvedValue({});
}

beforeEach(() => {
    jest.clearAllMocks();
    Object.values(mockTx.vendorAssessment).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
    Object.values(mockTx.vendorAssessmentAnswer).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
    Object.values(mockTx.vendorAssessmentTemplateQuestion).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
    Object.values(mockTx.vendorAssessmentTemplate).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
    mockLogEvent.mockReset();
    mockLogEvent.mockResolvedValue(undefined);
    // Every test transitions the row it reads (#5318's conditional claim).
    mockTx.vendorAssessment.updateMany.mockResolvedValue({ count: 1 });
});

// ═══════════════════════════════════════════════════════════════════
// 1. Permission + status guards
// ═══════════════════════════════════════════════════════════════════

describe('reviewAssessment — guards', () => {
    test('rejects callers without canAdmin', async () => {
        await expect(
            reviewAssessment(makeCtx({ canAdmin: false }), 'a-1', {}),
        ).rejects.toThrow(/Only ADMIN/);
    });

    test('rejects an assessment that is not SUBMITTED', async () => {
        setupReviewMocks({ status: 'DRAFT' });
        await expect(
            reviewAssessment(makeCtx(), 'a-1', {}),
        ).rejects.toThrow(/SUBMITTED assessments/);
    });

    test('rejects when assessment is not in tenant', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce(null);
        await expect(
            reviewAssessment(makeCtx(), 'a-missing', {}),
        ).rejects.toThrow(/not found/i);
    });

    test('rejects legacy assessments missing templateVersionId', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({
            id: 'a-1',
            tenantId: 'tenant-1',
            status: 'SUBMITTED',
            templateVersionId: null,
            templateId: 'legacy',
        });
        await expect(
            reviewAssessment(makeCtx(), 'a-1', {}),
        ).rejects.toThrow(/legacy approval flow/);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Override application
// ═══════════════════════════════════════════════════════════════════

describe('reviewAssessment — overrides', () => {
    test('applies overridePoints + reviewerNotes via updateMany', async () => {
        setupReviewMocks({
            questions: [{ id: 'q1' }],
            answers: [{ questionId: 'q1', computedPoints: 2 }],
        });
        await reviewAssessment(makeCtx(), 'a-1', {
            overrides: [
                {
                    questionId: 'q1',
                    overridePoints: 7,
                    reviewerNotes: 'Reviewer judgement',
                },
            ],
        });

        expect(
            mockTx.vendorAssessmentAnswer.updateMany,
        ).toHaveBeenCalledTimes(1);
        const call = mockTx.vendorAssessmentAnswer.updateMany.mock.calls[0][0];
        expect(call.where).toMatchObject({
            assessmentId: 'a-1',
            tenantId: 'tenant-1',
            questionId: 'q1',
        });
        expect(call.data).toMatchObject({
            reviewerOverridePoints: 7,
            reviewerNotes: 'Reviewer judgement',
        });
    });

    test('overridePoints=null clears the override', async () => {
        setupReviewMocks({
            questions: [{ id: 'q1' }],
            answers: [{ questionId: 'q1', computedPoints: 2 }],
        });
        await reviewAssessment(makeCtx(), 'a-1', {
            overrides: [{ questionId: 'q1', overridePoints: null }],
        });
        const call = mockTx.vendorAssessmentAnswer.updateMany.mock.calls[0][0];
        expect(call.data).toEqual({ reviewerOverridePoints: null });
    });

    test('omitted override fields leave the existing values untouched', async () => {
        setupReviewMocks({
            questions: [{ id: 'q1' }],
            answers: [{ questionId: 'q1', computedPoints: 2 }],
        });
        await reviewAssessment(makeCtx(), 'a-1', {
            overrides: [{ questionId: 'q1' }],
        });
        // Empty data → updateMany not called at all (no-op).
        expect(
            mockTx.vendorAssessmentAnswer.updateMany,
        ).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Scoring engine integration
// ═══════════════════════════════════════════════════════════════════

describe('reviewAssessment — engine integration', () => {
    test('uses SIMPLE_SUM by default and applies overrides via the engine', async () => {
        setupReviewMocks({
            questions: [{ id: 'q1' }, { id: 'q2' }],
            // After overrides applied above, the post-update reload
            // returns the new state. Tests simulate that explicitly.
            answers: [
                { questionId: 'q1', computedPoints: 2, reviewerOverridePoints: 10 },
                { questionId: 'q2', computedPoints: 5 },
            ],
            scoringConfigJson: null,
        });
        const r = await reviewAssessment(makeCtx(), 'a-1', {});
        expect(r.scoring.mode).toBe('SIMPLE_SUM');
        expect(r.scoring.autoSum).toBe(7);
        expect(r.scoring.effectiveSum).toBe(15);
        expect(r.score).toBe(15);
    });

    test('honours WEIGHTED_AVERAGE config from the template', async () => {
        setupReviewMocks({
            questions: [{ id: 'q1', weight: 1 }, { id: 'q2', weight: 1 }],
            answers: [
                { questionId: 'q1', computedPoints: 4 },
                { questionId: 'q2', computedPoints: 2 },
            ],
            scoringConfigJson: { mode: 'WEIGHTED_AVERAGE' },
        });
        const r = await reviewAssessment(makeCtx(), 'a-1', {});
        expect(r.scoring.mode).toBe('WEIGHTED_AVERAGE');
        // 6 / 2 = 3
        expect(r.score).toBe(3);
    });

    test('honours PASS_FAIL_THRESHOLD config', async () => {
        setupReviewMocks({
            questions: [{ id: 'q1' }],
            answers: [{ questionId: 'q1', computedPoints: 7 }],
            scoringConfigJson: {
                mode: 'PASS_FAIL_THRESHOLD',
                threshold: 10,
            },
        });
        const r = await reviewAssessment(makeCtx(), 'a-1', {});
        expect(r.scoring.verdict).toBe('FAIL');
        expect(r.score).toBe(7);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Final-rating resolution
// ═══════════════════════════════════════════════════════════════════

describe('reviewAssessment — final rating', () => {
    test('manual override wins over engine suggestion', async () => {
        setupReviewMocks({
            questions: [{ id: 'q1' }],
            answers: [{ questionId: 'q1', computedPoints: 2 }],
            scoringConfigJson: {
                mode: 'SIMPLE_SUM',
                ratingThresholds: [
                    { rating: 'LOW', minScore: 0, maxScore: 5 },
                ],
            },
        });
        const r = await reviewAssessment(makeCtx(), 'a-1', {
            finalRiskRating: 'CRITICAL',
        });
        // Engine would suggest LOW (score=2 in [0,5]), but the
        // reviewer's manual rating wins.
        expect(r.riskRating).toBe('CRITICAL');
        expect(r.ratingOverridden).toBe(true);
        expect(r.scoring.suggestedRating).toBe('LOW');
    });

    test('omitted rating uses engine suggestion', async () => {
        setupReviewMocks({
            questions: [{ id: 'q1' }],
            answers: [{ questionId: 'q1', computedPoints: 2 }],
            scoringConfigJson: {
                mode: 'SIMPLE_SUM',
                ratingThresholds: [
                    { rating: 'LOW', minScore: 0, maxScore: 5 },
                ],
            },
        });
        const r = await reviewAssessment(makeCtx(), 'a-1', {});
        expect(r.riskRating).toBe('LOW');
        expect(r.ratingOverridden).toBe(false);
    });

    test('null rating override clears any engine suggestion', async () => {
        setupReviewMocks({
            questions: [{ id: 'q1' }],
            answers: [{ questionId: 'q1', computedPoints: 2 }],
            scoringConfigJson: {
                mode: 'SIMPLE_SUM',
                ratingThresholds: [
                    { rating: 'LOW', minScore: 0, maxScore: 5 },
                ],
            },
        });
        const r = await reviewAssessment(makeCtx(), 'a-1', {
            finalRiskRating: null,
        });
        expect(r.riskRating).toBeNull();
        expect(r.ratingOverridden).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Lifecycle transition + audit
// ═══════════════════════════════════════════════════════════════════

describe('reviewAssessment — lifecycle + audit', () => {
    test('transitions SUBMITTED → REVIEWED with all reviewer fields stamped', async () => {
        setupReviewMocks({
            questions: [{ id: 'q1' }],
            answers: [{ questionId: 'q1', computedPoints: 5 }],
        });
        await reviewAssessment(makeCtx(), 'a-1', {
            reviewerNotes: 'Looks fine',
        });
        const call = mockTx.vendorAssessment.update.mock.calls[0][0];
        expect(call.where).toEqual({ id: 'a-1' });
        expect(call.data).toMatchObject({
            status: 'REVIEWED',
            reviewedByUserId: 'user-reviewer',
            reviewerNotes: 'Looks fine',
            score: 5,
        });
        expect(call.data.reviewedAt).toBeInstanceOf(Date);
        expect(call.data.decidedAt).toBeInstanceOf(Date);
    });

    test('audit log carries full traceability', async () => {
        setupReviewMocks({
            questions: [{ id: 'q1' }, { id: 'q2' }],
            answers: [
                { questionId: 'q1', computedPoints: 3, reviewerOverridePoints: 10 },
                { questionId: 'q2', computedPoints: 4 },
            ],
        });
        await reviewAssessment(makeCtx(), 'a-1', {
            overrides: [{ questionId: 'q1', overridePoints: 10 }],
            finalRiskRating: 'HIGH',
        });
        const auditCall = mockLogEvent.mock.calls[0][2];
        expect(auditCall.action).toBe('VENDOR_ASSESSMENT_REVIEWED');
        expect(auditCall.detailsJson.after).toMatchObject({
            status: 'REVIEWED',
            mode: 'SIMPLE_SUM',
            autoSum: 7,
            effectiveSum: 14,
            score: 14,
            riskRating: 'HIGH',
            ratingOverridden: true,
            overrideCount: 1,
            answeredCount: 2,
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// 6. closeAssessment
// ═══════════════════════════════════════════════════════════════════

describe('closeAssessment', () => {
    test('rejects callers without canAdmin', async () => {
        await expect(
            closeAssessment(makeCtx({ canAdmin: false }), 'a-1'),
        ).rejects.toThrow(/Only ADMIN/);
    });

    test('rejects assessment not in REVIEWED status', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({
            id: 'a-1',
            status: 'SUBMITTED',
        });
        await expect(closeAssessment(makeCtx(), 'a-1')).rejects.toThrow(
            /REVIEWED assessments/,
        );
    });

    test('transitions REVIEWED → CLOSED with closedAt + closedByUserId', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({
            id: 'a-1',
            status: 'REVIEWED',
        });
        mockTx.vendorAssessment.update.mockResolvedValueOnce({});
        const r = await closeAssessment(
            makeCtx(),
            'a-1',
            'Archived after retention review',
        );
        expect(r.status).toBe('CLOSED');
        expect(r.closedAt).toBeInstanceOf(Date);
        const call = mockTx.vendorAssessment.update.mock.calls[0][0];
        expect(call.data).toMatchObject({
            status: 'CLOSED',
            closedByUserId: 'user-reviewer',
            reviewerNotes: 'Archived after retention review',
        });
    });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Concurrent transitions (#5318)
// ═══════════════════════════════════════════════════════════════════

describe('a transition lost to a concurrent request is refused before any side effect', () => {
    it('reviewAssessment: the claim is conditional on SUBMITTED, and a lost claim writes nothing', async () => {
        setupReviewMocks({ status: 'SUBMITTED' });
        mockTx.vendorAssessment.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(reviewAssessment(makeCtx(), 'a-1', {})).rejects.toThrow(/already been reviewed/);

        expect(mockTx.vendorAssessment.updateMany.mock.calls[0][0].where).toMatchObject({
            id: 'a-1', status: 'SUBMITTED',
        });
        expect(mockTx.vendorAssessment.update).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('closeAssessment: the claim is conditional on REVIEWED, and a lost claim writes nothing', async () => {
        mockTx.vendorAssessment.findFirst.mockResolvedValueOnce({ id: 'a-1', status: 'REVIEWED' });
        mockTx.vendorAssessment.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(closeAssessment(makeCtx(), 'a-1')).rejects.toThrow(/already been closed/);

        expect(mockTx.vendorAssessment.updateMany.mock.calls[0][0].where).toMatchObject({
            id: 'a-1', status: 'REVIEWED',
        });
        expect(mockTx.vendorAssessment.update).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });
});
