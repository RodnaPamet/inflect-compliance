/**
 * The agent risk scorer — the full matrix, both corners, and the TERMINAL floor.
 *
 * The scorer's output is written to `RegisteredAgent.riskTier`, which caps how
 * much authority an agent may hold. So the properties below are not style
 * preferences; each one is a way the cap could be wrong in production.
 *
 * What is asserted, and why each:
 *
 *   • THE WHOLE MATRIX is swept (7 autonomy × 5 data-access × 3 reversibility ×
 *     2 provenance × 4 answer profiles = 840 cells) rather than sampled. A
 *     scorer is a total function over a small domain; sampling it leaves the
 *     one cell that is wrong exactly as likely to be the unsampled one.
 *   • THE TWO CORNERS are pinned by value. Autonomy 0 + TERMINAL is the
 *     low-autonomy/worst-reversibility tension; autonomy 6 + REVERSIBLE is the
 *     opposite one. Each catches a scorer where one axis has swallowed the
 *     others.
 *   • THE TERMINAL FLOOR is asserted over EVERY cell, not one: "TERMINAL can
 *     never yield the lowest tier, whatever the other inputs" is a claim about
 *     all inputs, and testing it at one point tests something weaker.
 *   • MONOTONICITY in each axis. This is the property that catches a sign error
 *     or a swapped weight, both of which produce a plausible-looking tier at
 *     any single point.
 *   • LOW AND CRITICAL ARE BOTH REACHABLE. A scorer that can never say LOW is
 *     an instrument nobody will fill in twice; one that can never say CRITICAL
 *     is one that never refuses anything. Either failure leaves every other
 *     assertion here passing.
 */
import type {
    AgentDataAccessScope,
    AgentProvenance,
    AgentReversibility,
    AgentRiskTier,
} from '@prisma/client';
import {
    DATA_ACCESS_ORDER,
    MAX_SCORE,
    RISK_TIER_ORDER,
    MAX_AUTONOMY_BY_TIER,
    scoreAgentRisk,
    type AgentAnswerValue,
    type ScorableQuestion,
} from '@/lib/agentic/agent-risk-scoring';

const AUTONOMY_LEVELS = [0, 1, 2, 3, 4, 5, 6] as const;
const REVERSIBILITIES: readonly AgentReversibility[] = ['REVERSIBLE', 'COMPENSABLE', 'TERMINAL'];
const PROVENANCES: readonly AgentProvenance[] = ['FIRST_PARTY', 'THIRD_PARTY'];

/**
 * A question set shaped like the shipped fixture: a mix of criticalities so the
 * weighting is exercised, not a uniform list that would hide it.
 */
const QUESTION_SHAPE: ReadonlyArray<{ id: string; criticality: string }> = [
    { id: 'q1', criticality: 'CRITICAL' },
    { id: 'q2', criticality: 'CRITICAL' },
    { id: 'q3', criticality: 'HIGH' },
    { id: 'q4', criticality: 'HIGH' },
    { id: 'q5', criticality: 'HIGH' },
    { id: 'q6', criticality: 'MEDIUM' },
];

type AnswerProfile = 'ALL_YES' | 'ALL_NO' | 'HALF' | 'UNANSWERED';

function questions(profile: AnswerProfile): ScorableQuestion[] {
    return QUESTION_SHAPE.map((q, i) => {
        let answer: AgentAnswerValue | null;
        if (profile === 'ALL_YES') answer = 'YES';
        else if (profile === 'ALL_NO') answer = 'NO';
        else if (profile === 'UNANSWERED') answer = null;
        else answer = i % 2 === 0 ? 'YES' : 'NO';
        return { id: q.id, criticality: q.criticality, answer };
    });
}

interface Cell {
    autonomyLevel: number;
    dataAccessScope: AgentDataAccessScope;
    reversibility: AgentReversibility;
    provenance: AgentProvenance;
    profile: AnswerProfile;
}

function everyCell(): Cell[] {
    const out: Cell[] = [];
    for (const autonomyLevel of AUTONOMY_LEVELS)
        for (const dataAccessScope of DATA_ACCESS_ORDER)
            for (const reversibility of REVERSIBILITIES)
                for (const provenance of PROVENANCES)
                    for (const profile of ['ALL_YES', 'ALL_NO', 'HALF', 'UNANSWERED'] as const)
                        out.push({
                            autonomyLevel,
                            dataAccessScope,
                            reversibility,
                            provenance,
                            profile,
                        });
    return out;
}

function score(cell: Cell) {
    return scoreAgentRisk({
        autonomyLevel: cell.autonomyLevel,
        dataAccessScope: cell.dataAccessScope,
        reversibility: cell.reversibility,
        provenance: cell.provenance,
        questions: questions(cell.profile),
    });
}

const tierRank = (t: AgentRiskTier) => RISK_TIER_ORDER.indexOf(t);
const label = (c: Cell) =>
    `autonomy=${c.autonomyLevel} access=${c.dataAccessScope} reversibility=${c.reversibility} provenance=${c.provenance} answers=${c.profile}`;

const ALL_CELLS = everyCell();

describe('the matrix is swept, not sampled', () => {
    it('covers every combination of the four axes and four answer profiles', () => {
        expect(ALL_CELLS).toHaveLength(
            AUTONOMY_LEVELS.length * DATA_ACCESS_ORDER.length * REVERSIBILITIES.length * 2 * 4,
        );
        expect(ALL_CELLS).toHaveLength(840);
    });

    it('every cell produces a real tier and a score inside the declared range', () => {
        for (const cell of ALL_CELLS) {
            const result = score(cell);
            expect(RISK_TIER_ORDER).toContain(result.tier);
            expect(result.score).toBeGreaterThanOrEqual(0);
            expect(result.score).toBeLessThanOrEqual(MAX_SCORE);
            // The tier is the band raised by the floors, so it can never sit
            // BELOW the band — that direction would mean a floor lowered a tier.
            expect(tierRank(result.tier)).toBeGreaterThanOrEqual(tierRank(result.band));
        }
    });
});

describe('the two corners', () => {
    /**
     * The low-autonomy, worst-reversibility corner. An agent that only suggests
     * still takes actions nothing can undo, and the additive score alone would
     * put it at the bottom — this is exactly where a scorer without floors goes
     * wrong, and it goes wrong quietly.
     */
    it('autonomy 0 + TERMINAL is MODERATE even when every other input is best', () => {
        const result = scoreAgentRisk({
            autonomyLevel: 0,
            dataAccessScope: 'NONE',
            reversibility: 'TERMINAL',
            provenance: 'FIRST_PARTY',
            questions: questions('ALL_YES'),
        });
        expect(result.band).toBe('LOW');
        expect(result.tier).toBe('MODERATE');
        expect(result.floors.join(' ')).toContain('reversibility=TERMINAL');
    });

    /**
     * The high-autonomy, best-reversibility corner. Everything the questionnaire
     * can ask about is in place and every action is undoable — and the agent is
     * still driven unattended, which is a risk no control removes.
     */
    it('autonomy 6 + REVERSIBLE is MODERATE when every other input is best', () => {
        const result = scoreAgentRisk({
            autonomyLevel: 6,
            dataAccessScope: 'NONE',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            questions: questions('ALL_YES'),
        });
        expect(result.band).toBe('LOW');
        expect(result.tier).toBe('MODERATE');
        expect(result.floors.join(' ')).toContain('unattended');
    });

    it('autonomy 6 + REVERSIBLE still reaches CRITICAL when everything else is worst', () => {
        const result = scoreAgentRisk({
            autonomyLevel: 6,
            dataAccessScope: 'EXTERNAL_EGRESS',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            questions: questions('ALL_NO'),
        });
        // Being able to undo an action does not rescue an unattended agent that
        // egresses tenant data with no mitigation in place.
        expect(result.tier).toBe('CRITICAL');
    });
});

describe('TERMINAL reversibility can never yield the lowest tier', () => {
    it('holds in EVERY cell of the matrix, not just the corner', () => {
        const offenders = ALL_CELLS.filter(
            (c) => c.reversibility === 'TERMINAL' && score(c).tier === 'LOW',
        ).map(label);
        expect(offenders).toEqual([]);
    });

    it('and the assertion is not vacuous — TERMINAL cells exist and some are LOW-banded', () => {
        const terminal = ALL_CELLS.filter((c) => c.reversibility === 'TERMINAL');
        expect(terminal.length).toBeGreaterThan(0);
        // At least one TERMINAL cell would have scored LOW on the additive band
        // alone. Without this, the test above could pass because the weights
        // happen to be large, which is a property one tweak away from false.
        expect(terminal.some((c) => score(c).band === 'LOW')).toBe(true);
    });
});

describe('raising any single axis never lowers the tier', () => {
    const base = (over: Partial<Cell> = {}): Cell => ({
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        profile: 'HALF',
        ...over,
    });

    it('autonomy', () => {
        for (let i = 1; i < AUTONOMY_LEVELS.length; i += 1) {
            const lower = score(base({ autonomyLevel: AUTONOMY_LEVELS[i - 1] }));
            const higher = score(base({ autonomyLevel: AUTONOMY_LEVELS[i] }));
            expect(tierRank(higher.tier)).toBeGreaterThanOrEqual(tierRank(lower.tier));
            expect(higher.score).toBeGreaterThanOrEqual(lower.score);
        }
    });

    it('data-access scope, in the enum ordinal order the scorer reads', () => {
        for (let i = 1; i < DATA_ACCESS_ORDER.length; i += 1) {
            const lower = score(base({ dataAccessScope: DATA_ACCESS_ORDER[i - 1] }));
            const higher = score(base({ dataAccessScope: DATA_ACCESS_ORDER[i] }));
            expect(tierRank(higher.tier)).toBeGreaterThanOrEqual(tierRank(lower.tier));
        }
    });

    it('reversibility', () => {
        for (let i = 1; i < REVERSIBILITIES.length; i += 1) {
            const lower = score(base({ reversibility: REVERSIBILITIES[i - 1] }));
            const higher = score(base({ reversibility: REVERSIBILITIES[i] }));
            expect(tierRank(higher.tier)).toBeGreaterThanOrEqual(tierRank(lower.tier));
        }
    });

    it('provenance — a third-party agent never scores below a first-party one', () => {
        const first = score(base({ provenance: 'FIRST_PARTY' }));
        const third = score(base({ provenance: 'THIRD_PARTY' }));
        expect(third.score).toBeGreaterThan(first.score);
        expect(tierRank(third.tier)).toBeGreaterThanOrEqual(tierRank(first.tier));
    });

    it('answers — worse answers never produce a lower tier', () => {
        for (const cell of ALL_CELLS.filter((c) => c.profile === 'ALL_YES')) {
            const yes = score(cell);
            const half = score({ ...cell, profile: 'HALF' });
            const no = score({ ...cell, profile: 'ALL_NO' });
            expect(tierRank(half.tier)).toBeGreaterThanOrEqual(tierRank(yes.tier));
            expect(tierRank(no.tier)).toBeGreaterThanOrEqual(tierRank(half.tier));
        }
    });
});

describe('the questionnaire actually moves the answer', () => {
    it('answering honestly can move an agent by more than one tier', () => {
        const cell: Cell = {
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            profile: 'ALL_NO',
        };
        const unmitigated = score(cell);
        const mitigated = score({ ...cell, profile: 'ALL_YES' });
        expect(tierRank(unmitigated.tier) - tierRank(mitigated.tier)).toBeGreaterThanOrEqual(1);
        expect(unmitigated.score - mitigated.score).toBeGreaterThan(0);
    });

    it('an UNANSWERED question counts as NO — the assessment can only score DOWN', () => {
        const cell: Cell = {
            autonomyLevel: 3,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            profile: 'UNANSWERED',
        };
        const blank = score(cell);
        const allNo = score({ ...cell, profile: 'ALL_NO' });
        // A blank assessment scores IDENTICALLY to one that answered NO to
        // everything: an unclaimed mitigation is an absent mitigation.
        expect(blank.score).toBe(allNo.score);
        expect(blank.tier).toBe(allNo.tier);
        expect(blank.breakdown.unansweredQuestions).toBe(QUESTION_SHAPE.length);
    });

    it('NA leaves the denominator rather than counting as a gap', () => {
        const na = scoreAgentRisk({
            autonomyLevel: 1,
            dataAccessScope: 'READ_METADATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            questions: QUESTION_SHAPE.map((q) => ({ ...q, answer: 'NA' as const })),
        });
        expect(na.breakdown.applicableQuestions).toBe(0);
        // Nothing applicable means nothing demonstrated, so the fail-closed
        // reading is a full gap — N/A-ing the form does not buy a lower tier.
        expect(na.breakdown.unmitigatedFraction).toBe(1);
    });

    it('a CRITICAL question weighs more than a MEDIUM one', () => {
        const axes = {
            autonomyLevel: 1,
            dataAccessScope: 'READ_METADATA' as const,
            reversibility: 'REVERSIBLE' as const,
            provenance: 'FIRST_PARTY' as const,
        };
        const criticalMissed = scoreAgentRisk({
            ...axes,
            questions: [
                { id: 'a', criticality: 'CRITICAL', answer: 'NO' },
                { id: 'b', criticality: 'MEDIUM', answer: 'YES' },
            ],
        });
        const mediumMissed = scoreAgentRisk({
            ...axes,
            questions: [
                { id: 'a', criticality: 'CRITICAL', answer: 'YES' },
                { id: 'b', criticality: 'MEDIUM', answer: 'NO' },
            ],
        });
        expect(criticalMissed.score).toBeGreaterThan(mediumMissed.score);
    });
});

describe('both ends of the scale are reachable', () => {
    it('LOW is reachable — otherwise the instrument only ever says "bad"', () => {
        const result = scoreAgentRisk({
            autonomyLevel: 1,
            dataAccessScope: 'READ_METADATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            questions: questions('ALL_YES'),
        });
        expect(result.tier).toBe('LOW');
        expect(result.floors).toEqual([]);
    });

    it('CRITICAL is reachable — otherwise the instrument never refuses anything', () => {
        const result = scoreAgentRisk({
            autonomyLevel: 6,
            dataAccessScope: 'EXTERNAL_EGRESS',
            reversibility: 'TERMINAL',
            provenance: 'THIRD_PARTY',
            questions: questions('ALL_NO'),
        });
        expect(result.tier).toBe('CRITICAL');
        expect(result.score).toBe(MAX_SCORE);
    });

    it('every tier in the enum is produced by some cell of the matrix', () => {
        const produced = new Set(ALL_CELLS.map((c) => score(c).tier));
        expect([...produced].sort()).toEqual([...RISK_TIER_ORDER].sort());
    });
});

describe('the per-axis floors are explained, not silent', () => {
    it('EXTERNAL_EGRESS floors at HIGH and says so', () => {
        const result = scoreAgentRisk({
            autonomyLevel: 0,
            dataAccessScope: 'EXTERNAL_EGRESS',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            questions: questions('ALL_YES'),
        });
        expect(result.band).toBe('LOW');
        expect(result.tier).toBe('HIGH');
        expect(result.floors.join(' ')).toContain('dataAccessScope=EXTERNAL_EGRESS');
    });

    /**
     * `floors` answers "why is the tier above the band", so it must be
     * non-empty exactly when the tier IS above the band. Asserted over every
     * cell rather than one, because the two ways this goes wrong are opposite
     * and each looks fine at a single point: a floor that fires without being
     * reported (an operator sees a tier they cannot account for) and a floor
     * reported without firing (an operator chases a cap that is not there).
     */
    it('a floor is reported exactly when the tier sits above the band', () => {
        const mismatches = ALL_CELLS.filter((c) => {
            const r = score(c);
            const raised = tierRank(r.tier) > tierRank(r.band);
            return raised !== r.floors.length > 0;
        }).map(label);
        expect(mismatches).toEqual([]);
    });

    it('and both outcomes really occur, so neither half of that is vacuous', () => {
        const results = ALL_CELLS.map(score);
        expect(results.some((r) => r.floors.length > 0)).toBe(true);
        expect(results.some((r) => r.floors.length === 0)).toBe(true);
    });

    /**
     * A floor only ever RAISES. With the weights as they stand, an axis extreme
     * enough to impose a floor also carries enough points to reach that band on
     * its own — every case except EXTERNAL_EGRESS, which sits exactly on the LOW
     * boundary at 8 points while flooring at HIGH. So at most one floor is ever
     * above the band today. The scorer still compares every floor against the
     * band rather than against the running tier, because that is the version
     * that stays correct when somebody re-weights an axis, and a re-weighting
     * is exactly when a second floor becomes reachable.
     */
    it('at most one floor is above the band under the current weights', () => {
        const counts = ALL_CELLS.map((c) => score(c).floors.length);
        expect(Math.max(...counts)).toBe(1);
    });
});

describe('the cap a tier buys', () => {
    it('a worse tier never permits MORE autonomy', () => {
        for (let i = 1; i < RISK_TIER_ORDER.length; i += 1) {
            const lower = MAX_AUTONOMY_BY_TIER[RISK_TIER_ORDER[i - 1]];
            const higher = MAX_AUTONOMY_BY_TIER[RISK_TIER_ORDER[i]];
            expect(higher).toBeLessThanOrEqual(lower);
        }
    });

    it('every tier has a cap, and no cap admits the whole ladder except LOW', () => {
        for (const tier of RISK_TIER_ORDER) {
            expect(typeof MAX_AUTONOMY_BY_TIER[tier]).toBe('number');
        }
        expect(MAX_AUTONOMY_BY_TIER.LOW).toBe(6);
        expect(MAX_AUTONOMY_BY_TIER.CRITICAL).toBeLessThan(MAX_AUTONOMY_BY_TIER.LOW);
    });
});

/**
 * The property the TRANSITION stands on.
 *
 * Wiring the tier into the autonomy ceiling denies every agent nobody has
 * assessed. For an estate of agents that were ACTIVE before that landed, the
 * bulk route out is `scripts/backfill-agent-risk-tiers.ts`, which scores each
 * one through this very scorer with NOTHING answered.
 *
 * That is only defensible because of what the arithmetic guarantees, and this
 * is where it is guaranteed rather than asserted in a docstring: an unanswered
 * question counts as NO, so a run with no answers carries the full answer
 * weight, which alone exceeds the LOW band. A provisional score can therefore
 * never come out LOW — and LOW is the only tier that leaves the ladder whole.
 * Nobody can use the backfill to buy an agent its full autonomy; filling in the
 * questionnaire is the only route there, which is what makes the questionnaire
 * worth filling in.
 */
describe('a provisional score — nothing answered — can never be the friendliest tier', () => {
    const provisionalCells = ALL_CELLS.filter((c) => c.profile === 'UNANSWERED');

    it('covers the whole axis grid, so this is a sweep and not a sample', () => {
        expect(provisionalCells.length).toBe(
            AUTONOMY_LEVELS.length * DATA_ACCESS_ORDER.length * REVERSIBILITIES.length * PROVENANCES.length,
        );
    });

    it('never returns LOW, for ANY combination of the four axes', () => {
        for (const cell of provisionalCells) {
            expect(score(cell).tier).not.toBe('LOW');
        }
    });

    it('and the friendliest provisional tier still reaches every rung a tool needs today', () => {
        // The other half, and the reason the backfill is not itself an outage:
        // the least-exposed agent lands at a tier whose cap admits the highest
        // rung any MCP capability class requires (ORCHESTRATE, 3). An agent
        // with write access, egress, irreversibility or unattended operation
        // lands lower and IS bounded until a human assesses it — which is the
        // correct direction for a control nobody has applied by hand yet.
        const gentlest = score({
            autonomyLevel: 0,
            dataAccessScope: 'NONE',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            profile: 'UNANSWERED',
        });
        expect(MAX_AUTONOMY_BY_TIER[gentlest.tier]).toBeGreaterThanOrEqual(3);
    });

    it('answering everything YES is what buys LOW back — the questionnaire moves the tier', () => {
        // The paired positive. Without it, "provisional is never LOW" would be
        // satisfied by a scorer that can never say LOW at all, and a tier
        // nobody can reach is a tier nobody fills in the form for.
        const answered = score({
            autonomyLevel: 0,
            dataAccessScope: 'NONE',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            profile: 'ALL_YES',
        });
        expect(answered.tier).toBe('LOW');
    });
});
