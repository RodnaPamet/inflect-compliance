/**
 * PRE-EXECUTION EVALUATION of a policy card, and where a new card starts.
 *
 * ## Pre-execution, and why the distinction is the whole point
 *
 * Everything 1-4 built RECORDS what an agent did: the proposal queue, the run
 * narrative, the hash-chained audit trail, the receipts. A record is how you
 * find out. This is how you stop it — the card is evaluated inside
 * `authorizeToolCall`, in the same funnel every tool call already passes
 * through, BEFORE `tool.run` is reached. A violation is a refusal, not a note.
 *
 * A status code cannot tell the two designs apart: post-hoc detection and
 * pre-execution prevention both answer the next request with a 403. The
 * property is "the tool function was never entered", and
 * `tests/unit/policy-card-evaluation.test.ts` asserts it the only way it can be
 * asserted — with a spy on the tool, checking it was never called.
 *
 * ## Two phases, because one of them costs a write
 *
 * `evaluateCardReach` answers everything that can be decided from the card, the
 * call and an in-memory counter. `evaluateCardDailyBudget` answers the one rule
 * that needs a durable, cross-process count, and that count is obtained by
 * INCREMENTING — a reservation, so two concurrent calls cannot both read the
 * same number and both be allowed.
 *
 * Reach runs first, and that ordering is deliberate: a call refused for naming
 * a tool the card does not permit must not spend a unit of the day's budget on
 * its way out, or a single misconfiguration would exhaust the agent's day and
 * the operator would be reading `DAILY_ACTION_CAP_EXCEEDED` while the actual
 * fault was `TOOL_NOT_PERMITTED`. Splitting the evaluator in two is what makes
 * that ordering expressible; a single function taking both counts would have to
 * be handed a number that was already spent.
 *
 * The split is two exported functions rather than one function with a nullable
 * count, because a nullable count skipped silently. A caller that only runs
 * phase one gets no daily cap, and that is visible at the call site as a
 * missing call rather than invisible as an omitted argument.
 */
import type { AgentDataAccessScope, AgentRiskTier } from '@prisma/client';

import { isKnownMcpTool, mcpToolCapabilityClass } from '@/lib/mcp/tool-catalogue';
import { baseDataScopeForTool } from '@/lib/mcp/tool-data-scope';

import { AUTONOMY_REQUIRED_BY_CAPABILITY, DENY_CEILING } from './autonomy-ceiling';
import { defaultPolicyCardForRiskTier } from './risk-tier-consequences';
import {
    APPROVAL_LADDER,
    POLICY_CARD_RULES,
    autonomyWithinCard,
    dataScopeWithinCard,
    type AgentPolicyCardValue,
    type ApprovalRung,
    type PolicyCardRule,
    type PolicyDataScope,
} from './policy-card';

/** The card version in force for one agent, as the boundary reads it. */
export interface PolicyCardInForce {
    cardId: string;
    /** The version number, pinned into every audit row this evaluation writes. */
    version: number;
    value: AgentPolicyCardValue;
}

/** What one tool call is asking for. */
export interface PolicyCardRequest {
    /**
     * The tool being called, or `null` for an MCP RESOURCE read.
     *
     * `null` skips the permitted-tool rule and ONLY that rule, for the reason
     * `authorizeResourceRead` already records about the exposure allowlist:
     * resources have no entries in the grantable catalogue, so there is nothing
     * for a tool list to name. The data rung, the autonomy rung and the budgets
     * all apply to a resource read exactly as they apply to a tool call.
     */
    tool: string | null;
    /** The data rung this call reaches — see `mcp/tool-data-scope.ts`. */
    dataScope: AgentDataAccessScope;
    /** The autonomy rung this call requires — see `autonomy-ceiling.ts`. */
    requiredAutonomy: number;
    /** How many calls this invocation has ALREADY made. Excludes this one. */
    actionsThisRun: number;
}

export type PolicyCardVerdict =
    | { allowed: true; cardVersion: number }
    | {
          allowed: false;
          cardVersion: number;
          /** WHICH declaration refused. Never merely "denied". */
          rule: PolicyCardRule;
          /** Is this one of the refusals the card asked to be woken for? */
          escalate: boolean;
          message: string;
          detail: Record<string, unknown>;
      };

function refuse(
    card: PolicyCardInForce,
    rule: PolicyCardRule,
    message: string,
    detail: Record<string, unknown>,
): PolicyCardVerdict {
    return {
        allowed: false,
        cardVersion: card.version,
        rule,
        escalate: card.value.escalationTriggers.includes(rule),
        message,
        detail,
    };
}

/**
 * Phase one — everything decidable without a write.
 *
 * Order: tool, then data rung, then autonomy rung, then the per-run budget.
 * Cheapest and most specific first, so the refusal an operator reads names the
 * narrowest thing that is actually wrong. A call for an ungranted tool that ALSO
 * exceeds the data rung should say the tool, because granting the tool is the
 * decision being asked for.
 */
export function evaluateCardReach(
    card: PolicyCardInForce,
    request: PolicyCardRequest,
): PolicyCardVerdict {
    const { value } = card;

    if (request.tool !== null && !value.permittedTools.includes(request.tool)) {
        return refuse(
            card,
            'TOOL_NOT_PERMITTED',
            `This agent's policy card (version ${card.version}) does not permit ` +
                `"${request.tool}". The card is the narrower of the two lists — granting ` +
                'the tool in the register is not enough on its own; widen the card to ' +
                'permit it.',
            { tool: request.tool, permittedTools: [...value.permittedTools] },
        );
    }

    if (!dataScopeWithinCard(request.dataScope, value.maxDataScope)) {
        return refuse(
            card,
            'DATA_SCOPE_EXCEEDED',
            `This call reaches ${request.dataScope}, and this agent's policy card ` +
                `(version ${card.version}) stops at ${value.maxDataScope}. The rung a ` +
                'call reaches can depend on its ARGUMENTS, so the same tool may be ' +
                'permitted with narrower ones.',
            {
                tool: request.tool,
                reached: request.dataScope,
                permitted: value.maxDataScope,
            },
        );
    }

    if (!autonomyWithinCard(request.requiredAutonomy, value.maxAutonomyLevel)) {
        return refuse(
            card,
            'AUTONOMY_EXCEEDED',
            `This call requires autonomy ${request.requiredAutonomy}, and this agent's ` +
                `policy card (version ${card.version}) caps it at ${value.maxAutonomyLevel}. ` +
                'This is the card, not the risk tier and not the key — the assessed ' +
                'ceiling is a separate term and is checked separately.',
            {
                tool: request.tool,
                required: request.requiredAutonomy,
                permitted: value.maxAutonomyLevel,
            },
        );
    }

    // `+ 1` because the count excludes the call being authorized: a cap of 25
    // must allow the 25th call and refuse the 26th, and off-by-one here is the
    // difference between a cap that binds and one that binds a call early.
    if (request.actionsThisRun + 1 > value.maxActionsPerRun) {
        return refuse(
            card,
            'RUN_ACTION_CAP_EXCEEDED',
            `This run has used its whole action budget: this agent's policy card ` +
                `(version ${card.version}) allows ${value.maxActionsPerRun} tool ` +
                'call(s) per run. Start a new run, or widen the per-run cap by one rung.',
            {
                tool: request.tool,
                used: request.actionsThisRun,
                permitted: value.maxActionsPerRun,
            },
        );
    }

    return { allowed: true, cardVersion: card.version };
}

/**
 * Phase two — the daily budget, against a count that INCLUDES this call.
 *
 * `actionsToday` is what the reservation returned, so the comparison is `>`
 * rather than `>= + 1`: the reservation already counted this call. Stated here
 * because the two phases use opposite conventions and the reason is not
 * guessable from the signature.
 */
export function evaluateCardDailyBudget(
    card: PolicyCardInForce,
    actionsToday: number,
): PolicyCardVerdict {
    if (actionsToday > card.value.maxActionsPerDay) {
        return refuse(
            card,
            'DAILY_ACTION_CAP_EXCEEDED',
            `This agent has used its whole action budget for today: its policy card ` +
                `(version ${card.version}) allows ${card.value.maxActionsPerDay} tool ` +
                'call(s) per UTC day. The budget resets at 00:00 UTC.',
            { used: actionsToday, permitted: card.value.maxActionsPerDay },
        );
    }
    return { allowed: true, cardVersion: card.version };
}

// ─── Where a new card starts ────────────────────────────────────────

/** What a fresh card is seeded from. */
export interface PolicyCardSeed {
    /** The agent's scored tier, or `null`/`undefined` when it is UNSCORED. */
    riskTier: AgentRiskTier | null | undefined;
    /**
     * The agent's own declared data-access axis, from the register. The card's
     * data ceiling starts exactly here — NOT at a tier-derived guess — because
     * the register already carries the operator's own statement of how far this
     * agent reaches, and a second number derived from the tier would be a
     * different answer to a question that already had one.
     */
    dataAccessScope: AgentDataAccessScope;
    /**
     * The tools granted to the agent TODAY. A new card starts by writing down
     * what is already true, so creating one changes nothing about what the agent
     * may do — it only pins it. A card seeded empty would take a working agent
     * dark the moment its governance artefact was created, which is the
     * composition failure this subsystem keeps naming.
     *
     * A grant the seeded ceilings could not exercise is the one exception, and
     * it is WITHHELD rather than permitted — see `withholdingReasonForTool`
     * below for why permitting it would be the worse of the two failures.
     */
    grantedTools: readonly string[];
}

// ─── One definition of "this card could never call that tool" ───────

/** Which ceiling a granted tool ran into. */
export type ToolWithholdingReason =
    /** The build does not offer this tool at all — a grant left behind by a deploy. */
    | 'NOT_IN_CATALOGUE'
    /** Its capability class needs an autonomy rung above the card's cap. */
    | 'AUTONOMY_ABOVE_CARD'
    /** Its BASE data rung — the one every call reaches — is above the card's ceiling. */
    | 'DATA_SCOPE_ABOVE_CARD';

/** A granted tool a card cannot permit, and the two numbers that say why. */
export interface WithheldTool {
    toolName: string;
    reason: ToolWithholdingReason;
    /** What the tool needs on EVERY call, in the failing axis's own units. */
    requires: string;
    /** What the card offers on that axis. */
    permits: string;
}

/** The two ceilings a card imposes on every call, whatever its arguments. */
export interface CardCeilings {
    maxDataScope: PolicyDataScope;
    maxAutonomyLevel: number;
}

/**
 * ── WHY THIS IS ONE FUNCTION AND NOT TWO ────────────────────────────
 *
 * A card that PERMITS a tool it also FORBIDS is a governance object that
 * refuses everything it declares. There are two ways to write one and they
 * used to be answered in two different places: the EDIT path threw
 * (`assertDeclarationsExercisable`), and the CREATE path did not check at all —
 * so creating a card could write exactly the state editing one calls
 * impossible, and the agent went dark at its next tool call with nobody told.
 *
 * The disagreement was possible because the rule was spelled once. It is now
 * spelled here, and both paths read it: create uses it as a FILTER (the seeded
 * card cannot contain a contradiction, because contradictions never enter it)
 * and edit uses it as a REFUSAL (an operator typing one is told at the moment
 * they type it). Same predicate, two dispositions — which is the honest shape,
 * because the two paths differ in whose decision is being judged. A seed is
 * assembled by the product from state that already exists; an edit is composed
 * by a person.
 *
 * ## The BASE rung, never the maximum
 *
 * `baseDataScopeForTool` deliberately answers the rung a tool reaches with NO
 * argument raising it. A ceiling below a tool's MAXIMUM is the useful case —
 * `get_framework_status` under a `READ_METADATA` card is a working catalogue
 * read whose tenant-coverage argument is refused. Only a ceiling below the BASE
 * makes the tool unreachable however it is called, and only that is a
 * contradiction.
 *
 * Returns `null` when the card can exercise the tool.
 */
export function withholdingReasonForTool(
    toolName: string,
    ceilings: CardCeilings,
): WithheldTool | null {
    if (!isKnownMcpTool(toolName)) {
        return {
            toolName,
            reason: 'NOT_IN_CATALOGUE',
            requires: 'a tool this build offers',
            permits: 'the live catalogue',
        };
    }

    const requiredAutonomy = AUTONOMY_REQUIRED_BY_CAPABILITY[mcpToolCapabilityClass(toolName)];
    if (!autonomyWithinCard(requiredAutonomy, ceilings.maxAutonomyLevel)) {
        return {
            toolName,
            reason: 'AUTONOMY_ABOVE_CARD',
            requires: String(requiredAutonomy),
            permits: String(ceilings.maxAutonomyLevel),
        };
    }

    const floor = baseDataScopeForTool(toolName);
    if (!dataScopeWithinCard(floor, ceilings.maxDataScope)) {
        return {
            toolName,
            reason: 'DATA_SCOPE_ABOVE_CARD',
            requires: floor,
            permits: ceilings.maxDataScope,
        };
    }

    return null;
}

/** What a fresh card opens at, and which grants could not come with it. */
export interface SeededPolicyCard {
    value: AgentPolicyCardValue;
    /**
     * Granted tools the seeded card does NOT permit, each with the ceiling it
     * ran into. NEVER silently dropped: this list is what the create usecase
     * returns to the caller and writes into the audit row, and what the GET
     * preview shows before anybody presses the button. A withheld tool is a
     * finding about the register — the grant and the agent's own declarations
     * disagree — and the operator is the only one who can settle it.
     */
    withheld: readonly WithheldTool[];
}

/**
 * The value a brand-new card opens at.
 *
 * Every field comes from a decision that ALREADY EXISTS somewhere:
 *
 *   • autonomy, approvals and the two budgets from
 *     `defaultPolicyCardForRiskTier` — 3/10's declared seam for exactly this,
 *     whose own docstring says the card's cap must be identical to
 *     `ceilingForRiskTier` for every tier rather than a second copy of it;
 *   • the data ceiling from the register's own axis;
 *   • the tool list from the grants that exist.
 *
 * Nothing here invents a number. That is the property to preserve if this
 * function grows: a default the card invents is a default nobody reviewed, and
 * it will differ from the one the boundary enforces.
 *
 * ## The tool list is the grants FILTERED BY the ceilings, and why
 *
 * The three bullets above are three independent sources, and nothing made them
 * agree. An agent declaring `READ_METADATA` that had been granted `list_risks`
 * seeded a card permitting a tool its own data ceiling refuses on every call:
 * legible in the register, deliberate-looking, and dark at runtime. The edit
 * path already refused to WRITE that card. So creation produced a state editing
 * called impossible.
 *
 * Three ways to close it, and only one of them is honest about what is wrong:
 *
 *   • SEED THE CEILING FROM THE TOOLS instead (the union of their base rungs).
 *     Rejected: it NARROWS a live agent. `get_framework_status` bases at
 *     `READ_METADATA` and reaches `READ_TENANT_DATA` with a `frameworkKey`, so
 *     a ceiling seeded from base rungs would take a working argument dark —
 *     creating the governance artefact would itself be the outage.
 *   • REFUSE TO CREATE THE CARD. Rejected: it makes the register's own
 *     contradiction into a reason the agent cannot be governed at all, and the
 *     operator's route back is to fix a register they may not own. A correct
 *     gate that bricks the product is still a broken change.
 *   • WITHHOLD THE TOOL AND SAY SO. Taken. The card is coherent by
 *     construction, the agent keeps every call it could actually make, and the
 *     grant that cannot be exercised is named to the operator at the moment
 *     they create the card rather than at the agent's next refusal.
 *
 * The withheld tool is NOT revoked and NOT hidden: its grant row stands, the
 * preview and the audit row both name it, and permitting it is two ordinary
 * ladder steps once the agent's declared axis is raised. Nothing is lost.
 *
 * UNSCORED fails closed on every axis at once: `DENY_CEILING` autonomy (below
 * rung 0, so no tool reaches it), `NONE` data, a zero budget and the strictest
 * approval rung — which means every grant is withheld. That is the same
 * statement the old empty-ceiling card made, said where somebody can read it:
 * the agent is inert because nobody has assessed it, and the tools it holds are
 * listed rather than written into a card that refuses them.
 */
export function seedPolicyCardValue(seed: PolicyCardSeed): SeededPolicyCard {
    const defaults = defaultPolicyCardForRiskTier(seed.riskTier);
    const unscored = defaults.assessmentRequired;

    const ceilings: CardCeilings = {
        maxDataScope: unscored ? 'NONE' : seed.dataAccessScope,
        maxAutonomyLevel: unscored ? DENY_CEILING : defaults.maxAutonomyLevel,
    };

    const permittedTools: string[] = [];
    const withheld: WithheldTool[] = [];
    for (const toolName of seed.grantedTools) {
        const reason = withholdingReasonForTool(toolName, ceilings);
        if (reason) withheld.push(reason);
        else permittedTools.push(toolName);
    }

    return {
        value: {
            permittedTools,
            ...ceilings,
            maxActionsPerRun: defaults.maxActionsPerRun,
            maxActionsPerDay: defaults.maxActionsPerDay,
            // A new card escalates on EVERY rule. Quieting one is a widening,
            // and goes up the ladder like every other widening — so the noisy
            // default is the one an operator has to deliberately turn down,
            // rather than the silent one they have to remember to turn up.
            escalationTriggers: [...POLICY_CARD_RULES],
            approvalRung: approvalRungFor(defaults),
        },
        withheld,
    };
}

/**
 * The seam's two booleans, mapped onto the three-rung ladder.
 *
 * The mapping is total and it is checked in the strict direction first: an agent
 * that needs a second approver gets the strictest rung whatever the other flag
 * says, so the fourth state the booleans can express ("second approver required
 * AND auto-approvable") resolves to the safe reading instead of being
 * unrepresentable in one direction and silently loose in the other.
 */
function approvalRungFor(defaults: {
    requireSecondApprover: boolean;
    allowAutoApproval: boolean;
}): ApprovalRung {
    if (defaults.requireSecondApprover) return APPROVAL_LADDER[0];
    return defaults.allowAutoApproval ? APPROVAL_LADDER[2] : APPROVAL_LADDER[1];
}
