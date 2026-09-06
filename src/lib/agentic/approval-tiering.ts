/**
 * HOW MANY HUMANS SIGN, and which humans may not.
 *
 * `AgentProposal` is the propose-not-commit queue: an agent proposes, a human
 * approves, and only then does the real create-usecase run. That control is
 * correct in DESIGN and, until this module, UNMEASURED IN PRACTICE — one
 * reviewer, any reviewer, any volume. A queue rubber-stamped under load is
 * WORSE than no queue: it manufactures an auditable record of consent nobody
 * actually gave, which is OWASP ASI09 (human-agent trust exploitation) written
 * as a feature.
 *
 * This module answers one question and nothing else: given a proposal, HOW MANY
 * DISTINCT HUMANS must sign it, and may the agent's accountable owner be one of
 * them. It is pure — no Prisma, no logging — so the same answer is available to
 * the propose seam, to the review usecase and (were a surface to want it) to a
 * client bundle.
 *
 * ## The three inputs already existed. None of them is invented here.
 *
 *   • `AgentPolicyCardVersion.approvalRung` — the operator's own declaration,
 *     on the version PINNED to the proposal. `policy-card.ts` says of that
 *     column: "declared and pinned so that when 8/10 builds the review queue,
 *     the queue reads the version that was in force when the proposal was made
 *     rather than the one in force when somebody got round to reviewing it."
 *     This is 8/10, and that is what it reads.
 *   • `RegisteredAgent.riskTier`, through `reviewRequirementForRiskTier` —
 *     which `risk-tier-consequences.ts` labels, in the source, as the seam
 *     8/10 must call rather than growing a second opinion about what HIGH
 *     means. This is that call.
 *   • `RegisteredAgent.autonomyLevel`, against the existing
 *     `UNATTENDED_AUTONOMY` rung — "the rung at which an agent is operating
 *     without a human in the loop".
 *
 * ## WHICH ONE IS AUTHORITATIVE WHEN THEY DISAGREE — none of them
 *
 * The question assumes a precedence order, and picking one would be the bug.
 * Every term here is a NARROWING TERM over the same quantity, exactly as
 * `resolveAutonomyCeiling` composes its three: the answer is the STRICTEST
 * term, so no term can widen and no term can be routed around.
 *
 * The alternatives were considered and each fails in a direction somebody would
 * eventually exploit:
 *
 *   • "The card wins." The card is operator-editable. A tenant that scored an
 *     agent CRITICAL could then set the card to `AUTO_APPROVAL` and delete the
 *     assessment's only consequence, while the assessment page went on saying
 *     CRITICAL. The card would become the way to un-say the tier.
 *   • "The tier wins." Then an operator who deliberately narrowed a LOW agent's
 *     card to `SECOND_APPROVER` — the one direction the ladder lets them move
 *     freely — would find the narrowing had no effect. A control that ignores
 *     the direction it is supposed to encourage is a control people stop using.
 *
 * Taking the strictest satisfies both, and it means an operator can always make
 * this stricter and never looser than the assessment says.
 *
 * ## ABSENCE, AND WHY IT IS THREE STATES RATHER THAN ONE
 *
 * The instruction the whole subsystem keeps repeating: an agent with NO card
 * must not end up MORE permissive than one with a card. But "no card" is not
 * one fact here, it is three, and collapsing them is how a gap becomes a
 * bypass. `policyCardVersion` already distinguishes them (see
 * `policy-card-pin.ts`) and this module keeps the distinction:
 *
 *   NULL (`UNPINNED`)   — the row predates pinning. We do not know what
 *                         governed it ⇒ the strictest rung. Same direction
 *                         `reviewRequirementForRiskTier` takes for an
 *                         unrecognised tier.
 *   0    (`NO_CARD`)    — the question was asked and the answer was "none".
 *                         The card contributes no term, but it is CAPPED at
 *                         `SINGLE_APPROVER`: `AUTO_APPROVAL` is a positive
 *                         declaration and nobody made it. So an absent card can
 *                         never be looser than the loosest card that exists,
 *                         which is precisely the required direction.
 *   >= 1 (`PINNED`)     — the version's own rung, or the strictest rung when
 *                         that version row cannot be read. A card that exists
 *                         but is unreadable is a BROKEN policy, not an absent
 *                         one — the same call `loadPolicyCardInForce` makes
 *                         when its head points at a missing version.
 *
 * ## AND A FOURTH ABSENCE, WHICH IS THE ONE THAT WOULD HAVE BEEN THE BYPASS
 *
 * A proposal can carry NO AGENT AT ALL (`agentId` NULL). Reading that as "an
 * agent whose card is missing" would be wrong in both directions, so it is
 * split by WHO WROTE THE ROW:
 *
 *   • Written through an API KEY with no agent resolved — a machine principal
 *     the register does not know. That is only producible with the agent
 *     registration gate OFF, and if turning that gate off also DOWNGRADED the
 *     approval requirement, the gate would be a lever for widening authority.
 *     It is the strictest rung.
 *   • Written by a session user — the in-product assistant, a human at a
 *     keyboard. There is no agent, so none of the agent terms have an input,
 *     and there is no registered owner to exclude. One human must still
 *     approve; it can never be `AUTO_APPROVAL`.
 */
import type { AgentRiskTier } from '@prisma/client';

import { UNATTENDED_AUTONOMY } from './agent-risk-scoring';
import { APPROVAL_LADDER, type ApprovalRung } from './policy-card';
import { reviewRequirementForRiskTier } from './risk-tier-consequences';

/** The strictest rung on the ladder — index 0, stated once. */
const STRICTEST: ApprovalRung = APPROVAL_LADDER[0];

/**
 * How many distinct humans a proposal needs when nothing is known about it.
 *
 * The value NULL `AgentProposal.requiredApprovals` reads as, at every consumer
 * including the database trigger. A row written before this column existed did
 * not have its requirement computed, and an uncomputed requirement must not be
 * the cheapest one.
 */
export const UNKNOWN_REQUIREMENT_APPROVALS = 2;

/** Which declaration set the answer. Written into the audit row. */
export type ApprovalTermName =
    | 'POLICY_CARD'
    | 'NO_POLICY_CARD'
    | 'UNKNOWN_POLICY_CARD_PIN'
    | 'RISK_TIER'
    | 'AUTONOMY_LEVEL'
    | 'UNREGISTERED_MACHINE_PRINCIPAL'
    | 'HUMAN_AUTHOR';

/** The three states of `AgentProposal.policyCardVersion`, named. */
export type ApprovalPinState = 'UNPINNED' | 'NO_CARD' | 'PINNED';

export interface ApprovalTierInputs {
    /**
     * The proposing agent as the register holds it, or `null` when the register
     * produced nothing. `riskTier` NULL means UNSCORED — never "low".
     */
    agent: { riskTier: AgentRiskTier | null; autonomyLevel: number } | null;
    /**
     * Did the ROW name an agent at all?
     *
     * ── THE THIRD NULL, and `autonomy-ceiling.ts` already paid for this one ──
     *
     * That module's header names two nulls that mean opposite things, and then
     * records that wiring the tier term surfaced a THIRD — "no agent resolved at
     * all" — which takes the product dark if it is read as either of the others.
     * The same three states exist here and this flag is what separates the
     * middle one:
     *
     *   named=false, agent=null — the row has no agent. A human at a keyboard,
     *                             or a pre-register row.
     *   named=true,  agent=null — the row NAMES an agent the register cannot
     *                             produce. That is a broken attribution, not an
     *                             absent one, and it gets the strictest rung.
     *   named=true,  agent=set  — the ordinary case; the agent terms apply.
     */
    agentNamed: boolean;
    /** Which of the three pin states this proposal's `policyCardVersion` is in. */
    pinState: ApprovalPinState;
    /**
     * The rung declared by the PINNED version, or `null` when `pinState` is
     * `PINNED` and that version row could not be read. Ignored in the other two
     * pin states, which have their own terms.
     */
    pinnedRung: ApprovalRung | null;
    /** Was the row written through a machine credential rather than a session? */
    viaApiKey: boolean;
}

export interface ApprovalRequirement {
    /** The composed rung — the strictest of every term that applied. */
    rung: ApprovalRung;
    /** How many DISTINCT humans must record an approval. */
    requiredApprovals: number;
    /** The term that set it. */
    decidedBy: ApprovalTermName;
    /**
     * May the agent's registered owner be one of the approvers?
     *
     * FALSE for anything needing two, and the rule is a SET property — "the
     * owner is not among the approvers" — not an ordinal one. "The SECOND
     * approver must not be the owner" sounds equivalent and is not: with two
     * approvals {owner, other}, which one is "the second" is decided by
     * insertion order, and insertion order is chosen by whoever approves first.
     * An ordering-dependent four-eyes rule is bypassed by controlling the
     * ordering. The set form cannot be, and it strictly implies the ordinal one.
     */
    ownerMayApprove: boolean;
}

/** Rung index, with an unrecognised value sorted to the STRICTEST rung. */
function rungIndex(rung: ApprovalRung): number {
    const i = (APPROVAL_LADDER as readonly string[]).indexOf(rung);
    return i === -1 ? 0 : i;
}

/**
 * How many humans a rung means, today.
 *
 * `AUTO_APPROVAL` yields ONE, not zero, and the reason is worth stating rather
 * than leaving as an apparent bug: nothing in this product auto-approves a
 * proposal. There is no rule engine on this queue. The rung is a DECLARATION
 * that one may be built, and mapping it to zero here would ship the permission
 * before the mechanism — an agent's writes committing with nobody in the loop
 * because a column said they could. When that engine exists it reads the rung;
 * until then the rung costs one human, exactly like `SINGLE_APPROVER`.
 */
export function approvalsRequiredFor(rung: ApprovalRung): number {
    return rungIndex(rung) === 0 ? 2 : 1;
}

/**
 * The requirement for one proposal — the strictest of every term that applies.
 *
 * Pure, total, and fail-closed on every absence. Called ONCE, at the propose
 * seam, and its answer is PINNED onto the row (`AgentProposal.requiredApprovals`)
 * for the same reason the policy-card version is pinned: re-deriving it at
 * review time would read a card the operator may have edited in between, and
 * "what was required when this was proposed" is the question an incident review
 * asks.
 */
export function resolveApprovalRequirement(inputs: ApprovalTierInputs): ApprovalRequirement {
    const terms: { name: ApprovalTermName; rung: ApprovalRung }[] = [];

    if (inputs.agent === null) {
        // No agent resolved. WHICH absence it is decides the answer — see the
        // header's fourth absence and `agentNamed` above. A row that names an
        // agent the register cannot produce is treated exactly like an
        // unregistered machine principal: something drove this queue that the
        // register does not account for.
        terms.push(
            inputs.agentNamed || inputs.viaApiKey
                ? { name: 'UNREGISTERED_MACHINE_PRINCIPAL', rung: STRICTEST }
                : { name: 'HUMAN_AUTHOR', rung: 'SINGLE_APPROVER' },
        );
    } else {
        // ── Term 1: the card pinned to this proposal ──────────────────
        if (inputs.pinState === 'UNPINNED') {
            terms.push({ name: 'UNKNOWN_POLICY_CARD_PIN', rung: STRICTEST });
        } else if (inputs.pinState === 'NO_CARD') {
            // Absence contributes no rung of its own but CAPS the result — it
            // can never be the thing that authorizes auto-approval.
            terms.push({ name: 'NO_POLICY_CARD', rung: 'SINGLE_APPROVER' });
        } else {
            terms.push({
                name: 'POLICY_CARD',
                rung: inputs.pinnedRung ?? STRICTEST,
            });
        }

        // ── Term 2: what the scored tier already decided ──────────────
        const review = reviewRequirementForRiskTier(inputs.agent.riskTier);
        terms.push({
            name: 'RISK_TIER',
            rung: review.requireSecondApprover
                ? STRICTEST
                : review.autoApprovable
                  ? 'AUTO_APPROVAL'
                  : 'SINGLE_APPROVER',
        });

        // ── Term 3: how far the register says it runs unattended ──────
        // Only ever narrows: below the rung it contributes the ladder's loosest
        // value, which is the identity of "strictest".
        terms.push({
            name: 'AUTONOMY_LEVEL',
            rung:
                inputs.agent.autonomyLevel >= UNATTENDED_AUTONOMY
                    ? STRICTEST
                    : 'AUTO_APPROVAL',
        });
    }

    const winner = terms.reduce((a, b) => (rungIndex(b.rung) < rungIndex(a.rung) ? b : a));
    const requiredApprovals = approvalsRequiredFor(winner.rung);

    return {
        rung: winner.rung,
        requiredApprovals,
        decidedBy: winner.name,
        ownerMayApprove: requiredApprovals < 2,
    };
}
