/**
 * Epic G-3 prompt 5 — scoring-engine unit tests.
 *
 * Pure-function tests covering:
 *
 *   • SIMPLE_SUM                — sum of effective points
 *   • WEIGHTED_AVERAGE          — sum / total weight
 *   • PASS_FAIL_THRESHOLD       — verdict against threshold
 *   • Override precedence       — reviewerOverridePoints wins
 *   • Empty / missing answers   — divide-by-zero, unknown question
 *   • parseScoringConfig        — accepts valid, refuses garbage
 */

import {
    scoreAssessment,
    parseScoringConfig,
    type ScoringConfig,
} from '@/app-layer/services/vendor-assessment-scoring-engine';

const Q = (id: string, weight = 1, required = false) => ({
    id,
    weight,
    required,
});
const A = (
    questionId: string,
    computedPoints: number,
    reviewerOverridePoints: number | null = null,
) => ({ questionId, computedPoints, reviewerOverridePoints });

// ─── 1. SIMPLE_SUM ─────────────────────────────────────────────────

describe('scoring engine — SIMPLE_SUM', () => {
    test('sums effective points across all answered questions', () => {
        const r = scoreAssessment({
            questions: [Q('q1'), Q('q2'), Q('q3')],
            answers: [A('q1', 2), A('q2', 5), A('q3', 1)],
            config: { mode: 'SIMPLE_SUM' },
        });
        expect(r.mode).toBe('SIMPLE_SUM');
        expect(r.score).toBe(8);
        expect(r.autoSum).toBe(8);
        expect(r.effectiveSum).toBe(8);
    });

    test('null config defaults to SIMPLE_SUM', () => {
        const r = scoreAssessment({
            questions: [Q('q1')],
            answers: [A('q1', 3)],
            config: null,
        });
        expect(r.mode).toBe('SIMPLE_SUM');
        expect(r.score).toBe(3);
    });

    test('answers for unknown question ids are skipped', () => {
        const r = scoreAssessment({
            questions: [Q('q1')],
            answers: [A('q1', 3), A('phantom', 99)],
            config: { mode: 'SIMPLE_SUM' },
        });
        expect(r.score).toBe(3);
        expect(r.breakdown).toHaveLength(1);
    });

    test('NaN / Infinity computedPoints fall back to zero', () => {
        const r = scoreAssessment({
            questions: [Q('q1'), Q('q2')],
            answers: [A('q1', NaN), A('q2', 5)],
            config: { mode: 'SIMPLE_SUM' },
        });
        expect(r.score).toBe(5);
    });
});

// ─── 2. Override precedence ────────────────────────────────────────

describe('scoring engine — reviewer override precedence', () => {
    test('overridePoints wins when set', () => {
        const r = scoreAssessment({
            questions: [Q('q1'), Q('q2')],
            answers: [A('q1', 2, 10), A('q2', 5)],
            config: { mode: 'SIMPLE_SUM' },
        });
        expect(r.score).toBe(15); // 10 + 5
        expect(r.autoSum).toBe(7);
        expect(r.effectiveSum).toBe(15);
        expect(r.breakdown[0]).toMatchObject({
            autoPoints: 2,
            overridePoints: 10,
            effectivePoints: 10,
        });
        expect(r.breakdown[1]).toMatchObject({
            autoPoints: 5,
            overridePoints: null,
            effectivePoints: 5,
        });
    });

    test('null override is treated as no override', () => {
        const r = scoreAssessment({
            questions: [Q('q1')],
            answers: [A('q1', 2, null)],
            config: { mode: 'SIMPLE_SUM' },
        });
        expect(r.score).toBe(2);
        expect(r.breakdown[0].overridePoints).toBeNull();
    });

    test('zero override is honoured (NOT treated as missing)', () => {
        const r = scoreAssessment({
            questions: [Q('q1')],
            answers: [A('q1', 5, 0)],
            config: { mode: 'SIMPLE_SUM' },
        });
        // The reviewer is explicitly setting points to 0 — that's
        // a legitimate "no credit" decision; it must not silently
        // fall back to the auto-computed 5.
        expect(r.score).toBe(0);
        expect(r.breakdown[0].overridePoints).toBe(0);
        expect(r.breakdown[0].effectivePoints).toBe(0);
    });
});

// ─── 3. WEIGHTED_AVERAGE ───────────────────────────────────────────

describe('scoring engine — WEIGHTED_AVERAGE', () => {
    test('sum / total weight', () => {
        const r = scoreAssessment({
            questions: [Q('q1', 2), Q('q2', 1), Q('q3', 1)],
            answers: [A('q1', 4), A('q2', 6), A('q3', 2)],
            config: { mode: 'WEIGHTED_AVERAGE' },
        });
        // sum = 12, weights = 4 → score = 3
        expect(r.score).toBe(3);
        expect(r.totalWeight).toBe(4);
    });

    test('zero-answer assessment returns 0 (no divide-by-zero)', () => {
        const r = scoreAssessment({
            questions: [Q('q1')],
            answers: [],
            config: { mode: 'WEIGHTED_AVERAGE' },
        });
        expect(r.score).toBe(0);
        expect(r.totalWeight).toBe(0);
    });
});

// ─── 4. PASS_FAIL_THRESHOLD ────────────────────────────────────────

describe('scoring engine — PASS_FAIL_THRESHOLD', () => {
    test('sum >= threshold ⇒ PASS', () => {
        const r = scoreAssessment({
            questions: [Q('q1'), Q('q2')],
            answers: [A('q1', 3), A('q2', 4)],
            config: { mode: 'PASS_FAIL_THRESHOLD', threshold: 5 },
        });
        expect(r.score).toBe(7);
        expect(r.verdict).toBe('PASS');
    });

    test('sum < threshold ⇒ FAIL', () => {
        const r = scoreAssessment({
            questions: [Q('q1')],
            answers: [A('q1', 2)],
            config: { mode: 'PASS_FAIL_THRESHOLD', threshold: 5 },
        });
        expect(r.score).toBe(2);
        expect(r.verdict).toBe('FAIL');
    });

    test('threshold defaults to 0 (every score passes)', () => {
        const r = scoreAssessment({
            questions: [Q('q1')],
            answers: [A('q1', 0)],
            config: { mode: 'PASS_FAIL_THRESHOLD' },
        });
        expect(r.verdict).toBe('PASS');
    });
});

// ─── 5. Rating thresholds ──────────────────────────────────────────

describe('scoring engine — ratingThresholds', () => {
    const cfg: ScoringConfig = {
        mode: 'WEIGHTED_AVERAGE',
        ratingThresholds: [
            { rating: 'LOW', minScore: 0, maxScore: 1.5 },
            { rating: 'MEDIUM', minScore: 1.500001, maxScore: 3 },
            { rating: 'HIGH', minScore: 3.000001, maxScore: 4 },
            { rating: 'CRITICAL', minScore: 4.000001 },
        ],
    };

    test('first matching bucket wins', () => {
        const r = scoreAssessment({
            questions: [Q('q1', 1), Q('q2', 1)],
            answers: [A('q1', 1), A('q2', 0)],
            config: cfg,
        });
        // sum 1, weight 2 → 0.5 → LOW
        expect(r.suggestedRating).toBe('LOW');
    });

    test('open-ended top bucket', () => {
        const r = scoreAssessment({
            questions: [Q('q1')],
            answers: [A('q1', 100)],
            config: cfg,
        });
        // 100 / 1 = 100 → past every bucket → CRITICAL (no maxScore)
        expect(r.suggestedRating).toBe('CRITICAL');
    });

    test('returns null when no bucket matches', () => {
        const r = scoreAssessment({
            questions: [Q('q1')],
            answers: [A('q1', 100)],
            config: {
                mode: 'SIMPLE_SUM',
                ratingThresholds: [
                    { rating: 'LOW', minScore: 0, maxScore: 5 },
                ],
            },
        });
        expect(r.suggestedRating).toBeNull();
    });

    test('no thresholds → null suggested rating', () => {
        const r = scoreAssessment({
            questions: [Q('q1')],
            answers: [A('q1', 5)],
            config: { mode: 'SIMPLE_SUM' },
        });
        expect(r.suggestedRating).toBeNull();
    });
});

// ─── 6. parseScoringConfig ────────────────────────────────────────

describe('parseScoringConfig', () => {
    test('returns null for null/garbage input', () => {
        expect(parseScoringConfig(null)).toBeNull();
        expect(parseScoringConfig('not-an-object')).toBeNull();
        expect(parseScoringConfig({})).toBeNull();
        expect(parseScoringConfig({ mode: 'BOGUS' })).toBeNull();
    });

    test('keeps a declared thresholdScale, and drops an unknown one (#5136)', () => {
        expect(parseScoringConfig({ mode: 'WEIGHTED_AVERAGE', thresholdScale: 'PERCENT' })).toEqual({
            mode: 'WEIGHTED_AVERAGE',
            thresholdScale: 'PERCENT',
        });
        expect(parseScoringConfig({ mode: 'WEIGHTED_AVERAGE', thresholdScale: 'RAW' })?.thresholdScale).toBe('RAW');
        expect(parseScoringConfig({ mode: 'WEIGHTED_AVERAGE', thresholdScale: 'percent' })).toEqual({
            mode: 'WEIGHTED_AVERAGE',
        });
    });

    test('parses a valid mode-only config', () => {
        const r = parseScoringConfig({ mode: 'SIMPLE_SUM' });
        expect(r).toEqual({ mode: 'SIMPLE_SUM' });
    });

    test('parses pass/fail with threshold', () => {
        const r = parseScoringConfig({
            mode: 'PASS_FAIL_THRESHOLD',
            threshold: 7,
        });
        expect(r).toEqual({ mode: 'PASS_FAIL_THRESHOLD', threshold: 7 });
    });

    test('parses rating thresholds and skips invalid entries', () => {
        const r = parseScoringConfig({
            mode: 'WEIGHTED_AVERAGE',
            ratingThresholds: [
                { rating: 'LOW', minScore: 0, maxScore: 1 },
                { rating: 'BOGUS', minScore: 1 },
                { rating: 'HIGH', minScore: 3 },
                'not-an-object',
            ],
        });
        expect(r?.ratingThresholds).toEqual([
            { rating: 'LOW', minScore: 0, maxScore: 1 },
            { rating: 'HIGH', minScore: 3 },
        ]);
    });
});
