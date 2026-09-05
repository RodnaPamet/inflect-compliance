/**
 * What a tier makes true elsewhere — the two consequences declared before
 * their consumers exist, and the fail direction each one settles.
 *
 * ## Why these are tested at all when nothing calls them
 *
 * 2/10 shipped `ceilingForRiskTier` one prompt before anything called it, and
 * the reason that worked is that the fail direction was decided IN the function
 * and pinned by a test. When 3/10 came to wire it, the decision was already
 * made and could only be undone by deleting a line — not by a caller quietly
 * choosing the convenient branch.
 *
 * `reviewRequirementForRiskTier` (8/10) and `defaultPolicyCardForRiskTier`
 * (5/10) are in exactly that position now. The assertions below are the part
 * that survives until their callers arrive: what an UNSCORED agent gets, what
 * an unrecognised tier gets, and — for the policy card — that its numbers are
 * DERIVED from the cap the tool boundary already enforces rather than typed out
 * a second time.
 *
 * A card that offers rung 5 to an agent the funnel caps at 2 is worse than no
 * card: it is a written promise the product then breaks.
 */
import {
    SECOND_APPROVER_FROM_TIER,
    defaultPolicyCardForRiskTier,
    reviewRequirementForRiskTier,
} from '@/lib/agentic/risk-tier-consequences';
import { MAX_AUTONOMY_BY_TIER, RISK_TIER_ORDER } from '@/lib/agentic/agent-risk-scoring';
import { DENY_CEILING, ceilingForRiskTier } from '@/lib/agentic/autonomy-ceiling';

type MaybeTier = Parameters<typeof reviewRequirementForRiskTier>[0];

describe('the 8/10 seam — how many humans must approve', () => {
    it('an UNSCORED agent gets the STRICTEST handling, not the friendliest', () => {
        // The direction 8/10 must not get backwards, decided here so it cannot
        // be re-decided at the queue. An unscored agent should not be reaching
        // the queue at all — the autonomy cap refuses it the PROPOSE rung — so
        // if one arrives, the strictest handling is the only defensible answer.
        for (const absent of [null, undefined] as const) {
            expect(reviewRequirementForRiskTier(absent)).toEqual({
                approvals: 2,
                requireSecondApprover: true,
                autoApprovable: false,
            });
        }
    });

    it('a tier this build does not recognise also gets the strictest handling', () => {
        // Unrepresentable in the type, which is the point: a value added to the
        // Prisma enum without a decision here must not silently become
        // auto-approvable. The identity subsystem's stored `PROPOSE` ghost is
        // the worked example of an enum value outliving the code that
        // understood it.
        const unknown = 'EXTREME' as unknown as MaybeTier;
        expect(reviewRequirementForRiskTier(unknown).autoApprovable).toBe(false);
        expect(reviewRequirementForRiskTier(unknown).approvals).toBe(2);
    });

    it('the second approver starts at the threshold and never stops', () => {
        // Stated as a property over the ordering rather than as four literals,
        // so moving the threshold moves the test with it instead of leaving a
        // stale copy that disagrees.
        const threshold = RISK_TIER_ORDER.indexOf(SECOND_APPROVER_FROM_TIER);
        expect(threshold).toBeGreaterThan(-1);
        RISK_TIER_ORDER.forEach((tier, index) => {
            const requirement = reviewRequirementForRiskTier(tier);
            expect(requirement.requireSecondApprover).toBe(index >= threshold);
            expect(requirement.approvals).toBe(index >= threshold ? 2 : 1);
            expect(requirement.autoApprovable).toBe(index < threshold);
        });
    });

    it('the requirement never LOOSENS as the tier rises', () => {
        // The monotonicity that makes the threshold meaningful. A table with a
        // typo could satisfy every case above and still say a CRITICAL agent
        // needs fewer signatures than a HIGH one.
        const approvals = RISK_TIER_ORDER.map((t) => reviewRequirementForRiskTier(t).approvals);
        for (let i = 1; i < approvals.length; i += 1) {
            expect(approvals[i]).toBeGreaterThanOrEqual(approvals[i - 1]);
        }
    });

    it('the threshold sits where the autonomy cap stops agreeing with the registration', () => {
        // Not a coincidence and not decoration: the two controls should not
        // disagree about where "a person decides" begins. At and above the
        // threshold the cap is the PROPOSE rung or lower, so the agent can only
        // put drafts in front of a human anyway.
        expect(MAX_AUTONOMY_BY_TIER[SECOND_APPROVER_FROM_TIER]).toBeLessThanOrEqual(2);
    });
});

describe('the 5/10 seam — what a policy card opens at', () => {
    it('an UNSCORED agent opens at NO authority and refuses to be saved', () => {
        expect(defaultPolicyCardForRiskTier(null)).toEqual({
            maxAutonomyLevel: DENY_CEILING,
            requireSecondApprover: true,
            allowAutoApproval: false,
            assessmentRequired: true,
            // A zero budget as well as a denying ceiling. Both, because they are
            // independent terms and an unscored agent must be inert under either
            // one on its own — a future edit that softened the ceiling should
            // still leave nothing runnable.
            maxActionsPerRun: 0,
            maxActionsPerDay: 0,
        });
    });

    it('the card DERIVES its cap from the ceiling the tool boundary enforces', () => {
        // The assertion that matters most, and the reason the function is not a
        // table: a second copy of these numbers could disagree with the one the
        // funnel reads, and both would be green.
        for (const tier of RISK_TIER_ORDER) {
            expect(defaultPolicyCardForRiskTier(tier).maxAutonomyLevel).toBe(
                ceilingForRiskTier(tier),
            );
        }
    });

    it('the card and the approval queue agree with each other for every tier', () => {
        for (const tier of RISK_TIER_ORDER) {
            const review = reviewRequirementForRiskTier(tier);
            const card = defaultPolicyCardForRiskTier(tier);
            expect(card.requireSecondApprover).toBe(review.requireSecondApprover);
            expect(card.allowAutoApproval).toBe(review.autoApprovable);
            expect(card.assessmentRequired).toBe(false);
        }
    });

    it('no scored tier is ever marked assessmentRequired, and every unscored one is', () => {
        // `assessmentRequired` is the one field that answers a different
        // question from the others — "is every default here a guess?" — so it
        // is pinned both ways rather than left to the reader.
        expect(defaultPolicyCardForRiskTier(undefined).assessmentRequired).toBe(true);
        expect(defaultPolicyCardForRiskTier('LOW').assessmentRequired).toBe(false);
    });
});
