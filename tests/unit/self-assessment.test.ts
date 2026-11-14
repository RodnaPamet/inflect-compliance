/**
 * Unit tests for the getting-started Digital Sovereignty self-assessment.
 *
 * Two layers:
 *   - the PURE scorer (`@/lib/self-assessments/scoring`) — dimension means,
 *     overall + 0–100 normalization, maturity band, weakest ranking, and the
 *     below-threshold gap-suggestion builder;
 *   - the materialize usecase (`@/app-layer/usecases/self-assessment`) — the
 *     propose→commit boundary: server re-scores, honours per-dimension
 *     approvals, dedupes idempotently, and NEVER writes for an unapproved or
 *     non-gap dimension. The DB, createRisk and createControl are mocked.
 */
import { makeRequestContext } from '../helpers/make-context';
import {
    DIGITAL_SOVEREIGNTY_ASSESSMENT,
    SOVEREIGNTY_GAP_THRESHOLD,
} from '@/data/self-assessments/digital-sovereignty';
import {
    scoreSelfAssessment,
    buildGapSuggestions,
    type SelfAssessmentAnswers,
} from '@/lib/self-assessments/scoring';

// ── Mocks for the usecase layer ────────────────────────────────────────────
const mockTx = {
    risk: { findMany: jest.fn() },
    control: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => Promise<unknown>) => fn(mockTx)),
}));
const createRisk = jest.fn();
const createControl = jest.fn();
jest.mock('@/app-layer/usecases/risk', () => ({ createRisk: (...a: unknown[]) => createRisk(...a) }));
jest.mock('@/app-layer/usecases/control/mutations', () => ({ createControl: (...a: unknown[]) => createControl(...a) }));

import {
    materializeSelfAssessmentSuggestions,
    scoreSelfAssessmentByKey,
    getSelfAssessment,
    SELF_ASSESSMENT_CATEGORY,
} from '@/app-layer/usecases/self-assessment';

const ctx = makeRequestContext('ADMIN');

/** Answer every question of the given dimension ids with a fixed 0..4 score. */
function answerDimensions(map: Record<number, number>): SelfAssessmentAnswers {
    const answers: SelfAssessmentAnswers = {};
    for (const dim of DIGITAL_SOVEREIGNTY_ASSESSMENT.dimensions) {
        const v = map[dim.id];
        if (v == null) continue;
        for (const q of dim.questions) answers[q.id] = v;
    }
    return answers;
}

describe('scoreSelfAssessment (pure)', () => {
    it('returns nulls when nothing is answered', () => {
        const score = scoreSelfAssessment(DIGITAL_SOVEREIGNTY_ASSESSMENT, {});
        expect(score.overall).toBeNull();
        expect(score.overall100).toBeNull();
        expect(score.band).toBeNull();
        expect(score.answered).toBe(0);
        expect(score.total).toBe(30);
        expect(score.dimensions.every((d) => d.mean === null)).toBe(true);
    });

    it('computes dimension means, overall, 0–100 normalization and band', () => {
        // Dim 1 all-0, Dim 2 all-4; the rest unanswered.
        const score = scoreSelfAssessment(DIGITAL_SOVEREIGNTY_ASSESSMENT, answerDimensions({ 1: 0, 2: 4 }));
        const d1 = score.dimensions.find((d) => d.id === 1)!;
        const d2 = score.dimensions.find((d) => d.id === 2)!;
        expect(d1.mean).toBe(0);
        expect(d1.answered).toBe(5);
        expect(d2.mean).toBe(4);
        // overall = mean of the two SCORED dimensions = 2.
        expect(score.overall).toBe(2);
        expect(score.overall100).toBe(50);
        expect(score.band).toBe('managed'); // 2 falls in [2,3) → managed
        expect(score.answered).toBe(10);
    });

    it('ranks weakest dimensions first and only includes scored ones', () => {
        const score = scoreSelfAssessment(DIGITAL_SOVEREIGNTY_ASSESSMENT, answerDimensions({ 1: 3, 2: 1, 3: 4 }));
        expect(score.weakest.map((d) => d.id)).toEqual([2, 1, 3]);
    });

    it('maps a perfect score to the top band', () => {
        const all4 = answerDimensions({ 1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 4 });
        const score = scoreSelfAssessment(DIGITAL_SOVEREIGNTY_ASSESSMENT, all4);
        expect(score.overall).toBe(4);
        expect(score.overall100).toBe(100);
        expect(score.band).toBe('sovereignReady');
    });
});

describe('buildGapSuggestions (pure)', () => {
    it('emits a suggestion for every dimension strictly below the threshold', () => {
        // Dim 1 & 3 below threshold (mean 0 / 1); Dim 2 at/above (mean 2).
        const score = scoreSelfAssessment(
            DIGITAL_SOVEREIGNTY_ASSESSMENT,
            answerDimensions({ 1: 0, 2: SOVEREIGNTY_GAP_THRESHOLD, 3: 1 }),
        );
        const gaps = buildGapSuggestions(DIGITAL_SOVEREIGNTY_ASSESSMENT, score);
        expect(gaps.map((g) => g.dimensionId).sort()).toEqual([1, 3]);
        // Suggestion carries the template fields, never regulatory prose.
        const g1 = gaps.find((g) => g.dimensionId === 1)!;
        expect(g1.riskTitle).toBeTruthy();
        expect(g1.controlName).toBeTruthy();
        expect(g1.clauseRef).toBeTruthy();
    });

    it('emits nothing when every scored dimension is at or above the threshold', () => {
        const score = scoreSelfAssessment(DIGITAL_SOVEREIGNTY_ASSESSMENT, answerDimensions({ 1: 4, 2: 4 }));
        expect(buildGapSuggestions(DIGITAL_SOVEREIGNTY_ASSESSMENT, score)).toEqual([]);
    });

    it('never suggests for an unanswered dimension (null mean)', () => {
        const score = scoreSelfAssessment(DIGITAL_SOVEREIGNTY_ASSESSMENT, answerDimensions({ 1: 0 }));
        const gaps = buildGapSuggestions(DIGITAL_SOVEREIGNTY_ASSESSMENT, score);
        expect(gaps.map((g) => g.dimensionId)).toEqual([1]);
    });
});

describe('materializeSelfAssessmentSuggestions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockTx.risk.findMany.mockResolvedValue([]);
        mockTx.control.findMany.mockResolvedValue([]);
        createRisk.mockImplementation(async () => ({ id: `risk-${createRisk.mock.calls.length}` }));
        createControl.mockImplementation(async () => ({ id: `ctl-${createControl.mock.calls.length}` }));
    });

    it('creates a risk + control for an approved gap dimension, tagged with the category', async () => {
        const answers = answerDimensions({ 1: 0 }); // dim 1 is a gap
        const result = await materializeSelfAssessmentSuggestions(ctx, {
            key: 'digital-sovereignty',
            answers,
            approvals: [{ dimensionId: 1, createRisk: true, createControl: true }],
        });
        expect(result.createdRiskIds).toHaveLength(1);
        expect(result.createdControlIds).toHaveLength(1);
        expect(result.skipped).toBe(0);
        expect(createRisk).toHaveBeenCalledWith(ctx, expect.objectContaining({ category: SELF_ASSESSMENT_CATEGORY }));
        expect(createControl).toHaveBeenCalledWith(ctx, expect.objectContaining({ category: SELF_ASSESSMENT_CATEGORY, isCustom: true }));
    });

    it('ignores an approval for a dimension that is NOT a gap (server re-scores)', async () => {
        // Client approves dim 2, but dim 2 scores at threshold → not a gap.
        const answers = answerDimensions({ 1: 0, 2: 4 });
        const result = await materializeSelfAssessmentSuggestions(ctx, {
            key: 'digital-sovereignty',
            answers,
            approvals: [{ dimensionId: 2, createRisk: true, createControl: true }],
        });
        expect(createRisk).not.toHaveBeenCalled();
        expect(createControl).not.toHaveBeenCalled();
        expect(result).toEqual({ createdRiskIds: [], createdControlIds: [], skipped: 0 });
    });

    it('honours per-dimension createRisk/createControl toggles', async () => {
        const answers = answerDimensions({ 1: 0 });
        await materializeSelfAssessmentSuggestions(ctx, {
            key: 'digital-sovereignty',
            answers,
            approvals: [{ dimensionId: 1, createRisk: false, createControl: true }],
        });
        expect(createRisk).not.toHaveBeenCalled();
        expect(createControl).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — skips a suggestion whose risk/control already exists in the category', async () => {
        const dim1 = DIGITAL_SOVEREIGNTY_ASSESSMENT.dimensions.find((d) => d.id === 1)!;
        mockTx.risk.findMany.mockResolvedValue([{ title: dim1.suggestion.riskTitle }]);
        mockTx.control.findMany.mockResolvedValue([{ name: dim1.suggestion.controlName }]);
        const result = await materializeSelfAssessmentSuggestions(ctx, {
            key: 'digital-sovereignty',
            answers: answerDimensions({ 1: 0 }),
            approvals: [{ dimensionId: 1, createRisk: true, createControl: true }],
        });
        expect(createRisk).not.toHaveBeenCalled();
        expect(createControl).not.toHaveBeenCalled();
        expect(result.skipped).toBe(2);
    });

    it('writes nothing when no approvals map to a gap', async () => {
        const result = await materializeSelfAssessmentSuggestions(ctx, {
            key: 'digital-sovereignty',
            answers: answerDimensions({ 1: 0 }),
            approvals: [],
        });
        expect(result).toEqual({ createdRiskIds: [], createdControlIds: [], skipped: 0 });
        // No DB lookup happens when nothing is approved.
        expect(mockTx.risk.findMany).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range answer score at the schema boundary', async () => {
        await expect(
            materializeSelfAssessmentSuggestions(ctx, {
                key: 'digital-sovereignty',
                answers: { 'ds-1-01': 9 },
                approvals: [],
            }),
        ).rejects.toThrow();
    });
});

describe('registry helpers', () => {
    it('getSelfAssessment throws on an unknown key', () => {
        expect(() => getSelfAssessment('nope' as never)).toThrow();
    });

    it('scoreSelfAssessmentByKey scores + builds suggestions for a known key', () => {
        const { score, suggestions } = scoreSelfAssessmentByKey('digital-sovereignty', answerDimensions({ 1: 0 }));
        expect(score.dimensions.find((d) => d.id === 1)!.mean).toBe(0);
        expect(suggestions.map((s) => s.dimensionId)).toContain(1);
    });
});
