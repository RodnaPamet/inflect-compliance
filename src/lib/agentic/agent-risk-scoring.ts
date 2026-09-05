/**
 * The agent risk scorer — autonomy × data access × reversibility (× provenance)
 * plus the assessment answers, resolved to an `AgentRiskTier`.
 *
 * ## Why a score AND floors, rather than one or the other
 *
 * A purely additive score lets a good answer on one axis buy down a bad one:
 * an agent that sends irreversible external notifications can talk its way to
 * LOW by being narrow everywhere else, and nothing in the arithmetic objects.
 * A purely tabular matrix has the opposite problem — 7 × 5 × 3 × 2 is 210 cells
 * nobody can review, and the questionnaire then changes nothing at all, which
 * is the "assessment as paperwork" failure this whole subsystem exists to
 * avoid.
 *
 * So the tier is
 *
 *     max( band(additive score) , the highest floor any SINGLE axis imposes )
 *
 * The additive part is where the questionnaire does its work — answering the
 * twenty questions honestly moves an agent by up to twelve points, which is
 * more than a full band. The floors are where governance does its: they encode
 * "no amount of good answers elsewhere talks you below what THIS axis alone
 * justifies", and they are the reason `TERMINAL` can never come out LOW.
 *
 * ## The floors, and why each one
 *
 *   • TERMINAL reversibility floors at MODERATE. An action the platform cannot
 *     undo is a risk that no control removes — controls change how OFTEN it
 *     happens, never whether it can be taken back. This is the property pinned
 *     by name in the tests.
 *   • EXTERNAL_EGRESS floors at HIGH. It is the only data-access rung whose
 *     blast radius is not bounded by the tenant's own database (the enum says
 *     so itself), so it is the only one where a breach is not recoverable by
 *     acting on our own storage.
 *   • WRITE_TENANT_DATA floors at MODERATE, for the weaker version of the same
 *     argument: the damage is inside our boundary, but it is damage.
 *   • Autonomy at or above `UNATTENDED_AUTONOMY` (5) floors at MODERATE. The
 *     questions ask whether controls exist; the whole meaning of unattended
 *     operation is that no human is watching those controls work. An agent at
 *     the top of the ladder scoring LOW would be the instrument contradicting
 *     itself.
 *
 * ## Unanswered counts as NO
 *
 * An absent mitigation and an unclaimed mitigation are the same thing to an
 * attacker. Counting a blank as YES would mean a brand-new empty assessment
 * scores its agent LOW — the least-assessed agent getting the friendliest
 * treatment, which is the exact inversion `RegisteredAgent.riskTier = NULL`
 * already exists to prevent one level up. So the tier only comes DOWN as the
 * assessment is filled in, which is the honest direction.
 *
 * `NA` is different and leaves the denominator: it means the question does not
 * apply (a first-party agent has no supplier to assess). N/A-ing everything
 * therefore removes at most the twelve answer points — it cannot get an agent
 * below the floors, and the axes alone still put an unattended, egressing,
 * irreversible agent at CRITICAL.
 *
 * Pure and dependency-free on purpose: it is unit-tested as a table over the
 * matrix, and the tier it returns is written to a column that caps authority.
 */
import type {
    AgentDataAccessScope,
    AgentProvenance,
    AgentReversibility,
    AgentRiskTier,
} from '@prisma/client';

/**
 * The data-access ladder, LEAST- to MOST-exposing. This is the ORDINAL the
 * scorer reads, and it must stay in step with `enum AgentDataAccessScope` in
 * `enums.prisma`, whose own docstring says the ordering is load-bearing and
 * append-only. Spelled out here rather than derived from `Object.values` of the
 * generated enum: Prisma's declaration order is not a contract the compiler
 * enforces, and silently rescoring every registered agent because somebody
 * tidied the schema is not a failure anybody would notice.
 */
export const DATA_ACCESS_ORDER: readonly AgentDataAccessScope[] = [
    'NONE',
    'READ_METADATA',
    'READ_TENANT_DATA',
    'WRITE_TENANT_DATA',
    'EXTERNAL_EGRESS',
];

/** Tier order, lowest to highest. `max` over tiers means "furthest right". */
export const RISK_TIER_ORDER: readonly AgentRiskTier[] = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'];

/** The rung at which an agent is operating without a human in the loop. */
export const UNATTENDED_AUTONOMY = 5;

/** Per-axis weights. Each axis's maximum contribution is stated beside it. */
const AUTONOMY_WEIGHT = 1; //            0-6  → max 6
const DATA_ACCESS_WEIGHT = 2; //         0-4  → max 8
const REVERSIBILITY_WEIGHT = 3; //       0-2  → max 6
const THIRD_PARTY_POINTS = 2; //         0/1  → max 2
/** The answers' whole contribution, so the questionnaire is bounded. */
export const MAX_ANSWER_POINTS = 12; //          → max 12
/** Therefore 6 + 8 + 6 + 2 + 12. */
export const MAX_SCORE = 34;

const REVERSIBILITY_POINTS: Readonly<Record<AgentReversibility, number>> = {
    REVERSIBLE: 0,
    COMPENSABLE: 1,
    TERMINAL: 2,
};

/**
 * Band boundaries, as the INCLUSIVE upper bound of each tier below CRITICAL.
 * Chosen so that the worst case on every axis reaches CRITICAL even when the
 * agent is fully REVERSIBLE — being able to undo an action does not rescue an
 * unattended agent that egresses tenant data with no mitigations at all.
 */
const BAND_UPPER: ReadonlyArray<{ tier: AgentRiskTier; upTo: number }> = [
    { tier: 'LOW', upTo: 8 },
    { tier: 'MODERATE', upTo: 16 },
    { tier: 'HIGH', upTo: 24 },
];

/** Per-axis floors — the minimum tier that axis justifies on its own. */
const REVERSIBILITY_FLOOR: Readonly<Record<AgentReversibility, AgentRiskTier>> = {
    REVERSIBLE: 'LOW',
    COMPENSABLE: 'LOW',
    TERMINAL: 'MODERATE',
};

const DATA_ACCESS_FLOOR: Readonly<Record<AgentDataAccessScope, AgentRiskTier>> = {
    NONE: 'LOW',
    READ_METADATA: 'LOW',
    READ_TENANT_DATA: 'LOW',
    WRITE_TENANT_DATA: 'MODERATE',
    EXTERNAL_EGRESS: 'HIGH',
};

/** Answer weight by question criticality. */
const CRITICALITY_WEIGHT: Readonly<Record<string, number>> = {
    CRITICAL: 3,
    HIGH: 2,
    MEDIUM: 1,
};

/**
 * How much of a question's risk an answer leaves UNMITIGATED.
 * `undefined` (never answered) is deliberately absent from this table and
 * resolves to 1 — see the header.
 */
const ANSWER_GAP: Readonly<Record<string, number>> = {
    YES: 0,
    PARTIALLY: 0.5,
    NO: 1,
};

export const AGENT_ANSWER_VALUES = ['NA', 'NO', 'PARTIALLY', 'YES'] as const;
export type AgentAnswerValue = (typeof AGENT_ANSWER_VALUES)[number];

export interface ScorableQuestion {
    id: string;
    /** CRITICAL | HIGH | MEDIUM — anything else weighs as MEDIUM. */
    criticality: string;
    /** The tenant's answer, or null/undefined if the question is unanswered. */
    answer: AgentAnswerValue | null | undefined;
}

export interface AgentRiskScoreInput {
    autonomyLevel: number;
    dataAccessScope: AgentDataAccessScope;
    reversibility: AgentReversibility;
    provenance: AgentProvenance;
    questions: readonly ScorableQuestion[];
}

export interface AgentRiskScoreBreakdown {
    autonomy: number;
    dataAccess: number;
    reversibility: number;
    provenance: number;
    answers: number;
    /** Weighted share of applicable questions left unmitigated, 0-1. */
    unmitigatedFraction: number;
    /** Questions that counted (NA and unknown-id questions do not). */
    applicableQuestions: number;
    /** Applicable questions with no answer at all — each counted as NO. */
    unansweredQuestions: number;
}

export interface AgentRiskScore {
    tier: AgentRiskTier;
    score: number;
    /** The tier the additive score alone would have produced. */
    band: AgentRiskTier;
    /** The floors that fired, if any — why the tier is above the band. */
    floors: readonly string[];
    breakdown: AgentRiskScoreBreakdown;
}

/** Position on the data-access ladder. An unknown value scores as the WORST. */
export function dataAccessOrdinal(scope: AgentDataAccessScope): number {
    const i = DATA_ACCESS_ORDER.indexOf(scope);
    // Fail toward MORE risk: a rung added to the enum but not to this list must
    // not score zero just because nobody updated the array.
    return i === -1 ? DATA_ACCESS_ORDER.length - 1 : i;
}

function tierIndex(tier: AgentRiskTier): number {
    const i = RISK_TIER_ORDER.indexOf(tier);
    return i === -1 ? RISK_TIER_ORDER.length - 1 : i;
}

/** The higher (riskier) of two tiers. */
export function maxTier(a: AgentRiskTier, b: AgentRiskTier): AgentRiskTier {
    return tierIndex(a) >= tierIndex(b) ? a : b;
}

/**
 * Is `candidate` strictly RISKIER than `current`?
 *
 * Exported because the re-score on a widening writes back only when the answer
 * is yes — a re-score must never LOWER a standing tier, since the questionnaire
 * behind that tier has not been re-answered and an over-restrictive cap is the
 * safe error. An unrecognised tier ranks worst on both sides, so a value this
 * build does not know cannot be mistaken for an improvement.
 */
export function isTierAbove(candidate: AgentRiskTier, current: AgentRiskTier): boolean {
    return tierIndex(candidate) > tierIndex(current);
}

function bandFor(score: number): AgentRiskTier {
    for (const b of BAND_UPPER) if (score <= b.upTo) return b.tier;
    return 'CRITICAL';
}

/**
 * The weighted share of applicable questions left unmitigated.
 * Returns 1 (fully unmitigated) when NOTHING is applicable — an assessment that
 * answered NA to everything has demonstrated nothing, and the fail-closed
 * reading of "no evidence" is "no mitigation".
 */
function unmitigatedFraction(questions: readonly ScorableQuestion[]): {
    fraction: number;
    applicable: number;
    unanswered: number;
} {
    let totalWeight = 0;
    let gapWeight = 0;
    let applicable = 0;
    let unanswered = 0;

    for (const q of questions) {
        if (q.answer === 'NA') continue;
        const weight = CRITICALITY_WEIGHT[q.criticality] ?? CRITICALITY_WEIGHT.MEDIUM;
        totalWeight += weight;
        applicable += 1;
        if (q.answer === null || q.answer === undefined) {
            unanswered += 1;
            gapWeight += weight;
            continue;
        }
        gapWeight += weight * (ANSWER_GAP[q.answer] ?? 1);
    }

    if (totalWeight === 0) return { fraction: 1, applicable, unanswered };
    return { fraction: gapWeight / totalWeight, applicable, unanswered };
}

/**
 * Score one agent. Pure — same inputs, same tier, forever.
 */
export function scoreAgentRisk(input: AgentRiskScoreInput): AgentRiskScore {
    const autonomy = Math.max(0, input.autonomyLevel) * AUTONOMY_WEIGHT;
    const dataAccess = dataAccessOrdinal(input.dataAccessScope) * DATA_ACCESS_WEIGHT;
    const reversibility =
        (REVERSIBILITY_POINTS[input.reversibility] ?? REVERSIBILITY_POINTS.TERMINAL) *
        REVERSIBILITY_WEIGHT;
    const provenance = input.provenance === 'THIRD_PARTY' ? THIRD_PARTY_POINTS : 0;

    const { fraction, applicable, unanswered } = unmitigatedFraction(input.questions);
    const answers = Math.round(MAX_ANSWER_POINTS * fraction);

    const score = autonomy + dataAccess + reversibility + provenance + answers;
    const band = bandFor(score);

    // Every floor is compared against the BAND, not against the running tier,
    // so two axes that both floor to MODERATE are both named. Reporting only
    // the first would say the band was raised for one reason when it was raised
    // for two, and the second reason is the one an operator has to fix as well.
    const candidates: Array<{ floor: AgentRiskTier; why: string }> = [
        {
            floor: REVERSIBILITY_FLOOR[input.reversibility] ?? 'MODERATE',
            why: `reversibility=${input.reversibility}`,
        },
        {
            floor: DATA_ACCESS_FLOOR[input.dataAccessScope] ?? 'HIGH',
            why: `dataAccessScope=${input.dataAccessScope}`,
        },
        ...(input.autonomyLevel >= UNATTENDED_AUTONOMY
            ? [
                  {
                      floor: 'MODERATE' as AgentRiskTier,
                      why: `autonomyLevel=${input.autonomyLevel} is unattended`,
                  },
              ]
            : []),
    ];

    const floors: string[] = [];
    let tier = band;
    for (const c of candidates) {
        if (tierIndex(c.floor) > tierIndex(band)) {
            floors.push(`${c.why} floors at ${c.floor}`);
        }
        tier = maxTier(tier, c.floor);
    }

    return {
        tier,
        score,
        band,
        floors,
        breakdown: {
            autonomy,
            dataAccess,
            reversibility,
            provenance,
            answers,
            unmitigatedFraction: fraction,
            applicableQuestions: applicable,
            unansweredQuestions: unanswered,
        },
    };
}

/**
 * ── THE AUTONOMY CAP THE TIER BUYS ─────────────────────────────────────
 *
 * The table that makes the assessment load-bearing rather than decorative: a
 * scored tier caps how far up the 0-6 ladder an agent may actually be driven,
 * regardless of the autonomy its registration claims.
 *
 * The table lives HERE, with the scorer, because it is the assessment's
 * MEANING — "what does coming out HIGH actually cost you" — and a tier whose
 * consequence is defined in another module is a tier whose consequence can be
 * changed without anyone re-reading why it was set. `autonomy-ceiling.ts` owns
 * the COMPOSITION (`min` over independent narrowing terms); this owns the
 * number each tier contributes.
 *
 * ## A TIER MAY NEVER BUY A RUNG IT COULD NOT ITSELF BE SCORED AT
 *
 * This table and the floors above it are two halves of one statement, and they
 * have to agree. `UNATTENDED_AUTONOMY` (5) floors at MODERATE, so no
 * combination of the other axes and no set of answers produces LOW above rung
 * 4 — swept exhaustively in `tests/unit/agent-risk-scoring.test.ts`. LOW's cap
 * was nevertheless 6, which meant the tier granted two rungs its own scoring
 * refuses: `assertRaiseWithinTier` would accept a raise from 4 to 6 into a
 * state no fresh assessment could hold as LOW. That was latent rather than
 * exploited only because no MCP tool today declares a rung above PROPOSE (2) —
 * and `src/lib/mcp/tools/types.ts` carries an `autonomy` field precisely so one
 * can.
 *
 * So each cap below is the HIGHEST rung at which that tier is reachable, or
 * lower. The property is pinned as a property, over the whole axis grid, rather
 * than as four literals somebody has to keep in step by hand.
 *
 * The numbers, and the reasoning behind each:
 *   LOW      → 4. The top of the attended ladder — the highest rung at which
 *                 LOW can be scored at all, because rung 5 is where the agent
 *                 stops being watched and the unattended floor takes over. This
 *                 is not "no narrowing": rungs 5 and 6 are reachable by no tier,
 *                 which is the floor table meaning what it says.
 *   MODERATE → 3. Up to ORCHESTRATE: it may chain steps between checkpoints,
 *                 but it is not driven unattended across systems.
 *   HIGH     → 2. Up to PROPOSE: it may put drafts in front of a human, and a
 *                 human decides. This is the rung where the tier starts to
 *                 disagree with the registration, which is the point.
 *   CRITICAL → 1. READ only. A critical-tier agent may look; anything it wants
 *                 done, a person does.
 *
 * Note what is NOT here: an entry for the unscored (NULL) case. That belongs to
 * `ceilingForRiskTier` in `autonomy-ceiling.ts`, which resolves NULL to
 * `DENY_CEILING`, and it is deliberately not expressible in this table — an
 * "unscored" key here would be a tier, and unscored is the absence of one.
 */
export const MAX_AUTONOMY_BY_TIER: Readonly<Record<AgentRiskTier, number>> = {
    LOW: 4,
    MODERATE: 3,
    HIGH: 2,
    CRITICAL: 1,
};

/**
 * How many tool calls a tier's agent may make, per run and per UTC day.
 *
 * Here rather than with the policy card, for the same reason `MAX_AUTONOMY_BY_TIER`
 * is here: these numbers are what coming out CRITICAL actually COSTS, and a
 * consequence that lives in the module that spends it is one that can be changed
 * without anyone re-reading why it was set. `policy-card.ts` owns the ladder the
 * values must sit on; this owns which rung each tier gets.
 *
 * Every value is a rung of `ACTION_CAP_LADDER` — a card cannot hold a number
 * that is not, and a default that could not be saved by hand would be a default
 * that only the seeder can produce.
 *
 * The numbers, and the reasoning:
 *   LOW      → 50 / 500.  The engine's own per-run step cap is 50, so at LOW the
 *                         card stops being the binding term on a run and the
 *                         engine's cap is. That is the correct place for a
 *                         well-assessed agent to sit: bounded by the platform,
 *                         not by its own file.
 *   MODERATE → 25 / 250.  Half. It chains steps between checkpoints, so a run is
 *                         where its cost accumulates.
 *   HIGH     → 10 / 100.  It can only put drafts in front of a person, and a
 *                         hundred drafts a day is already more than a person
 *                         reads.
 *   CRITICAL →  5 /  25.  Read-only, and deliberately too small to enumerate the
 *                         tenant with. A critical-tier agent that needs to walk
 *                         every control is an agent whose tier is the finding.
 *
 * As with the autonomy table there is NO unscored key: unscored is the absence
 * of a tier, and `defaultPolicyCardForRiskTier` resolves it to a zero budget.
 */
export const MAX_ACTIONS_PER_RUN_BY_TIER: Readonly<Record<AgentRiskTier, number>> = {
    LOW: 50,
    MODERATE: 25,
    HIGH: 10,
    CRITICAL: 5,
};

export const MAX_ACTIONS_PER_DAY_BY_TIER: Readonly<Record<AgentRiskTier, number>> = {
    LOW: 500,
    MODERATE: 250,
    HIGH: 100,
    CRITICAL: 25,
};
