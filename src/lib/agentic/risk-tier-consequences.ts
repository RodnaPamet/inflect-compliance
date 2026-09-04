/**
 * What a scored `AgentRiskTier` MAKES TRUE elsewhere in the product.
 *
 * The autonomy cap (`MAX_AUTONOMY_BY_TIER`, in `agent-risk-scoring.ts`) is the
 * consequence that is already wired, at the MCP tool boundary. Two more are
 * declared here because their consumers do not exist yet, and a consequence
 * that waits to be invented alongside its consumer is a consequence that gets
 * invented differently — which is how "the assessment says HIGH" ends up
 * meaning one thing on the approval queue and another on the policy card.
 *
 * ## The house style for an unbuilt seam, copied from 2/10
 *
 * 2/10 shipped `ceilingForRiskTier` a whole prompt before anything called it:
 * a named export, a docstring saying who wires it, and — the part that
 * mattered — the FAIL DIRECTION settled in the function rather than left to the
 * eventual caller. When 3/10 came to wire it, the decision was already made and
 * could only be undone by deleting a line.
 *
 * Both functions below follow that exactly. Neither has a caller today. Both
 * resolve an UNSCORED or UNKNOWN tier to the STRICTEST answer they can express,
 * so a caller that forgets to handle the null gets the safe result rather than
 * the convenient one.
 *
 * ## Why these are consequences of the tier and not new settings
 *
 * Nothing here invents a new axis. The review requirement is a threshold on the
 * tier ordering; the policy-card defaults are assembled from the autonomy cap
 * and that threshold. Adding a genuinely new dimension (a rate limit, an egress
 * allowlist) is a decision for the prompt that needs it — and it belongs HERE,
 * beside the others, not in that prompt's own module.
 */
import type { AgentRiskTier } from '@prisma/client';

import { DENY_CEILING, ceilingForRiskTier } from './autonomy-ceiling';
import { RISK_TIER_ORDER } from './agent-risk-scoring';

/**
 * The tier at and above which a second human must approve. HIGH, because that
 * is the rung at which the autonomy cap already stops agreeing with the
 * registration (`MAX_AUTONOMY_BY_TIER.HIGH` is PROPOSE, so the agent can only
 * put drafts in front of a person) — the two controls should not disagree about
 * where "a person decides" begins.
 */
export const SECOND_APPROVER_FROM_TIER: AgentRiskTier = 'HIGH';

export interface AgentReviewRequirement {
    /** How many distinct humans must approve one of this agent's proposals. */
    approvals: number;
    /** Convenience for the common branch; `approvals > 1`. */
    requireSecondApprover: boolean;
    /**
     * May a proposal from this agent ever be auto-approved by a rule?
     * FALSE for an unscored agent, and false at and above the threshold.
     */
    autoApprovable: boolean;
}

/**
 * ── SEAM (Agentic 8/10) — APPROVER TIERING. ─────────────────────────
 *
 * 8/10 builds the human review queue over `AgentProposal`. When it does, THIS
 * is the function that decides how many people have to sign, and the queue must
 * read it rather than growing a second opinion about what HIGH means.
 *
 * Wired by: 8/10, at the proposal-approval usecase. Nothing calls it today.
 *
 * Fails CLOSED: an unscored agent (NULL) — and any tier this build does not
 * recognise — requires two approvers and can never be auto-approved. An
 * unscored agent should not be reaching the queue at all (the autonomy cap
 * refuses it a PROPOSE rung), so if one does arrive, the strictest handling is
 * the only defensible answer.
 */
export function reviewRequirementForRiskTier(
    tier: AgentRiskTier | null | undefined,
): AgentReviewRequirement {
    const STRICT: AgentReviewRequirement = {
        approvals: 2,
        requireSecondApprover: true,
        autoApprovable: false,
    };
    if (tier === null || tier === undefined) return STRICT;

    const index = RISK_TIER_ORDER.indexOf(tier);
    // Unknown to this build. Fail toward the strict answer rather than toward
    // the convenient one — a tier added to the enum without a decision here
    // must not silently become auto-approvable.
    if (index === -1) return STRICT;

    const threshold = RISK_TIER_ORDER.indexOf(SECOND_APPROVER_FROM_TIER);
    if (index >= threshold) return STRICT;

    return { approvals: 1, requireSecondApprover: false, autoApprovable: true };
}

export interface AgentPolicyCardDefaults {
    /**
     * The highest rung the card may be pre-filled with. `DENY_CEILING` for an
     * unscored agent — a card that opens at "no authority" is a card an
     * operator has to widen deliberately.
     */
    maxAutonomyLevel: number;
    /** Pre-tick the second-approver control? */
    requireSecondApprover: boolean;
    /** Pre-allow rule-driven auto-approval? */
    allowAutoApproval: boolean;
    /**
     * Whether the card should refuse to be saved until the agent is assessed.
     * TRUE exactly when the agent is unscored — the one state in which every
     * other default here is a guess.
     */
    assessmentRequired: boolean;
}

/**
 * ── SEAM (Agentic 5/10) — POLICY-CARD DEFAULTS. ─────────────────────
 *
 * 5/10 builds the per-agent policy card. When it does, THIS is where its
 * defaults come from, so that opening a card on a HIGH agent starts from what
 * the assessment already decided rather than from a blank form somebody fills
 * in from memory.
 *
 * Wired by: 5/10, when it builds the card's initial state. Nothing calls it
 * today.
 *
 * Fails CLOSED: an unscored agent gets `maxAutonomyLevel: DENY_CEILING`, both
 * approval controls at their strictest, and `assessmentRequired: true`.
 *
 * Deliberately DERIVED rather than tabulated. Every field is computed from a
 * decision that already exists — the autonomy cap and the approver threshold —
 * so the card cannot drift away from what the tool boundary actually enforces.
 * A card that offers rung 5 to an agent the funnel caps at 2 is worse than no
 * card: it is a written promise the product then breaks.
 */
export function defaultPolicyCardForRiskTier(
    tier: AgentRiskTier | null | undefined,
): AgentPolicyCardDefaults {
    const review = reviewRequirementForRiskTier(tier);
    const unscored = tier === null || tier === undefined;
    return {
        maxAutonomyLevel: unscored ? DENY_CEILING : ceilingForRiskTier(tier),
        requireSecondApprover: review.requireSecondApprover,
        allowAutoApproval: review.autoApprovable,
        assessmentRequired: unscored,
    };
}
