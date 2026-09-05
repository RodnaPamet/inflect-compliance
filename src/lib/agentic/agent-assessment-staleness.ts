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
 * was assessed. `''` is normalised to NULL on both sides, so an empty string
 * saved over an empty column is not a change either.
 *
 * `REVERSIBILITY_WORSENED` and `PROVENANCE_WIDENED` are the fourth and fifth
 * AXIS triggers, beyond the ones the brief names, and both are here for one
 * reason: **the basis carries exactly the scorer's agent-side inputs.**
 * `scoreAgentRisk` reads autonomy, data access, reversibility and provenance;
 * an axis the scorer reads but the basis does not is an axis you can worsen
 * without anybody noticing. Reversibility carries the strongest floor in the
 * table; provenance is worth two points and moves a run across a band boundary
 * on its own. `tests/unit/agent-assessment-staleness.test.ts` pins the basis
 * key set against the scorer's input type, so widening one without the other is
 * a failing test rather than a silent gap.
 *
 * ## Stale WARNS. It does not block — and what it MEANS is narrow
 *
 * Stale means **"the questionnaire answers may be out of date"**. It does NOT
 * mean "the tier is wrong", because the tier is not left behind: every widening
 * of an axis the scorer reads is RE-SCORED in the same transaction that records
 * it, from the answers already on file, and the recomputed tier is written to
 * the agent whenever it is worse (`reassessAgentAfterChangeInTx` in
 * `usecases/agent-risk-assessment.ts`). So the ceiling narrows at once and the
 * warning is about the thing that genuinely cannot be recomputed — whether the
 * twenty answers still hold.
 *
 * That is the whole argument for warning rather than blocking, and it is worth
 * stating why the OLD argument was wrong, because it was written down and
 * believed: it claimed the widening was "inert until somebody re-scores",
 * since the tier in force had been scored against the narrower basis and the
 * ceiling composes as a `min`. That is true only of AUTONOMY_RAISED, where
 * `agent.autonomyLevel` is itself a term in the `min`. It was false for data
 * scope, reversibility and provenance, none of which appear in the ceiling at
 * all: an agent could move READ_TENANT_DATA → EXTERNAL_EGRESS and keep the
 * LOW tier and the full ceiling that a fresh score of the same agent would have
 * refused. Re-scoring on the spot is what makes the claim true rather than
 * hopeful.
 *
 * The two reasons that survive:
 *
 *   1. "Never scored" and "stale" are different states. Never-scored means
 *      nobody has ever looked, and `ceilingForRiskTier(null)` already DENIES
 *      that outright. Stale means somebody looked and something moved since —
 *      collapsing the two throws away the only assessment anybody did.
 *   2. Blocking would make the register's own maintenance the outage: granting
 *      a tool is the correct, audited act that fires a trigger, and an operator
 *      whose agent goes dark the instant they do the right thing stops doing
 *      the right thing.
 *
 * `TOOL_GRANTED` is the one trigger the re-score cannot answer, because the
 * granted-tool count is NOT a scorer input — see `grantAgentTool`, which
 * instead refuses outright any grant of a tool whose autonomy rung is above the
 * agent's tier cap.
 */

/** Stable codes stored in `AgentRiskAssessment.staleTriggers`. */
export const STALENESS_TRIGGERS = [
    'AUTONOMY_RAISED',
    'TOOL_GRANTED',
    'DATA_SCOPE_WIDENED',
    'REVERSIBILITY_WORSENED',
    'PROVENANCE_WIDENED',
    'MODEL_CHANGED',
] as const;

export type StalenessTrigger = (typeof STALENESS_TRIGGERS)[number];

import type {
    AgentDataAccessScope,
    AgentProvenance,
    AgentReversibility,
} from '@prisma/client';
import { dataAccessOrdinal } from './agent-risk-scoring';

/** Reversibility ordered BEST to WORST — worsening means moving right. */
const REVERSIBILITY_ORDER: readonly AgentReversibility[] = [
    'REVERSIBLE',
    'COMPENSABLE',
    'TERMINAL',
];

/** `''` and whitespace are "no model declared", the same state as NULL. */
function normalizeModel(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function reversibilityOrdinal(value: AgentReversibility): number {
    const i = REVERSIBILITY_ORDER.indexOf(value);
    // Unknown fails toward the WORST rung, so a new enum value cannot make an
    // agent look like it improved.
    return i === -1 ? REVERSIBILITY_ORDER.length - 1 : i;
}

/**
 * The frozen state a completed assessment was scored against.
 *
 * The first four fields are EXACTLY `AgentRiskScoreInput` minus `questions` —
 * the scorer's agent-side inputs — and that identity is the invariant, not a
 * coincidence. `toolCount` and `modelRef` are the two non-scorer facts a change
 * to which invalidates the ANSWERS rather than the arithmetic.
 */
export interface AssessmentBasis {
    autonomyLevel: number;
    dataAccessScope: AgentDataAccessScope;
    reversibility: AgentReversibility;
    provenance: AgentProvenance;
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

    // FIRST_PARTY → THIRD_PARTY only. The other direction is an agent that
    // stopped depending on a supplier, which lowers the score and is safe.
    if (basis.provenance !== 'THIRD_PARTY' && current.provenance === 'THIRD_PARTY') {
        triggers.push('PROVENANCE_WIDENED');
        detail.push(`provenance ${basis.provenance} → ${current.provenance}`);
    }

    // Normalised so an empty string cannot read as a different model from NULL.
    // Written as a trim-then-falsy fold rather than `?? null`, which normalises
    // only `undefined` and would have reported `'' → NULL` as a model change.
    const before = normalizeModel(basis.modelRef);
    const after = normalizeModel(current.modelRef);
    if (before !== after) {
        triggers.push('MODEL_CHANGED');
        detail.push(`modelRef ${before ?? '(none)'} → ${after ?? '(none)'}`);
    }

    return { stale: triggers.length > 0, triggers, detail };
}
