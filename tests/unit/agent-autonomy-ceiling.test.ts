/**
 * The autonomy ceiling, and the risk-tier seam it leaves for 3/10.
 *
 * ## The claim
 *
 * An agent's authority belongs to the AGENT, not to whoever is holding one of
 * its credentials. That is expressed as a MINIMUM over narrowing terms, so no
 * term can widen: `min(key.maxAutonomyLevel, agent.autonomyLevel [, tierCap])`.
 * The interesting cases are all about ABSENT terms, because the whole hazard is
 * that the two nulls in this subsystem mean opposite things:
 *
 *   • an absent KEY ceiling is "no narrowing" — the agent term still bounds it,
 *     and reading it as DENY would take every pre-existing credential dark the
 *     moment a nullable column was added;
 *   • an absent RISK TIER is "unscored", which must DENY — an agent nobody has
 *     assessed is precisely the one that should not be running.
 *
 * Getting either one backwards is silent in the direction that matters, which
 * is why both directions are pinned here rather than left to the reader.
 *
 * ## Why the tier term is tested but not wired
 *
 * `ceilingForRiskTier` encodes the NULL ⇒ DENY direction TODAY, and the
 * composition below proves that folding it in refuses everything. It is not
 * wired into the live call site, because every agent in every register is
 * currently unscored — `createRegisteredAgent` leaves the tier NULL on purpose
 * and the scorer is 3/10's work — so wiring it now would take the MCP surface
 * dark for every tenant. 3/10 replaces one argument at one call site; the
 * decision it would otherwise have had to re-make is already made here.
 */
import {
    AUTONOMY_MAX,
    AUTONOMY_MIN,
    AUTONOMY_REQUIRED_BY_CAPABILITY,
    DENY_CEILING,
    RISK_TIER_CEILING_UNWIRED,
    UNCLAMPED,
    ceilingForRiskTier,
    requiredAutonomyFor,
    resolveAutonomyCeiling,
    withinCeiling,
    type McpCapabilityClass,
} from '@/lib/agentic/autonomy-ceiling';

const unwired = { riskTierCeiling: RISK_TIER_CEILING_UNWIRED };

describe('the ceiling is the lowest present term', () => {
    it('takes the KEY when the key is the lower of the two', () => {
        expect(
            resolveAutonomyCeiling({ keyMax: 1, agentAutonomy: 5, ...unwired }),
        ).toBe(1);
    });

    it('takes the AGENT when the agent is the lower of the two', () => {
        expect(
            resolveAutonomyCeiling({ keyMax: 5, agentAutonomy: 2, ...unwired }),
        ).toBe(2);
    });

    it('a key can never widen its agent — even asking for the maximum', () => {
        // The property the whole column exists for, stated as an equality
        // rather than an inequality: a key set to 6 against an agent
        // registered at 2 yields 2, not 6 and not "6 clamped somewhere later".
        expect(
            resolveAutonomyCeiling({ keyMax: AUTONOMY_MAX, agentAutonomy: 2, ...unwired }),
        ).toBe(2);
    });

    it('an ABSENT key ceiling contributes no term, leaving the agent in force', () => {
        for (const absent of [null, undefined]) {
            expect(
                resolveAutonomyCeiling({ keyMax: absent, agentAutonomy: 3, ...unwired }),
            ).toBe(3);
        }
    });

    it('an ABSENT agent — the register switched off — leaves the key in force', () => {
        expect(
            resolveAutonomyCeiling({ keyMax: 2, agentAutonomy: null, ...unwired }),
        ).toBe(2);
    });

    it('with neither term present it is UNCLAMPED, not zero', () => {
        // A missing narrowing must not itself be a narrowing, or adding a
        // nullable column silently denies every existing credential.
        expect(
            resolveAutonomyCeiling({ keyMax: null, agentAutonomy: null, ...unwired }),
        ).toBe(UNCLAMPED);
    });

    it('a floor of 0 is a real value and is not confused with absence', () => {
        // Rung 0 is "suggests only, reaches nothing". No MCP tool sits at 0, so
        // this ceiling admits nothing — which is the register meaning what it
        // says, not a rounding error.
        expect(
            resolveAutonomyCeiling({ keyMax: AUTONOMY_MIN, agentAutonomy: 6, ...unwired }),
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

describe('the 3/10 risk-tier seam', () => {
    it('an UNSCORED tier denies — it does not resolve to a low tier', () => {
        // The one direction 3/10 must not get backwards. NULL is the state
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

    it('a SCORED tier imposes no clamp yet — the tier table is 3/10 to write', () => {
        for (const tier of ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const) {
            expect(ceilingForRiskTier(tier)).toBe(UNCLAMPED);
        }
    });

    it('folding the unscored term in DENIES an otherwise fully-authorised agent', () => {
        // The composition, which is what 3/10 actually turns on. Same agent,
        // same key, same everything — only the tier term changes.
        const permissive = resolveAutonomyCeiling({
            keyMax: 6,
            agentAutonomy: 6,
            riskTierCeiling: RISK_TIER_CEILING_UNWIRED,
        });
        expect(withinCeiling(AUTONOMY_REQUIRED_BY_CAPABILITY.read, permissive)).toBe(true);

        const wired = resolveAutonomyCeiling({
            keyMax: 6,
            agentAutonomy: 6,
            riskTierCeiling: ceilingForRiskTier(null),
        });
        expect(wired).toBe(DENY_CEILING);
        expect(withinCeiling(AUTONOMY_REQUIRED_BY_CAPABILITY.read, wired)).toBe(false);
    });

    it('the placeholder the live call site passes imposes nothing, and says so', () => {
        // If somebody deletes the seam and leaves the placeholder, this is the
        // assertion that keeps the meaning of the constant honest.
        expect(RISK_TIER_CEILING_UNWIRED).toBe(UNCLAMPED);
        expect(RISK_TIER_CEILING_UNWIRED).not.toBe(DENY_CEILING);
    });
});
