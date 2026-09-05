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
 * Both functions below follow that exactly. `defaultPolicyCardForRiskTier` was
 * wired by 5/10 and is now the seeding of every policy card;
 * `reviewRequirementForRiskTier` still waits for 8/10. Both resolve an UNSCORED
 * or UNKNOWN tier to the STRICTEST answer they can express, so a caller that
 * forgets to handle the null gets the safe result rather than the convenient
 * one.
 *
 * ## Why these are consequences of the tier and not new settings
 *
 * Nothing here invents a new axis. The review requirement is a threshold on the
 * tier ordering; the policy-card defaults are assembled from the autonomy cap
 * and that threshold. Adding a genuinely new dimension (a rate limit, an egress
 * allowlist) is a decision for the prompt that needs it — and it belongs HERE,
 * beside the others, not in that prompt's own module.
 *
 * 5/10 took that instruction and added the per-run and per-day ACTION BUDGETS,
 * which are genuinely new: nothing before them limited how MANY times an agent
 * could exercise authority it legitimately holds. They are composed here and
 * their per-tier values live with the scorer, exactly as `ceilingForRiskTier`
 * composes `MAX_AUTONOMY_BY_TIER`. What 5/10 did NOT add here is the card's data
 * ceiling: the register already carries the operator's own `dataAccessScope`
 * declaration for each agent, and deriving a second answer from the tier would
 * be two numbers for one question.
 */
import type { AgentRiskTier } from '@prisma/client';

import { DENY_CEILING, ceilingForRiskTier } from './autonomy-ceiling';
import {
    MAX_ACTIONS_PER_DAY_BY_TIER,
    MAX_ACTIONS_PER_RUN_BY_TIER,
    RISK_TIER_ORDER,
} from './agent-risk-scoring';
import type { ActionCap } from './policy-card';

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
    /**
     * How many tool calls one run of this agent may make. A rung of
     * `ACTION_CAP_LADDER`, so the default is a value an operator could also have
     * typed — a seeded number that no hand edit can reproduce is a number the
     * ladder does not govern.
     */
    maxActionsPerRun: ActionCap;
    /** How many tool calls this agent may make in one UTC day. */
    maxActionsPerDay: ActionCap;
}

/**
 * The two budgets a tier permits, fail-closed.
 *
 * ZERO for an unscored agent and for a tier this build does not recognise —
 * the same direction `ceilingForRiskTier` takes for the autonomy term, and for
 * the same reason. A budget is authority measured in calls, and the least-
 * assessed agent must not be the one with the largest allowance.
 *
 * A tier PRESENT in the enum but MISSING from either table also resolves to
 * zero. The lookup is written as a possibly-undefined read for exactly that
 * reason: the type says it cannot happen, and the fail direction is what decides
 * whether being wrong about that is a refusal or an unbounded agent.
 */
export function actionCapsForRiskTier(tier: AgentRiskTier | null | undefined): {
    perRun: ActionCap;
    perDay: ActionCap;
} {
    if (tier === null || tier === undefined) return { perRun: 0, perDay: 0 };
    const perRun: number | undefined = MAX_ACTIONS_PER_RUN_BY_TIER[tier];
    const perDay: number | undefined = MAX_ACTIONS_PER_DAY_BY_TIER[tier];
    return {
        perRun: (perRun ?? 0) as ActionCap,
        perDay: (perDay ?? 0) as ActionCap,
    };
}

/**
 * ── POLICY-CARD DEFAULTS. WIRED (5/10). ─────────────────────────────
 *
 * 5/10 built the per-agent policy card, and THIS is where its defaults come
 * from, so that opening a card on a HIGH agent starts from what the assessment
 * already decided rather than from a blank form somebody fills in from memory.
 *
 * Wired by: 5/10, in `seedPolicyCardValue` (`policy-card-evaluation.ts`), which
 * is the only place a card's opening state is built.
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
    const budgets = actionCapsForRiskTier(tier);
    return {
        maxAutonomyLevel: unscored ? DENY_CEILING : ceilingForRiskTier(tier),
        requireSecondApprover: review.requireSecondApprover,
        allowAutoApproval: review.autoApprovable,
        assessmentRequired: unscored,
        maxActionsPerRun: budgets.perRun,
        maxActionsPerDay: budgets.perDay,
    };
}
