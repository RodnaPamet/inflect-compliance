/**
 * Step 6c: turning a model's probabilities into a REVIEW LANE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A VERDICT CHOOSES A LANE. IT NEVER CHANGES AN OUTCOME.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nothing here writes `LegacyAccountResolution.outcome` and nothing here writes
 * `LegacyIdentityAlias`. The engine's verdict stands; this annotates the row and
 * decides which queue the reviewer meets it in. `AGREES` buys a faster review,
 * never a link — because the engine and the model both lean on names, so their
 * agreement is not independence, and two correlated opinions are not evidence.
 *
 * This module imports NOTHING but types, which is how that guarantee is kept
 * checkable rather than asserted: it cannot reach a writer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIRST MATCHING ROW WINS, AND THE ORDER IS THE DESIGN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * From the design document's table, in order:
 *
 *   NOT_A_PERSON   P(person) <= nonPersonAt
 *   NO_MATCH       P(NONE)   >= agreeAt
 *   AGREES         top option IS the engine's suggestion, P >= agreeAt,
 *                  margin over runner-up >= agreeMargin, P(person) >= personAt
 *   PROPOSES       top option is ANOTHER candidate (or the engine had none),
 *                  clearing the same bars
 *   UNSURE         anything else
 *
 * `NOT_A_PERSON` is first for a reason worth stating: a service account that the
 * model is also confident maps to a named employee would otherwise be bulk
 * ratified as that person. Asking "is this even a person" before "whose is it"
 * is the only order in which that cannot happen.
 *
 * `UNSURE` is not a failure. It is the row exactly as it would be with
 * adjudication off, which is the fail-closed state and still a queue a person
 * can clear.
 *
 * @module lib/legacy-access/verdict
 */

import type { EvaluationThresholds } from '@/app-layer/ai/identity-match/evaluation-record';

/** The five lanes. Not a quality score — a destination. */
export type VerdictClass =
    | 'NOT_A_PERSON'
    | 'NO_MATCH'
    | 'AGREES'
    | 'PROPOSES'
    | 'UNSURE';

export const VERDICT_CLASSES: readonly VerdictClass[] = [
    'NOT_A_PERSON',
    'NO_MATCH',
    'AGREES',
    'PROPOSES',
    'UNSURE',
];

/**
 * Why no verdict was produced. Every one of these leaves the row exactly as the
 * mode `OFF` would.
 */
export type NonVerdictReason =
    | 'NO_PROVIDER'
    | 'NO_EVALUATION'
    | 'MODEL_DRIFT'
    | 'KILL_SWITCH'
    | 'BREAKER_OPEN'
    | 'QUARANTINED'
    | 'OVER_BUDGET'
    | 'TIMEOUT'
    | 'DEADLINE'
    | 'PROVIDER_ERROR';

export const NON_VERDICT_REASONS: readonly NonVerdictReason[] = [
    'NO_PROVIDER',
    'NO_EVALUATION',
    'MODEL_DRIFT',
    'KILL_SWITCH',
    'BREAKER_OPEN',
    'QUARANTINED',
    'OVER_BUDGET',
    'TIMEOUT',
    'DEADLINE',
    'PROVIDER_ERROR',
];

/**
 * The option the model is being asked about.
 *
 * `NONE` is a real option, not the absence of one — the model is asked "or
 * none of these", and its probability for that is what `NO_MATCH` reads. The
 * letters are the shuffled labels the server showed; the mapping back to
 * employees stays on the server, so nothing here sees an employee id.
 */
export interface OptionProbability {
    /** The letter as shown to the model. */
    readonly option: string;
    readonly probability: number;
}

export interface ModelAnswer {
    readonly options: readonly OptionProbability[];
    /** P(the subject is a person at all). */
    readonly personProbability: number;
}

export interface EngineContext {
    /**
     * The letter the ENGINE's suggestion was shown as, or null when the engine
     * had no candidate. Null is what separates `AGREES` from `PROPOSES`: with no
     * suggestion to agree WITH, a confident model is proposing.
     */
    readonly suggestedOption: string | null;
}

export interface DerivedVerdict {
    readonly verdict: VerdictClass;
    /** The letter the model ranked first, or null when it offered nothing. */
    readonly topOption: string | null;
    readonly topProbability: number;
    /** The gap to the runner-up; `Infinity` when there is no runner-up. */
    readonly margin: number;
}

/** The literal `NONE` option label. */
export const NONE_OPTION = 'NONE';

/**
 * Derive the lane.
 *
 * Pure, and takes the thresholds rather than reading them: they come from the
 * evaluation record for the exact revision the endpoint reported, and a function
 * that fetched its own could be called with none.
 */
export function deriveVerdict(
    answer: ModelAnswer,
    engine: EngineContext,
    thresholds: EvaluationThresholds
): DerivedVerdict {
    const ranked = [...answer.options].sort(
        (a, b) => b.probability - a.probability || a.option.localeCompare(b.option)
    );
    const top = ranked[0] ?? null;
    const runnerUp = ranked[1] ?? null;
    const topProbability = top?.probability ?? 0;
    // `Infinity` for a sole option: it is unopposed rather than "ahead by its
    // own score", and the two are not the same claim — the same reasoning as
    // `candidateMargin` in the reviewer actions.
    const margin = top === null
        ? 0
        : runnerUp === null
            ? Number.POSITIVE_INFINITY
            : top.probability - runnerUp.probability;

    const base = { topOption: top?.option ?? null, topProbability, margin };

    // 1. Is this even a person? FIRST, so a service account the model also maps
    //    confidently to an employee cannot be bulk ratified as that employee.
    if (answer.personProbability <= thresholds.nonPersonAt) {
        return { verdict: 'NOT_A_PERSON', ...base };
    }

    // 2. Does the model say none of them? Read off the NONE option's own
    //    probability, not inferred from the others being low — "no candidate is
    //    likely" and "the answer is nobody" are different statements, and only
    //    the second is evidence.
    const none = ranked.find((o) => o.option === NONE_OPTION);
    if (none && none.probability >= thresholds.agreeAt) {
        return { verdict: 'NO_MATCH', ...base };
    }

    // 3 and 4 share their bars; only the IDENTITY of the top option differs.
    const clearsBars =
        top !== null
        && top.option !== NONE_OPTION
        && top.probability >= thresholds.agreeAt
        && margin >= thresholds.agreeMargin
        && answer.personProbability >= thresholds.personAt;

    if (clearsBars) {
        return {
            verdict: engine.suggestedOption !== null && top.option === engine.suggestedOption
                ? 'AGREES'
                : 'PROPOSES',
            ...base,
        };
    }

    // 5. Anything else. The row as it would be with the mode OFF.
    return { verdict: 'UNSURE', ...base };
}

/**
 * May this row join the bulk ratification lane?
 *
 * `AGREES` alone is not enough. The design document's extra bars are about the
 * CANDIDATE rather than the model: an inactive employee, a veto, privileged
 * access or a re-key each mean a human should look, however confident anybody
 * is. Separate from {@link deriveVerdict} because they are facts the engine and
 * the roster hold, not probabilities.
 */
export function eligibleForBulkRatification(input: {
    readonly verdict: VerdictClass;
    readonly candidateIsActive: boolean;
    readonly hasVeto: boolean;
    readonly isPrivileged: boolean;
    readonly isRekeyed: boolean;
    /** Withheld as part of the blind sample. */
    readonly blindHeld: boolean;
}): boolean {
    if (input.verdict !== 'AGREES') return false;
    if (input.blindHeld) return false;
    return input.candidateIsActive && !input.hasVeto && !input.isPrivileged && !input.isRekeyed;
}
