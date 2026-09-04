/**
 * The autonomy ceiling — how far up the 0-6 ladder one invocation may reach.
 *
 * ## The question this answers
 *
 * `RegisteredAgent.autonomyLevel` says how autonomous an agent is REGISTERED to
 * be. Nothing consulted it. So an agent's authority travelled entirely with
 * whoever held one of its credentials: every key bound to that agent could drive
 * it to the full extent of its registration, and a key minted for a narrow
 * read-only integration was indistinguishable at the tool boundary from the one
 * the operator meant to be autonomous.
 *
 * The ceiling makes authority a property of the AGENT rather than of the bearer.
 * It is a MINIMUM over independent narrowing terms, so no term can widen:
 *
 *     effective = min( key.maxAutonomyLevel , agent.autonomyLevel , tierCap )
 *
 * and a tool refuses when the rung it requires is above the effective ceiling.
 *
 * ## The two nulls mean OPPOSITE things, and that is the trap
 *
 *   • `TenantApiKey.maxAutonomyLevel = NULL` means NO KEY-LEVEL NARROWING. It
 *     contributes no term. That is safe because the AGENT term is always present
 *     for an agent-bound credential, so the result is still bounded — and a
 *     column added to a populated table has to mean "unchanged" for the rows
 *     that predate it or the migration is a behaviour change in disguise.
 *
 *   • `RegisteredAgent.riskTier = NULL` means UNSCORED, and UNSCORED MUST MEAN
 *     DENY. An agent nobody has assessed is precisely the one that should not be
 *     running. See `ceilingForRiskTier` below, which encodes that direction and
 *     is wired into the live funnel — getting it backwards now requires
 *     deleting a line rather than forgetting one.
 *
 * An absent NARROWING is not an absent ASSESSMENT. Reading either null like the
 * other is the whole hazard, which is why they are stated together here rather
 * than in two files that never meet. A THIRD null joined them when the tier
 * term was wired — "no agent resolved at all" — and it is stated at
 * `riskTierCeilingFor` below.
 */
import type { AgentRiskTier } from '@prisma/client';

import { MAX_AUTONOMY_BY_TIER } from './agent-risk-scoring';

/** The ladder `RegisteredAgent.autonomyLevel` lives on, pinned by a CHECK. */
export const AUTONOMY_MIN = 0;
export const AUTONOMY_MAX = 6;

/**
 * A ceiling that admits nothing. Every tool requires at least rung 1, so this
 * refuses the whole surface — and it is BELOW `AUTONOMY_MIN` deliberately, so a
 * comparison written as `required <= ceiling` cannot let a rung-0 tool through
 * a deny.
 */
export const DENY_CEILING = -1;

/** A term that imposes no narrowing — the identity of `min`. */
export const UNCLAMPED = AUTONOMY_MAX;

/**
 * The rung CALLING a tool represents, by capability class.
 *
 *   0 — suggests to a human in session and reaches nothing itself. No MCP tool
 *       is at rung 0, so an agent registered at 0 can call nothing: that is the
 *       register's "suggests only" meaning it, not a rounding error.
 *   1 — READ. Pulls tenant data out on its own initiative.
 *   2 — PROPOSE. Drafts changes into the approval queue. Still human-gated, but
 *       it puts words in front of an approver, which is a different act.
 *   3 — ORCHESTRATE. Chains steps unattended between checkpoints.
 *
 * A tool may override with `authorize.autonomy`; this is the default its class
 * gets. Defaults rather than a required per-tool field because the class is
 * already declared data (`capability`) and 14 hand-written copies of "1" is 14
 * chances to write "6".
 */
export const AUTONOMY_REQUIRED_BY_CAPABILITY = {
    read: 1,
    propose: 2,
    orchestrate: 3,
} as const;

export type McpCapabilityClass = keyof typeof AUTONOMY_REQUIRED_BY_CAPABILITY;

/**
 * ── THE TIER CAP. WIRED (3/10). ─────────────────────────────────────
 *
 * A scored `riskTier` CAPS how far an agent may actually be driven, whatever
 * autonomy its registration claims. This is the term that makes the risk
 * assessment load-bearing rather than a questionnaire: coming out HIGH costs
 * the agent four rungs of the ladder, server-side, on every tool call.
 *
 * The per-tier numbers live with the SCORER (`MAX_AUTONOMY_BY_TIER` in
 * `agent-risk-scoring.ts`) because they are the assessment's MEANING; this file
 * owns only how the term composes. A tier missing from that table resolves to
 * `DENY_CEILING` rather than to no narrowing — a rung added to `AgentRiskTier`
 * without a cap must refuse, not admit.
 *
 * **A NULL tier resolves to `DENY_CEILING`, never to a low tier.** NULL is
 * UNSCORED — the state between insert and the first scoring run — and an agent
 * nobody has assessed is the one that should not be running. Mapping it to
 * "LOW" would be the exact inversion: the least-assessed agent would get the
 * friendliest treatment, and nothing downstream would look wrong.
 *
 * DO NOT call this with the tier of an agent that did not RESOLVE. See
 * `riskTierCeilingFor` immediately below — "there is no agent here" and "the
 * agent here is unscored" are different states, and this function only answers
 * the second.
 */
export function ceilingForRiskTier(tier: AgentRiskTier | null | undefined): number {
    if (tier === null || tier === undefined) return DENY_CEILING;
    const cap: number | undefined = MAX_AUTONOMY_BY_TIER[tier];
    return cap ?? DENY_CEILING;
}

/**
 * ── THE THIRD NULL, AND THE ONE THAT WOULD HAVE CAUSED THE OUTAGE ───
 *
 * The header above names two nulls that mean opposite things. Wiring the tier
 * term surfaced a THIRD, and it is the one that takes the product dark if it is
 * read as either of the others:
 *
 *   • NO AGENT RESOLVED AT ALL — a signed-in human, an ordinary integration
 *     key, or a tenant that has switched the register off. `evaluateAgent-
 *     Registration` reports this as `agentId === null`. There is no agent, so
 *     there is nothing to have assessed, so the tier contributes NO TERM. Read
 *     as "unscored" it would deny every non-agent caller on the MCP surface and
 *     every tenant that never turned the register on — the register's own
 *     switch doubling as a kill switch for the product, which is precisely what
 *     `agentAutonomy: null` is documented above as refusing to do.
 *
 *   • AN AGENT RESOLVED AND ITS TIER IS NULL — somebody registered it, somebody
 *     activated it, and nobody assessed it. That DENIES.
 *
 * Passing the resolved agent as an OBJECT-OR-NULL rather than as a bare tier is
 * what keeps those two apart at the type level: `null` here cannot be spelled
 * the same way as `{ riskTier: null }`.
 */
export type ResolvedAgentTier = { riskTier: AgentRiskTier | null | undefined } | null;

export function riskTierCeilingFor(agent: ResolvedAgentTier): number {
    // No agent in play — no term. NOT a deny; see above.
    if (agent === null) return UNCLAMPED;
    return ceilingForRiskTier(agent.riskTier);
}

export interface AutonomyCeilingTerms {
    /** `TenantApiKey.maxAutonomyLevel`. NULL contributes no term. */
    keyMax: number | null | undefined;
    /**
     * `RegisteredAgent.autonomyLevel`. NULL means there is no live registered
     * agent — the tenant has switched the register off, which is the same
     * opt-out the tool allowlist honours. It contributes no term for the same
     * reason: the register's switch controls the register, and must not double
     * as a kill switch for the product.
     */
    agentAutonomy: number | null | undefined;
    /**
     * The scored-tier cap. Build it with `riskTierCeilingFor(resolvedAgent)`,
     * never by reaching for a tier directly — the difference between "no agent"
     * and "an unscored agent" is the whole hazard, and that function is where
     * it is stated.
     */
    riskTierCeiling: number;
}

/**
 * The effective ceiling: the LOWEST of the terms that are present.
 *
 * Every absent term is skipped rather than defaulted to zero — a missing
 * narrowing must not itself be a narrowing, or adding a nullable column would
 * silently deny every existing credential.
 */
export function resolveAutonomyCeiling(terms: AutonomyCeilingTerms): number {
    const present: number[] = [terms.riskTierCeiling];
    if (typeof terms.keyMax === 'number') present.push(terms.keyMax);
    if (typeof terms.agentAutonomy === 'number') present.push(terms.agentAutonomy);
    return Math.min(...present);
}

/**
 * The rung a tool call requires: the tool's own declaration if it made one,
 * else its capability class's default.
 *
 * A class present in the type but ABSENT from the table above resolves to the
 * ORCHESTRATE rung — the highest — so a capability added without a default is
 * refused to low-autonomy agents rather than admitted to every one of them. The
 * lookup is written as a possibly-undefined read for exactly that reason: the
 * type says it cannot happen, and the fail direction is what decides whether
 * being wrong about that is a denial or a hole.
 */
export function requiredAutonomyFor(
    capabilityClass: McpCapabilityClass,
    declared?: number,
): number {
    if (typeof declared === 'number') return declared;
    const byClass: number | undefined = AUTONOMY_REQUIRED_BY_CAPABILITY[capabilityClass];
    return byClass ?? AUTONOMY_REQUIRED_BY_CAPABILITY.orchestrate;
}

/** Is this invocation permitted to reach that rung? */
export function withinCeiling(required: number, ceiling: number): boolean {
    return required <= ceiling;
}
