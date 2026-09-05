/**
 * The autonomy ceiling and the risk-tier term now folded into it.
 *
 * ## The claim
 *
 * An agent's authority belongs to the AGENT, not to whoever is holding one of
 * its credentials. That is expressed as a MINIMUM over narrowing terms, so no
 * term can widen: `min(key.maxAutonomyLevel, agent.autonomyLevel, tierCap)`.
 * The interesting cases are all about ABSENT terms, because the whole hazard is
 * that the nulls in this subsystem mean DIFFERENT things:
 *
 *   • an absent KEY ceiling is "no narrowing" — the agent term still bounds it,
 *     and reading it as DENY would take every pre-existing credential dark the
 *     moment a nullable column was added;
 *   • an absent RISK TIER on a RESOLVED agent is "unscored", which must DENY —
 *     an agent nobody has assessed is precisely the one that should not be
 *     running;
 *   • no RESOLVED AGENT AT ALL — a human, an ordinary integration key, a tenant
 *     with the register switched off — contributes no tier term whatsoever, and
 *     reading THAT as unscored is what would have taken the MCP surface dark on
 *     the deploy that wired this.
 *
 * Getting any of the three backwards is silent in the direction that matters,
 * which is why all three are pinned here rather than left to the reader.
 */
import {
    AUTONOMY_MAX,
    AUTONOMY_MIN,
    AUTONOMY_REQUIRED_BY_CAPABILITY,
    DENY_CEILING,
    UNCLAMPED,
    ceilingForRiskTier,
    requiredAutonomyFor,
    resolveAutonomyCeiling,
    riskTierCeilingFor,
    withinCeiling,
    type McpCapabilityClass,
} from '@/lib/agentic/autonomy-ceiling';
import { MAX_AUTONOMY_BY_TIER, RISK_TIER_ORDER } from '@/lib/agentic/agent-risk-scoring';

/**
 * The GENTLEST tier term the table has, so the assertions below are about the
 * OTHER two terms. Spelled as a scored LOW agent rather than as a bare constant,
 * because that is a state the product can actually be in.
 *
 * It is not `UNCLAMPED`, and that matters when reading these: LOW caps at the
 * top of the ATTENDED ladder, because rungs 5-6 are unattended operation and no
 * assessment can score an unattended agent LOW. Every case below therefore
 * chooses key and agent numbers at or under that cap, so what is being observed
 * is the term under test rather than the tier quietly winning.
 */
const scoredLow = { riskTierCeiling: riskTierCeilingFor({ riskTier: 'LOW' as const }) };
const LOW_CAP = MAX_AUTONOMY_BY_TIER.LOW;

describe('the ceiling is the lowest present term', () => {
    it('takes the KEY when the key is the lower of the two', () => {
        expect(
            resolveAutonomyCeiling({ keyMax: 1, agentAutonomy: 5, ...scoredLow }),
        ).toBe(1);
    });

    it('takes the AGENT when the agent is the lower of the two', () => {
        expect(
            resolveAutonomyCeiling({ keyMax: 5, agentAutonomy: 2, ...scoredLow }),
        ).toBe(2);
    });

    it('a key can never widen its agent — even asking for the maximum', () => {
        // The property the whole column exists for, stated as an equality
        // rather than an inequality: a key set to 6 against an agent
        // registered at 2 yields 2, not 6 and not "6 clamped somewhere later".
        expect(
            resolveAutonomyCeiling({ keyMax: AUTONOMY_MAX, agentAutonomy: 2, ...scoredLow }),
        ).toBe(2);
    });

    it('a key asking for the maximum is clamped by the TIER when nothing else narrows', () => {
        // The same request with no agent term: `AUTONOMY_MAX` does not come
        // back, because even the gentlest tier stops below the top of the
        // ladder. This is the assertion that would have caught a cap granting a
        // rung its own tier could not be scored at.
        expect(
            resolveAutonomyCeiling({ keyMax: AUTONOMY_MAX, agentAutonomy: null, ...scoredLow }),
        ).toBe(LOW_CAP);
        expect(LOW_CAP).toBeLessThan(AUTONOMY_MAX);
    });

    it('an ABSENT key ceiling contributes no term, leaving the agent in force', () => {
        for (const absent of [null, undefined]) {
            expect(
                resolveAutonomyCeiling({ keyMax: absent, agentAutonomy: 3, ...scoredLow }),
            ).toBe(3);
        }
    });

    it('an ABSENT agent — the register switched off — leaves the key in force', () => {
        expect(
            resolveAutonomyCeiling({ keyMax: 2, agentAutonomy: null, ...scoredLow }),
        ).toBe(2);
    });

    it('with neither narrowing term present, the TIER is what remains — not zero', () => {
        // A missing narrowing must not itself be a narrowing, or adding a
        // nullable column silently denies every existing credential. So the
        // answer is the one term that IS present, exactly, with nothing
        // defaulted in beside it.
        expect(
            resolveAutonomyCeiling({ keyMax: null, agentAutonomy: null, ...scoredLow }),
        ).toBe(LOW_CAP);
        expect(
            resolveAutonomyCeiling({
                keyMax: undefined,
                agentAutonomy: undefined,
                riskTierCeiling: UNCLAMPED,
            }),
        ).toBe(UNCLAMPED);
    });

    it('a floor of 0 is a real value and is not confused with absence', () => {
        // Rung 0 is "suggests only, reaches nothing". No MCP tool sits at 0, so
        // this ceiling admits nothing — which is the register meaning what it
        // says, not a rounding error.
        expect(
            resolveAutonomyCeiling({ keyMax: AUTONOMY_MIN, agentAutonomy: 6, ...scoredLow }),
        ).toBe(0);
        expect(withinCeiling(AUTONOMY_REQUIRED_BY_CAPABILITY.read, 0)).toBe(false);
    });
});

describe('the rung a tool call requires', () => {
    it('is 1 for a read, 2 for a propose, 3 for an orchestration', () => {
        expect(requiredAutonomyFor('read')).toBe(1);
        expect(requiredAutonomyFor('propose')).toBe(2);
        expect(requiredAutonomyFor('orchestrate')).toBe(3);
    });

    it('reads strictly below proposes, which read strictly below orchestration', () => {
        // The ORDER is the load-bearing part: an agent allowed to propose is
        // allowed to read, and never the reverse.
        const { read, propose, orchestrate } = AUTONOMY_REQUIRED_BY_CAPABILITY;
        expect(read).toBeLessThan(propose);
        expect(propose).toBeLessThan(orchestrate);
    });

    it('a tool may declare its own rung, overriding its class', () => {
        expect(requiredAutonomyFor('read', 4)).toBe(4);
    });

    it('a class with no default falls to the HIGHEST rung, not the lowest', () => {
        // Unrepresentable in the type — which is the point. If a future
        // capability class is added to the union and forgotten in the table,
        // the fail direction has to be "refused to low-autonomy agents", not
        // "admitted to all of them".
        const unknown = 'broadcast' as unknown as McpCapabilityClass;
        expect(requiredAutonomyFor(unknown)).toBe(AUTONOMY_REQUIRED_BY_CAPABILITY.orchestrate);
    });
});

describe('the risk-tier term', () => {
    it('an UNSCORED tier denies — it does not resolve to a low tier', () => {
        // The one direction that must never be got backwards. NULL is the state
        // between insert and the first scoring run; treating it as LOW would
        // give the least-assessed agent the friendliest treatment.
        expect(ceilingForRiskTier(null)).toBe(DENY_CEILING);
        expect(ceilingForRiskTier(undefined)).toBe(DENY_CEILING);
    });

    it('DENY_CEILING refuses every rung, including rung 0', () => {
        // Below AUTONOMY_MIN deliberately, so a comparison written as
        // `required <= ceiling` cannot let a rung-0 tool through a deny.
        expect(DENY_CEILING).toBeLessThan(AUTONOMY_MIN);
        for (const rung of [0, 1, 2, 3, 4, 5, 6]) {
            expect(withinCeiling(rung, DENY_CEILING)).toBe(false);
        }
    });

    it('a SCORED tier resolves to the cap the scorer publishes for it', () => {
        // The consequence table lives with the scorer. Asserting the identity
        // rather than re-typing four numbers is deliberate: a second copy here
        // could disagree with the one the product reads and both would be
        // green.
        for (const tier of RISK_TIER_ORDER) {
            expect(ceilingForRiskTier(tier)).toBe(MAX_AUTONOMY_BY_TIER[tier]);
        }
    });

    it('the caps fall as the tier rises, and NO tier leaves the ladder whole', () => {
        // The property that makes the assessment worth filling in: every tier
        // costs the agent rungs, and each worse tier costs more. Stated as an
        // ordering rather than as four literals so it stays true if the numbers
        // are re-tuned.
        const caps = RISK_TIER_ORDER.map((t) => MAX_AUTONOMY_BY_TIER[t]);
        for (let i = 1; i < caps.length; i += 1) {
            expect(caps[i]).toBeLessThan(caps[i - 1]);
        }
        // Not even LOW reaches `UNCLAMPED`, and that is the floor table meaning
        // what it says rather than an oversight: rungs 5 and 6 are unattended
        // operation, which floors at MODERATE, so LOW is unreachable there and
        // must not GRANT there either. The reachability sweep that establishes
        // this lives with the scorer, in `agent-risk-scoring.test.ts`.
        for (const tier of RISK_TIER_ORDER) {
            expect(ceilingForRiskTier(tier)).toBeLessThan(UNCLAMPED);
        }
        // The paired positive, so "everything is clamped" cannot be satisfied by
        // a table that denies outright: the gentlest tier still admits every
        // rung an MCP capability class asks for today.
        expect(ceilingForRiskTier('LOW')).toBeGreaterThanOrEqual(
            Math.max(...Object.values(AUTONOMY_REQUIRED_BY_CAPABILITY)),
        );
    });

    it('a tier this build does not recognise DENIES rather than admitting', () => {
        // Unrepresentable in the type, which is the point: a value added to the
        // Prisma enum without a cap here must refuse, not sail through. The
        // stored `PROPOSE`-style ghost in the identity subsystem is the worked
        // example of an enum value outliving the code that understood it.
        const unknown = 'EXTREME' as unknown as Parameters<typeof ceilingForRiskTier>[0];
        expect(ceilingForRiskTier(unknown)).toBe(DENY_CEILING);
    });
});

describe('no resolved agent is NOT an unscored agent', () => {
    it('an absent agent contributes NO tier term — it does not deny', () => {
        // The third null. A signed-in human, an ordinary integration key, or a
        // tenant that never switched the register on: there is no agent, so
        // there is nothing to have assessed. Reading this as "unscored" is the
        // change that would have taken the whole MCP surface dark, and it is
        // the reason the argument is an object-or-null rather than a bare tier.
        expect(riskTierCeilingFor(null)).toBe(UNCLAMPED);
    });

    it('a resolved agent with a null tier DENIES', () => {
        expect(riskTierCeilingFor({ riskTier: null })).toBe(DENY_CEILING);
        expect(riskTierCeilingFor({ riskTier: undefined })).toBe(DENY_CEILING);
    });

    it('the two are not the same value, which is the whole point', () => {
        expect(riskTierCeilingFor(null)).not.toBe(riskTierCeilingFor({ riskTier: null }));
    });

    it('a resolved SCORED agent contributes its cap', () => {
        expect(riskTierCeilingFor({ riskTier: 'HIGH' })).toBe(MAX_AUTONOMY_BY_TIER.HIGH);
    });
});

describe('the tier composes into the minimum rather than replacing it', () => {
    it('an unscored agent DENIES an otherwise fully-authorised credential', () => {
        // Same agent, same key, same everything — only the tier term changes.
        const scored = resolveAutonomyCeiling({
            keyMax: 6,
            agentAutonomy: 6,
            riskTierCeiling: riskTierCeilingFor({ riskTier: 'LOW' }),
        });
        expect(withinCeiling(AUTONOMY_REQUIRED_BY_CAPABILITY.read, scored)).toBe(true);

        const unscored = resolveAutonomyCeiling({
            keyMax: 6,
            agentAutonomy: 6,
            riskTierCeiling: riskTierCeilingFor({ riskTier: null }),
        });
        expect(unscored).toBe(DENY_CEILING);
        expect(withinCeiling(AUTONOMY_REQUIRED_BY_CAPABILITY.read, unscored)).toBe(false);
    });

    it('a HIGH tier caps an agent registered above it', () => {
        // The acceptance property, at the arithmetic: an agent REGISTERED at 6
        // and ASSESSED as HIGH is driven no further than HIGH's cap, whatever
        // the register claims and whatever the key allows.
        expect(
            resolveAutonomyCeiling({
                keyMax: 6,
                agentAutonomy: 6,
                riskTierCeiling: riskTierCeilingFor({ riskTier: 'HIGH' }),
            }),
        ).toBe(MAX_AUTONOMY_BY_TIER.HIGH);
    });

    it('the tier never WIDENS a narrower key or a narrower registration', () => {
        // A LOW tier is the most permissive answer the table has, and it still
        // cannot lift a key pinned at 1 or an agent registered at 1. `min` has
        // no arm that goes the other way, and this is the assertion that would
        // fail if somebody rewrote the composition as a lookup.
        expect(
            resolveAutonomyCeiling({
                keyMax: 1,
                agentAutonomy: 6,
                riskTierCeiling: riskTierCeilingFor({ riskTier: 'LOW' }),
            }),
        ).toBe(1);
        expect(
            resolveAutonomyCeiling({
                keyMax: 6,
                agentAutonomy: 1,
                riskTierCeiling: riskTierCeilingFor({ riskTier: 'LOW' }),
            }),
        ).toBe(1);
    });
});
