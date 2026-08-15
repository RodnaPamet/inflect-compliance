/**
 * Epic G-3 — Vendor Assessment Scoring Engine.
 *
 * Pure-function aggregator over (questions, answers, config). Three
 * modes share the same per-answer breakdown surface so the review
 * UI can render every input that fed into the final score:
 *
 *   SIMPLE_SUM
 *     score = Σ effective(answer)
 *     Used when the questionnaire's individual answer points already
 *     carry the full weight.
 *
 *   WEIGHTED_AVERAGE
 *     score = Σ effective(answer)  ÷  Σ weight(question for answer)
 *     Normalised to a 0..N "average per unit weight" so two
 *     templates with very different question counts can be compared.
 *
 *   PASS_FAIL_THRESHOLD
 *     verdict = sum(effective) >= config.threshold ? 'PASS' : 'FAIL'
 *     score still returned (the raw sum) so reviewers see the
 *     supporting number alongside the verdict.
 *
 * `effective(answer)` = `reviewerOverridePoints ?? computedPoints`.
 * The override is applied at this layer (not at submit time) so
 * reviews remain idempotent: running the engine twice produces the
 * same number for the same set of overrides.
 *
 * @module services/vendor-assessment-scoring-engine
 */

// ─── Public types ──────────────────────────────────────────────────

export type ScoringMode =
    | 'SIMPLE_SUM'
    | 'WEIGHTED_AVERAGE'
    | 'PASS_FAIL_THRESHOLD';

export interface RatingThreshold {
    rating: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    /** Inclusive lower bound. */
    minScore?: number;
    /** Inclusive upper bound. */
    maxScore?: number;
}

export interface ScoringConfig {
    /**
     * Which scale `ratingThresholds` are authored on.
     *
     * BOTH conventions exist in this codebase and neither was declared:
     *   - the seeded questionnaires use 0-25/26-50/51-75/76-100, i.e. PERCENT;
     *   - this engine's own tests use 0-1.5/1.5-3/3-4/4+, i.e. RAW
     *     points-per-unit-weight.
     *
     * Undeclared, WEIGHTED_AVERAGE bracketed the raw average against whatever
     * the operator wrote — so percentage thresholds put every achievable score
     * in the first bucket and every vendor auto-rated LOW.
     *
     * Defaults to RAW, which preserves every existing configuration. The seed
     * now declares PERCENT explicitly. Making the scale part of the config is
     * the fix: guessing it from the numbers would be right until someone
     * authors 0-10 buckets and means them.
     */
    thresholdScale?: 'RAW' | 'PERCENT';
    mode: ScoringMode;
    /** PASS_FAIL_THRESHOLD only. Score >= threshold ⇒ PASS. */
    threshold?: number;
    /**
     * Optional rating mapping for SIMPLE_SUM and WEIGHTED_AVERAGE.
     * Reviewers can still manually override the rating; this only
     * provides an automatic suggestion.
     */
    ratingThresholds?: RatingThreshold[];
}

export interface ScoringQuestion {
    id: string;
    weight: number;
    /** Whether this question contributes to the denominator in
     *  WEIGHTED_AVERAGE. Required-only mode is reserved for a
     *  future iteration; today every answered question contributes.
     */
    required?: boolean;
}

export interface ScoringAnswer {
    questionId: string;
    /** Auto-computed points from submission time. */
    computedPoints: number;
    /** Reviewer override; takes precedence when not null/undefined. */
    reviewerOverridePoints?: number | null;
}

export interface ScoringBreakdownEntry {
    questionId: string;
    weight: number;
    autoPoints: number;
    overridePoints: number | null;
    /** = override ?? auto. The number that landed in the sum. */
    effectivePoints: number;
}

export interface ScoringResult {
    mode: ScoringMode;
    /** SIMPLE_SUM | WEIGHTED_AVERAGE: the final score.
     *  PASS_FAIL_THRESHOLD: the raw sum behind the verdict. */
    score: number;
    /** Sum of weights across answered questions (denominator for
     *  WEIGHTED_AVERAGE; useful in the UI for context). */
    totalWeight: number;
    /** Sum of auto-computed points before any overrides.
     *  Surfaced so the UI can show "auto: X → reviewed: Y". */
    autoSum: number;
    /** Sum of effective points (post-override). */
    effectiveSum: number;
    verdict?: 'PASS' | 'FAIL';
    suggestedRating?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
    breakdown: ScoringBreakdownEntry[];
}

// ─── Engine ────────────────────────────────────────────────────────

export function scoreAssessment(input: {
    questions: ScoringQuestion[];
    answers: ScoringAnswer[];
    config?: ScoringConfig | null;
}): ScoringResult {
    const config = normaliseConfig(input.config);
    const questionMap = new Map(input.questions.map((q) => [q.id, q]));

    const breakdown: ScoringBreakdownEntry[] = [];
    let autoSum = 0;
    let effectiveSum = 0;
    let totalWeight = 0;

    for (const a of input.answers) {
        const q = questionMap.get(a.questionId);
        if (!q) continue;
        const auto = Number.isFinite(a.computedPoints) ? a.computedPoints : 0;
        const override =
            a.reviewerOverridePoints !== null &&
            a.reviewerOverridePoints !== undefined &&
            Number.isFinite(a.reviewerOverridePoints)
                ? a.reviewerOverridePoints
                : null;
        const effective = override ?? auto;
        const weight = Number.isFinite(q.weight) ? q.weight : 1;

        autoSum += auto;
        effectiveSum += effective;
        totalWeight += weight;

        breakdown.push({
            questionId: a.questionId,
            weight,
            autoPoints: auto,
            overridePoints: override,
            effectivePoints: effective,
        });
    }

    const result: ScoringResult = {
        mode: config.mode,
        score: 0,
        totalWeight,
        autoSum,
        effectiveSum,
        breakdown,
    };

    switch (config.mode) {
        case 'SIMPLE_SUM':
            result.score = effectiveSum;
            result.suggestedRating = deriveRating(
                effectiveSum,
                config.ratingThresholds,
            );
            break;
        case 'WEIGHTED_AVERAGE':
            // Defensive divide-by-zero — empty assessment is an
            // edge case for the review UI, not the runtime.
            result.score = totalWeight > 0 ? effectiveSum / totalWeight : 0;
            // Rate on the PERCENTAGE, not the raw average.
            //
            // `score` here is points-per-unit-weight. The shipped fixtures use
            // option points in [-10, 10], so it cannot exceed ~10 — while
            // every ratingThresholds set in this codebase is authored 0-100.
            // Bracketing the raw average therefore put EVERY achievable score
            // in the first bucket: every vendor auto-rated LOW, that rating
            // was written to VendorAssessment.riskRating and stamped onto
            // Vendor.inherentRisk, and the auto-created HIGH/CRITICAL register
            // Risk was dead code in production.
            //
            // This is not a new convention. `computeAssessmentScore` in
            // vendor-scoring.ts already normalises the same way
            // (`maxPossible = totalWeight * MAX_POINTS_PER_QUESTION`, then
            // percent), and its `scoreToRiskRating` uses exactly the buckets
            // the thresholds are seeded with — <=25 / <=50 / <=75 / else. The
            // newer engine simply did not carry it across, which is the same
            // two-implementations-of-one-rule class as the YES_NO lookup.
            result.suggestedRating = deriveRating(
                config.thresholdScale === 'PERCENT'
                    ? toPercentScore(result.score)
                    : result.score,
                config.ratingThresholds,
            );
            break;
        case 'PASS_FAIL_THRESHOLD': {
            const threshold = config.threshold ?? 0;
            result.score = effectiveSum;
            result.verdict = effectiveSum >= threshold ? 'PASS' : 'FAIL';
            // PASS_FAIL doesn't produce a categorical rating; the
            // review UI surfaces the verdict directly. We still
            // honour ratingThresholds if the operator configured
            // them — useful when the same template is used for
            // both compliance gates AND vendor-tier triage.
            result.suggestedRating = deriveRating(
                effectiveSum,
                config.ratingThresholds,
            );
            break;
        }
    }

    return result;
}

// ─── Helpers ───────────────────────────────────────────────────────

function normaliseConfig(
    raw: ScoringConfig | null | undefined,
): ScoringConfig {
    if (!raw) return { mode: 'SIMPLE_SUM' };
    return {
        mode: raw.mode,
        threshold: raw.threshold,
        ratingThresholds: raw.ratingThresholds,
        // Carried explicitly. This function rebuilds the config from named
        // fields rather than spreading, so anything not listed here is
        // silently dropped — a new option would reach the engine as undefined
        // and read as "RAW" no matter what the operator configured.
        thresholdScale: raw.thresholdScale,
    };
}

/**
 * Walk rating thresholds and return the first that brackets the
 * score. Returns null when no thresholds are configured OR when
 * the score doesn't match any bucket. The reviewer can still
 * supply a manual override on top.
 */
/**
 * Convert a points-per-unit-weight average into the 0-100 scale that every
 * `ratingThresholds` set in this codebase is authored on.
 *
 * MAX_POINTS_PER_QUESTION mirrors `computeAssessmentScore`'s `maxPossible =
 * totalWeight * 10`. Keeping the constant named and in one place is the point:
 * the previous arrangement had the assumption written as a trailing comment in
 * one file and not at all in the other, which is how the two drifted.
 *
 * Negative points are legitimate (the fixtures range -10..10), so the floor is
 * clamped at 0 rather than allowed to go negative — a score below every
 * bracket returns null from deriveRating, which reads to a reviewer as "no
 * suggestion" rather than "low risk", and that distinction matters.
 */
const MAX_POINTS_PER_QUESTION = 10;

export function toPercentScore(pointsPerUnitWeight: number): number {
    if (!Number.isFinite(pointsPerUnitWeight)) return 0;
    const pct = (pointsPerUnitWeight / MAX_POINTS_PER_QUESTION) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
}

function deriveRating(
    score: number,
    thresholds: RatingThreshold[] | undefined,
): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null {
    if (!thresholds || thresholds.length === 0) return null;
    for (const t of thresholds) {
        const minOk = t.minScore === undefined || score >= t.minScore;
        const maxOk = t.maxScore === undefined || score <= t.maxScore;
        if (minOk && maxOk) return t.rating;
    }
    return null;
}

/**
 * Parse a stored `scoringConfigJson` blob. Returns null for both
 * missing-config and invalid-config — invalid is logged at the
 * caller (review usecase) so the reviewer sees a clear "couldn't
 * parse this template's scoring config" surface rather than a
 * silent fall-through to SIMPLE_SUM.
 */
export function parseScoringConfig(
    raw: unknown,
): ScoringConfig | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as {
        mode?: unknown;
        threshold?: unknown;
        ratingThresholds?: unknown;
    };
    const mode =
        r.mode === 'SIMPLE_SUM' ||
        r.mode === 'WEIGHTED_AVERAGE' ||
        r.mode === 'PASS_FAIL_THRESHOLD'
            ? r.mode
            : null;
    if (!mode) return null;

    const config: ScoringConfig = { mode };
    if (typeof r.threshold === 'number' && Number.isFinite(r.threshold)) {
        config.threshold = r.threshold;
    }
    if (Array.isArray(r.ratingThresholds)) {
        const out: RatingThreshold[] = [];
        for (const t of r.ratingThresholds) {
            if (!t || typeof t !== 'object') continue;
            const tr = t as {
                rating?: unknown;
                minScore?: unknown;
                maxScore?: unknown;
            };
            if (
                tr.rating !== 'LOW' &&
                tr.rating !== 'MEDIUM' &&
                tr.rating !== 'HIGH' &&
                tr.rating !== 'CRITICAL'
            ) {
                continue;
            }
            const entry: RatingThreshold = { rating: tr.rating };
            if (typeof tr.minScore === 'number') entry.minScore = tr.minScore;
            if (typeof tr.maxScore === 'number') entry.maxScore = tr.maxScore;
            out.push(entry);
        }
        if (out.length > 0) config.ratingThresholds = out;
    }
    return config;
}
