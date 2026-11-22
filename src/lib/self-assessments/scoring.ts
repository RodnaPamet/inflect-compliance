/**
 * Self-assessment scorer + gap-suggestion builder — PURE.
 *
 * Isomorphic (runs client- or server-side), imports NO usecase, and NEVER
 * calls a create-usecase. It turns answers into dimension means, an overall
 * mean + 0–100 normalization, a maturity band, a weakest-dimension ranking,
 * and — for dimensions below the gap threshold — SUGGESTION OBJECTS only.
 * Materialising a suggestion into a real risk/control is a separate, explicit,
 * approval-gated step in `usecases/self-assessment`.
 *
 * The propose-not-commit boundary lives here: this module proposes; it does
 * not commit.
 */
import type { SelfAssessment, SelfAssessmentDimension, SovereigntyBandKey } from '@/data/self-assessments/digital-sovereignty';
import { SOVEREIGNTY_MATURITY_BANDS, SOVEREIGNTY_GAP_THRESHOLD } from '@/data/self-assessments/digital-sovereignty';

/** Answers: questionId → chosen option score (0..4). */
export type SelfAssessmentAnswers = Record<string, number>;

export interface DimensionScore {
    id: number;
    labelKey: string;
    clauseRefs: string[];
    /** Mean of answered questions, 0..4 — null if the dimension is unanswered. */
    mean: number | null;
    answered: number;
    total: number;
}

export interface SelfAssessmentScore {
    dimensions: DimensionScore[];
    /** Overall mean of scored dimensions, 0..4 — null if nothing answered. */
    overall: number | null;
    /** Overall normalised to 0–100 for the summary badge — null if unanswered. */
    overall100: number | null;
    /**
     * Maturity band KEY (badge only — NOT a compliance claim). The UI renders
     * it through `onboarding.sovereignty.bands.<key>`; it is never English text.
     */
    band: SovereigntyBandKey | null;
    /** Dimensions ranked weakest-first (scored only). */
    weakest: DimensionScore[];
    answered: number;
    total: number;
}

function mean(nums: number[]): number | null {
    if (nums.length === 0) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function bandFor(overall: number | null): SovereigntyBandKey | null {
    if (overall == null) return null;
    for (const b of SOVEREIGNTY_MATURITY_BANDS) {
        if (overall < b.max) return b.key;
    }
    return SOVEREIGNTY_MATURITY_BANDS[SOVEREIGNTY_MATURITY_BANDS.length - 1].key;
}

function scoreDimension(dim: SelfAssessmentDimension, answers: SelfAssessmentAnswers): DimensionScore {
    const scores: number[] = [];
    for (const q of dim.questions) {
        const v = answers[q.id];
        if (typeof v === 'number') scores.push(v);
    }
    return {
        id: dim.id,
        labelKey: dim.labelKey,
        clauseRefs: dim.clauseRefs,
        mean: mean(scores),
        answered: scores.length,
        total: dim.questions.length,
    };
}

/** Score an assessment from a set of answers. Pure. */
export function scoreSelfAssessment(
    assessment: SelfAssessment,
    answers: SelfAssessmentAnswers,
): SelfAssessmentScore {
    const dimensions = assessment.dimensions.map((d) => scoreDimension(d, answers));
    const scoredMeans = dimensions.map((d) => d.mean).filter((m): m is number => m != null);
    const overall = mean(scoredMeans);
    const overall100 = overall == null ? null : Math.round((overall / 4) * 100);
    const weakest = dimensions
        .filter((d) => d.mean != null)
        .sort((a, b) => (a.mean! - b.mean!));
    return {
        dimensions,
        overall,
        overall100,
        band: bandFor(overall),
        weakest,
        answered: dimensions.reduce((n, d) => n + d.answered, 0),
        total: dimensions.reduce((n, d) => n + d.total, 0),
    };
}

/** One proposed remediation — a template, never committed here. */
export interface GapSuggestion {
    dimensionId: number;
    labelKey: string;
    riskTitle: string;
    controlName: string;
    clauseRef: string;
}

/**
 * Build the gap suggestions: for every dimension scored BELOW the threshold,
 * emit its suggestion template (title + clause ref only). This is a
 * SUGGESTION BUILDER — it returns plain objects and calls no create-usecase.
 * A fully-answered dimension at or above the threshold yields nothing.
 */
export function buildGapSuggestions(
    assessment: SelfAssessment,
    score: SelfAssessmentScore,
    threshold: number = SOVEREIGNTY_GAP_THRESHOLD,
): GapSuggestion[] {
    const byId = new Map(assessment.dimensions.map((d) => [d.id, d]));
    const out: GapSuggestion[] = [];
    for (const d of score.dimensions) {
        if (d.mean == null || d.mean >= threshold) continue;
        const dim = byId.get(d.id);
        if (!dim) continue;
        out.push({
            dimensionId: d.id,
            labelKey: d.labelKey,
            riskTitle: dim.suggestion.riskTitle,
            controlName: dim.suggestion.controlName,
            clauseRef: dim.suggestion.clauseRef,
        });
    }
    return out;
}
