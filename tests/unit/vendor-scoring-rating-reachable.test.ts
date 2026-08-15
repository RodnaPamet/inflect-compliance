/**
 * Every rating a template declares must be REACHABLE.
 *
 * The shipped questionnaires score on one scale and declare their rating
 * thresholds on another:
 *
 *   WEIGHTED_AVERAGE returns Σ(points·weight) ÷ Σweight, and the fixtures use
 *   option points in [-10, 10] — so the score cannot exceed ~10.
 *   The seeded ratingThresholds (prisma/seed.ts:2407-2412) are
 *   0-25 / 26-50 / 51-75 / 76-100, authored as percentages.
 *
 * `deriveRating` returns the first bracket that brackets the score, so EVERY
 * achievable score lands in LOW. The consequence is not cosmetic:
 * `reviewAssessment` writes the suggestion to `VendorAssessment.riskRating`,
 * `applyAssessmentRiskWriteback` stamps it onto `Vendor.inherentRisk`, and the
 * auto-created register Risk is gated on HIGH/CRITICAL — so that branch is
 * dead code in production and every reviewed vendor is recorded as low risk.
 *
 * No existing test caught this because each half is internally consistent:
 * the engine's arithmetic is correct and the thresholds are well-formed. Only
 * the RELATIONSHIP between them is wrong.
 *
 * Asserted as a PROPERTY rather than a fixed expected value, so it stays
 * meaningful whichever way the mismatch is resolved — rescale the engine to a
 * percentage, or re-author the thresholds. Driven through `scoreAssessment`,
 * the real entry point, rather than internals exposed for the test.
 */
import {
    scoreAssessment,
    type ScoringConfig,
    type ScoringQuestion,
    type ScoringAnswer,
} from '@/app-layer/services/vendor-assessment-scoring-engine';

const CONFIG: ScoringConfig = {
    mode: 'WEIGHTED_AVERAGE',
    // The seeded questionnaires author percentages; declaring it is the fix.
    thresholdScale: 'PERCENT',
    ratingThresholds: [
        { rating: 'LOW', minScore: 0, maxScore: 25 },
        { rating: 'MEDIUM', minScore: 26, maxScore: 50 },
        { rating: 'HIGH', minScore: 51, maxScore: 75 },
        { rating: 'CRITICAL', minScore: 76, maxScore: 100 },
    ],
};

/** The shipped fixture point scale: every option is worth -10..10. */
const FIXTURE_MAX_POINTS = 10;
const FIXTURE_MIN_POINTS = -10;

function ratingFor(points: number): string | null | undefined {
    const questions: ScoringQuestion[] = [
        { id: 'q1', weight: 1, riskPointsJson: null } as unknown as ScoringQuestion,
    ];
    const answers: ScoringAnswer[] = [
        { questionId: 'q1', computedPoints: points } as unknown as ScoringAnswer,
    ];
    return scoreAssessment({ questions, answers, config: CONFIG }).suggestedRating;
}

describe('rating thresholds are reachable by the scores the engine produces', () => {
    it('more than one RATING is reachable across the whole answer space', () => {
        // Deliberately counts non-null ratings only.
        //
        // An earlier version asserted `best !== worst` and PASSED — for the
        // wrong reason: a score of -10 falls outside every bracket and yields
        // null, so null-vs-LOW satisfied it while the ratings were still
        // degenerate. A test that passes because a value is missing is worse
        // than no test.
        const ratings = new Set<string>();
        for (let p = FIXTURE_MIN_POINTS; p <= FIXTURE_MAX_POINTS; p += 0.25) {
            const r = ratingFor(p);
            if (typeof r === 'string') ratings.add(r);
        }
        expect([...ratings].sort()).not.toEqual(['LOW']);
    });

    it.each(['MEDIUM', 'HIGH', 'CRITICAL'])('%s is reachable', (rating) => {
        const reachable = new Set<string | null | undefined>();
        for (let p = FIXTURE_MIN_POINTS; p <= FIXTURE_MAX_POINTS; p += 0.25) {
            reachable.add(ratingFor(p));
        }
        expect([...reachable]).toContain(rating);
    });
});
