/**
 * Assessment staleness — has the agent moved since somebody assessed it?
 *
 * ## Detection is a COMPARISON, not a flag
 *
 * A completed `AgentRiskAssessment` freezes the six things the score was true
 * of (`basis*` on the row). Staleness is then this pure function run over the
 * frozen basis and the live agent. The alternative — an `isStale` boolean that
 * every write path remembers to set — fails silently the first time somebody
 * adds a seventh write path, and the failure looks exactly like "nothing
 * changed". A comparison cannot be forgotten by a write path that does not know
 * it exists.
 *
 * ## The triggers are ONE-DIRECTIONAL, and that is the whole design
 *
 * A trigger fires when a scorer input moves in the direction that RAISES risk:
 * autonomy raised, a tool granted, data scope widened, reversibility worsened.
 * Moving the other way — lowering autonomy, revoking a tool, narrowing scope —
 * does NOT mark the assessment stale, because the stored tier is then merely
 * too HIGH, and an over-restrictive cap is a safe error. Renaming the agent,
 * changing its owner or editing its description are not scorer inputs at all
 * and touch nothing here.
 *
 * `MODEL_CHANGED` is the one two-directional trigger. Every change of the
 * declared model invalidates every behavioural answer in the questionnaire
 * (adversarial evaluation, drift monitoring, output validation were all
 * evidenced against a model that is no longer running), and there is no
 * "safer" model to move to. NULL → NULL is not a change; NULL → a value IS one,
 * because declaring a model for the first time is new information about what
 * was assessed.
 *
 * `REVERSIBILITY_WORSENED` is a fifth trigger beyond the four the brief names,
 * and it is here for exactly the same reason as the other three axis triggers:
 * reversibility is a scorer INPUT with a floor attached to it, so an agent
 * moving REVERSIBLE → TERMINAL has just acquired a floor its score never saw.
 * Leaving it out would mean the one axis with the strongest floor was the one
 * axis you could change without re-assessing.
 *
 * ## Stale WARNS. It does not block. See the implementation note for the
 * argument; the short version is in three lines:
 *
 *   1. "Never scored" and "stale" are different states. Never-scored means
 *      nobody has ever looked, and `ceilingForRiskTier(null)` already DENIES
 *      that outright. Stale means somebody looked and something moved since —
 *      collapsing the two throws away the only assessment anybody did.
 *   2. Blocking would make the register's own maintenance the outage: granting
 *      a tool is the correct, audited act that fires a trigger, and an operator
 *      whose agent goes dark the instant they do the right thing stops doing
 *      the right thing.
 *   3. The widening is inert anyway. The tier still in force is the tier scored
 *      against the NARROWER basis, and the ceiling composes as a `min`, so the
 *      new authority does not take effect until somebody re-scores. Stale does
 *      not stop the agent; it stops the WIDENING, which is the part that was
 *      never assessed.
 */

/** Stable codes stored in `AgentRiskAssessment.staleTriggers`. */
export const STALENESS_TRIGGERS = [
    'AUTONOMY_RAISED',
    'TOOL_GRANTED',
    'DATA_SCOPE_WIDENED',
    'REVERSIBILITY_WORSENED',
    'MODEL_CHANGED',
] as const;

export type StalenessTrigger = (typeof STALENESS_TRIGGERS)[number];

import type { AgentDataAccessScope, AgentReversibility } from '@prisma/client';
import { dataAccessOrdinal } from './agent-risk-scoring';

/** Reversibility ordered BEST to WORST — worsening means moving right. */
const REVERSIBILITY_ORDER: readonly AgentReversibility[] = [
    'REVERSIBLE',
    'COMPENSABLE',
    'TERMINAL',
];

function reversibilityOrdinal(value: AgentReversibility): number {
    const i = REVERSIBILITY_ORDER.indexOf(value);
    // Unknown fails toward the WORST rung, so a new enum value cannot make an
    // agent look like it improved.
    return i === -1 ? REVERSIBILITY_ORDER.length - 1 : i;
}

/** The frozen state a completed assessment was scored against. */
export interface AssessmentBasis {
    autonomyLevel: number;
    dataAccessScope: AgentDataAccessScope;
    reversibility: AgentReversibility;
    toolCount: number;
    modelRef: string | null;
}

/** The agent as it is now. */
export type AgentCurrentState = AssessmentBasis;

export interface StalenessVerdict {
    stale: boolean;
    triggers: StalenessTrigger[];
    /** One line per trigger, naming the before and after. */
    detail: string[];
}

/**
 * Compare a completed assessment's basis against the live agent.
 *
 * Returns `{ stale: false, triggers: [] }` when nothing risk-raising moved —
 * including when scorer inputs moved in the SAFE direction, and including when
 * fields that are not scorer inputs changed. Callers must not treat an empty
 * verdict as "unchanged"; it means "not stale", which is the question asked.
 */
export function evaluateAssessmentStaleness(
    basis: AssessmentBasis,
    current: AgentCurrentState,
): StalenessVerdict {
    const triggers: StalenessTrigger[] = [];
    const detail: string[] = [];

    if (current.autonomyLevel > basis.autonomyLevel) {
        triggers.push('AUTONOMY_RAISED');
        detail.push(`autonomyLevel ${basis.autonomyLevel} → ${current.autonomyLevel}`);
    }

    if (current.toolCount > basis.toolCount) {
        triggers.push('TOOL_GRANTED');
        detail.push(`granted tools ${basis.toolCount} → ${current.toolCount}`);
    }

    if (dataAccessOrdinal(current.dataAccessScope) > dataAccessOrdinal(basis.dataAccessScope)) {
        triggers.push('DATA_SCOPE_WIDENED');
        detail.push(`dataAccessScope ${basis.dataAccessScope} → ${current.dataAccessScope}`);
    }

    if (reversibilityOrdinal(current.reversibility) > reversibilityOrdinal(basis.reversibility)) {
        triggers.push('REVERSIBILITY_WORSENED');
        detail.push(`reversibility ${basis.reversibility} → ${current.reversibility}`);
    }

    // Normalised so an empty string cannot read as a different model from NULL.
    const before = basis.modelRef ?? null;
    const after = current.modelRef ?? null;
    if (before !== after) {
        triggers.push('MODEL_CHANGED');
        detail.push(`modelRef ${before ?? '(none)'} → ${after ?? '(none)'}`);
    }

    return { stale: triggers.length > 0, triggers, detail };
}
