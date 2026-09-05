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
 *     effective = min( key.maxAutonomyLevel , agent.autonomyLevel [ , tierCap ] )
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
 *     running. See `ceilingForRiskTier` below — it is the 3/10 seam and it is
 *     written so that getting this backwards requires deleting a line rather
 *     than forgetting one.
 *
 * An absent NARROWING is not an absent ASSESSMENT. Reading either null like the
 * other is the whole hazard, which is why they are stated together here rather
 * than in two files that never meet.
 */
import type { AgentRiskTier } from '@prisma/client';

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
 * ── THE 3/10 SEAM. READ THIS BEFORE WIRING IT. ──────────────────────
 *
 * 3/10 introduces the operational risk scorer, and the scored `riskTier` will
 * CAP how far an agent may be driven regardless of its registered autonomy. That
 * cap composes here, as one more term inside the same `min`.
 *
 * **A NULL tier MUST resolve to `DENY_CEILING`, never to a low tier.** NULL is
 * UNSCORED — the state between insert and the first scoring run — and an agent
 * nobody has assessed is the one that should not be running. Mapping it to "LOW"
 * would be the exact inversion: the least-assessed agent would get the
 * friendliest treatment, and nothing downstream would look wrong. This function
 * encodes that direction TODAY and is unit-tested for it, so 3/10 inherits the
 * decision rather than re-making it.
 *
 * It is deliberately NOT wired into `resolveAutonomyCeiling`'s live call site
 * yet. Every agent in the register currently has `riskTier = NULL`, because
 * `createRegisteredAgent` leaves it unscored on purpose and the scorer does not
 * exist — so folding this in before the scorer ships would take the entire MCP
 * surface dark for every tenant, which is a product outage rather than a
 * control. The call site passes `RISK_TIER_CEILING_UNWIRED` and says so; 3/10
 * replaces that one argument with `ceilingForRiskTier(agent.riskTier)` after the
 * scorer backfills, and nothing else in the funnel moves.
 *
 * The scored tiers return `UNCLAMPED` because the tier→rung table is 3/10's
 * decision to make, not this commit's. Only the NULL direction is settled here.
 */
export function ceilingForRiskTier(tier: AgentRiskTier | null | undefined): number {
    if (tier === null || tier === undefined) return DENY_CEILING;
    return UNCLAMPED;
}

/**
 * What the live call site passes for the tier term until 3/10 lands. Named
 * rather than spelled `UNCLAMPED` inline so the seam is greppable and so
 * deleting it is a compile error rather than a silent no-op.
 */
export const RISK_TIER_CEILING_UNWIRED = UNCLAMPED;

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
     * The 3/10 tier cap. Pass `RISK_TIER_CEILING_UNWIRED` until the scorer
     * ships; pass `ceilingForRiskTier(agent.riskTier)` after it does.
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
