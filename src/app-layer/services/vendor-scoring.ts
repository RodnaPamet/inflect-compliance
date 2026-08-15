/**
 * Pure scoring functions for vendor assessments.
 * No DB dependency — purely functional.
 */

export interface ScoringQuestion {
    id: string;
    weight: number;
    riskPointsJson: unknown; // { "YES": 0, "NO": 10 } etc
}

export interface ScoringAnswer {
    questionId: string;
    answerJson: unknown;
}

/**
 * Compute raw risk points for a single answer given the question's riskPointsJson mapping.
 * Returns 0 if no mapping is found.
 */
/**
 * Normalise a submitted answer into the key a `riskPointsJson` map is
 * written with.
 *
 * EXPORTED because there were two implementations of this and they
 * disagreed. `computeProvisionalPoints` in vendor-assessment-response did a
 * raw `map[value]` lookup, so a form submitting `"yes"` missed a fixture
 * keyed `"YES"` and scored ZERO — on 9 of 11 scoring YES_NO questions per
 * shipped template. Its own docstring claimed it mirrored this function.
 *
 * The normalisation is the part worth sharing: uppercasing, the
 * boolean→YES/NO mapping, and unwrapping `{ value }`. Two copies of a rule
 * that must agree is the defect class; one copy with two callers is not.
 */
export function answerPointsKey(val: unknown): string | null {
    if (typeof val === 'boolean') return val ? 'YES' : 'NO';
    if (typeof val === 'string') return val.toUpperCase();
    if (typeof val === 'number') return String(val);
    if (val && typeof val === 'object' && 'value' in val) {
        return String((val as { value: unknown }).value).toUpperCase();
    }
    return null;
}

/**
 * Look a normalised answer up in a `riskPointsJson` map, CASE-INSENSITIVELY.
 *
 * Both conventions exist in the data. The shipped questionnaire fixtures key
 * on `YES`/`NO`; other maps — including ones this repo's own tests were
 * written against — key on `yes`/`no`. The two scoring paths each handled
 * exactly one of them:
 *
 *   review path   uppercased, so it scored 0 against a lowercase map
 *   submit path   raw lookup, so it scored 0 against an uppercase map
 *
 * Uppercasing everywhere would have fixed the shipped fixtures and broken the
 * lowercase maps — I know because doing exactly that turned an existing test
 * red, which is the only reason the second convention surfaced at all.
 *
 * So: try the normalised key, then the raw value, then a case-folded match.
 * Neither convention can score a silent zero again.
 */
function lookupPoints(mapping: Record<string, number>, raw: unknown): number | null {
    const key = answerPointsKey(raw);
    if (key === null) return null;

    if (typeof mapping[key] === 'number') return mapping[key];

    const rawKey = typeof raw === 'string' ? raw : null;
    if (rawKey !== null && typeof mapping[rawKey] === 'number') return mapping[rawKey];

    const folded = Object.keys(mapping).find((k) => k.toUpperCase() === key);
    return folded !== undefined ? mapping[folded] : null;
}

export function computeAnswerPoints(question: ScoringQuestion, answer: ScoringAnswer): number {
    if (!question.riskPointsJson) return 0;
    const mapping = question.riskPointsJson as Record<string, number>;
    return lookupPoints(mapping, answer.answerJson) ?? 0;
}

/** The submit path needs the same lookup; see `lookupPoints`. */
export function riskPointsFor(
    riskPointsJson: unknown,
    rawAnswerValue: unknown,
): number | null {
    if (!riskPointsJson || typeof riskPointsJson !== 'object') return null;
    return lookupPoints(riskPointsJson as Record<string, number>, rawAnswerValue);
}

/**
 * Compute weighted total score across all answered questions.
 * Returns { score, maxPossible, percentScore }.
 * Higher score = higher risk.
 */
export function computeAssessmentScore(
    questions: ScoringQuestion[],
    answers: ScoringAnswer[]
): { score: number; maxPossible: number; percentScore: number } {
    const answerMap = new Map(answers.map(a => [a.questionId, a]));

    let weightedSum = 0;
    let totalWeight = 0;

    for (const q of questions) {
        const answer = answerMap.get(q.id);
        if (!answer) continue;

        const points = computeAnswerPoints(q, answer);
        weightedSum += points * q.weight;
        totalWeight += q.weight;
    }

    const maxPossible = totalWeight > 0 ? totalWeight * 10 : 0; // Assuming max points per question is 10
    const percentScore = maxPossible > 0 ? Math.round((weightedSum / maxPossible) * 100) : 0;

    return { score: Math.round(weightedSum * 100) / 100, maxPossible, percentScore };
}

/**
 * Map a percent score to a risk rating.
 * 0-25 = LOW, 26-50 = MEDIUM, 51-75 = HIGH, 76-100 = CRITICAL
 */
export function scoreToRiskRating(percentScore: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    if (percentScore <= 25) return 'LOW';
    if (percentScore <= 50) return 'MEDIUM';
    if (percentScore <= 75) return 'HIGH';
    return 'CRITICAL';
}
