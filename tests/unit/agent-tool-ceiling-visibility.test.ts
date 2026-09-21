/**
 * A GRANT THE CEILING CANNOT REACH IS STILL A ROW IN THE REGISTER.
 *
 * `assertGrantWithinTier` refuses an over-tier grant when it is made, which is
 * easy to mistake for "an unreachable grant cannot exist". It is not, for three
 * reasons — and each leaves a row that reads as authority and is refused on
 * every call:
 *
 *   1. AN UNSCORED AGENT IS DELIBERATELY NOT REFUSED. Preparing a DRAFT agent's
 *      tool list before assessing it is an ordinary workflow, so every grant is
 *      allowed and `DENY_CEILING` makes every one of them unreachable.
 *   2. THE TIER IS RE-ASSESSABLE DOWNWARD. The refusal runs at grant time only.
 *   3. THE REGISTERED AUTONOMY IS NEVER CHECKED. That refusal compares against
 *      `ceilingForRiskTier` alone, while every call goes through
 *      `resolveAutonomyCeiling`, which ALSO mins in `agent.autonomyLevel`.
 *
 * (3) is the one no amount of care at the grant site closes, so it is asserted
 * first and by name.
 */
import {
    resolveAutonomyCeiling,
    riskTierCeilingFor,
    requiredAutonomyFor,
    withinCeiling,
    ceilingForRiskTier,
    AUTONOMY_REQUIRED_BY_CAPABILITY,
    DENY_CEILING,
} from '@/lib/agentic/autonomy-ceiling';

/** What `listAgentTools` computes, composed from the same helpers. */
function effectiveCeiling(agent: {
    riskTier: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' | null;
    autonomyLevel: number;
}): number {
    return resolveAutonomyCeiling({
        riskTierCeiling: riskTierCeilingFor(agent),
        agentAutonomy: agent.autonomyLevel,
        keyMax: null,
    });
}

describe('the ceiling a register page must show', () => {
    it('the REGISTERED AUTONOMY narrows below the tier cap — the term grant-time never checks', () => {
        // The gap with teeth. An agent whose tier permits a high rung but whose
        // registered autonomy does not: `assertGrantWithinTier` compares only
        // against the tier, so such a grant is written without complaint.
        const agent = { riskTier: 'LOW' as const, autonomyLevel: 1 };
        const tierCap = ceilingForRiskTier(agent.riskTier);
        const effective = effectiveCeiling(agent);

        // The two numbers DISAGREE, which is the whole finding. If they were
        // equal this test would be pinning a coincidence.
        expect(effective).toBeLessThan(tierCap);
        expect(effective).toBe(1);

        // And a propose tool requires more than the agent can reach, while the
        // tier alone would have allowed it.
        const required = requiredAutonomyFor('propose');
        expect(withinCeiling(required, tierCap)).toBe(true);
        expect(withinCeiling(required, effective)).toBe(false);
    });

    it('an UNSCORED agent reaches nothing, whatever its registered autonomy', () => {
        // DENY_CEILING is -1, so it wins the minimum against any rung.
        const effective = effectiveCeiling({ riskTier: null, autonomyLevel: 6 });
        expect(effective).toBe(DENY_CEILING);
        for (const cls of Object.keys(AUTONOMY_REQUIRED_BY_CAPABILITY)) {
            expect(
                withinCeiling(
                    requiredAutonomyFor(cls as keyof typeof AUTONOMY_REQUIRED_BY_CAPABILITY),
                    effective,
                ),
            ).toBe(false);
        }
    });

    it('a re-score DOWNWARD narrows the ceiling under grants already written', () => {
        const before = effectiveCeiling({ riskTier: 'LOW', autonomyLevel: 6 });
        const after = effectiveCeiling({ riskTier: 'CRITICAL', autonomyLevel: 6 });
        expect(after).toBeLessThan(before);
    });

    it('a well-matched agent is NOT flagged — the badge must not fire on everything', () => {
        // The positive control. Without it, a predicate that returned true
        // unconditionally would pass every assertion above.
        const agent = { riskTier: 'LOW' as const, autonomyLevel: 6 };
        const effective = effectiveCeiling(agent);
        expect(withinCeiling(requiredAutonomyFor('read'), effective)).toBe(true);
        expect(withinCeiling(requiredAutonomyFor('propose'), effective)).toBe(true);
    });

    it('the ceiling shown is the AGENT ceiling, and a key can only narrow it further', () => {
        // Why the payload documents what it is NOT. A surface claiming the
        // agent's ceiling is what a call gets would over-promise for every
        // credential carrying its own lower maximum.
        const agent = { riskTier: 'LOW' as const, autonomyLevel: 4 };
        const agentCeiling = effectiveCeiling(agent);
        const withKey = resolveAutonomyCeiling({
            riskTierCeiling: riskTierCeilingFor(agent),
            agentAutonomy: agent.autonomyLevel,
            keyMax: 2,
        });
        expect(withKey).toBeLessThan(agentCeiling);
    });
});
