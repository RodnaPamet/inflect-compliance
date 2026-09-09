/**
 * Which OWASP agentic risks apply to THIS agent — the derivation, in isolation
 * from the database.
 *
 * THE PRINCIPLE, stated once and applied mechanically:
 *
 *   A risk is NOT_APPLICABLE for an agent only when a mandatory register column
 *   positively declares that the agent lacks the specific capability the risk's
 *   text names, and the platform enforces that lack server-side. Everything
 *   else is in scope.
 *
 * Fail-closed in both directions: an unknown code applies, an undeclared
 * property applies, an absent signal applies. Out-of-scope is never an ABSENCE
 * of information — it is always a column with a value. That is the whole
 * difference between this module and the `scopedToAgent` gate it replaces,
 * which read `false` on every real tenant because nothing ever wrote the row it
 * looked for, and so reported "does not apply" for ten risks nobody had
 * considered.
 *
 * TWO of the ten are gated. The other eight are universal because the risk text
 * names a property every registered agent demonstrably has — a base model in
 * its supply chain, an owner and a declared autonomy, a context it reasons
 * over — and the register holds no column that could switch any of them off.
 * Six universal rows is not the degenerate "scope that carries no information"
 * case: the two gated rows are false because a column says so, server-side, and
 * flip the instant an operator grants a tool or raises autonomy by one.
 *
 * KEYED ON THE CODE, NEVER ON THE PROSE. `FrameworkRequirement.description` is
 * NULL on every seeded database — `prisma/catalog-applier.ts` writes
 * `req.summary ?? null` and the ASI catalog fixture carries no `summary` key —
 * so a rule that read the text would silently gate nothing. The code is the
 * stable external identifier an assessor cites; it is also an EDITORIAL FACT
 * about somebody else's taxonomy, which is why `GATED_RISK_TITLES` exists and
 * why `tests/guardrails/agent-risk-applicability-codes.test.ts` fails the build
 * if the shipped title for a gated code ever stops matching what this rule
 * assumes. This repo already contains one fixture where exactly that drifted.
 *
 * TWO DELIBERATE OMISSIONS, both of which look like inputs and are not:
 *
 *   • The policy card. `AgentPolicyCard`'s `permittedTools = []` also denies
 *     every tool at the boundary, so it reads like a second ASI02 term. It is
 *     not one: a card can only NARROW what grants already allow, and an agent
 *     with no card at all must contribute no term (the register's own
 *     governance artefact must never be the thing that takes an agent dark).
 *     Adding it would make the gate fire on card ABSENCE, which is the exact
 *     absence-as-decision failure this module exists to avoid.
 *   • `status` and `riskTier`. A SUSPENDED agent still has the exposure its
 *     register row declares, and an unscored one has not been looked at rather
 *     than been found harmless. Lifecycle and assessment freshness are real
 *     signals, but they are not applicability, and folding them in here would
 *     make a risk stop applying because somebody paused the agent.
 */

/** Why a risk does not apply — the register column that says so, by name. */
export type ApplicabilityBasis = 'NO_TOOL_GRANTS' | 'SUGGEST_ONLY';

/**
 * The agent's declared exposure, as the register holds it. Every field is
 * mandatory on every existing row (`autonomyLevel` is a CHECK-pinned Int with
 * no default, `isLegacyPlaceholder` defaults false, and a grant count is
 * computed at read time), so there is no "unset" state and nothing to backfill.
 */
export interface AgentExposureProfile {
    readonly autonomyLevel: number;
    readonly toolGrantCount: number;
    readonly isLegacyPlaceholder: boolean;
    /**
     * Whether this tenant actually requires registered agents
     * (`TenantSecuritySettings.requireRegisteredAgent`, absent row ⇒ true).
     *
     * Not lifecycle dressed up as applicability — it is the precondition the
     * ASI02 exemption rests on. `isToolExposed` consults the grant allowlist
     * only when the caller resolves to a live ACTIVE agent; otherwise
     * `grantedTools` is `null` and it returns TRUE for every tool
     * (`src/lib/mcp/auth.ts`, `src/lib/mcp/authorize.ts`). In a tenant that has
     * switched the register off there is no agent binding at all, so an empty
     * grant list denies nothing and "no grants ⇒ no authorised-tool surface"
     * is simply false.
     */
    readonly registrationEnforced: boolean;
}

export type AgentRiskApplicability =
    | { readonly applicable: true; readonly basis: null }
    | { readonly applicable: false; readonly basis: ApplicabilityBasis };

export const APPLIES: AgentRiskApplicability = { applicable: true, basis: null };

/**
 * Does this agentic risk apply to this agent?
 *
 * ASI02 (Tool Misuse and Exploitation) is entirely about the agent's
 * AUTHORISED tools, and the grant list is a deny-by-default allowlist: for a
 * credential bound to a live ACTIVE agent, `isToolExposed` returns
 * `grantedTools.has(name)`, so an empty set denies every tool. The schema says
 * it outright — "EMPTY MEANS NONE… an agent nobody has granted anything to can
 * call nothing".
 *
 * That premise has a precondition, and the exemption carries it explicitly.
 * `grantedTools` is `null` whenever the caller is bound to no live ACTIVE
 * agent, and `isToolExposed` returns TRUE for null — allow-all, not deny-all.
 * So in a tenant that has switched the register off, the allowlist is never
 * consulted and an empty grant list denies nothing. Exempting ASI02 there would
 * excuse a risk that genuinely applies, which is why `registrationEnforced` is
 * part of the condition rather than a caveat in prose.
 *
 * Known and deliberately not solved here: `RegisteredAgentTool` has no
 * `deletedAt` — the schema calls a grant "authority, not history" — so revoking
 * the last grant puts ASI02 back OUT of scope and RAISES the coverage
 * percentage, with nothing recording that the grant existed. The derivation can
 * only ever describe the register as it stands now. That is disclosed in the
 * tab's copy rather than hidden behind a number.
 *
 * ASI08 (Cascading Failures) is about damage that "propagates through chained
 * agents and automated actions, amplifying damage faster than human oversight
 * can intervene". Rung 0 is "suggests only", and the LOWEST rung any capability
 * class requires is `read: 1` (`src/lib/agentic/autonomy-ceiling.ts`), so a
 * ceiling of 0 denies every tool call and every resource read. Such an agent
 * takes no automated action and can chain to nothing.
 *
 * The two terms are deliberately NOT merged. Grants are the ASI02 term and
 * autonomy is the ASI08 term; an autonomy-0 agent that somebody has granted a
 * tool to still has an authorised-tool surface to misuse, and an autonomy-3
 * agent with no grants still has an automated-action surface to cascade
 * through.
 */
export function agentRiskApplicability(
    code: string,
    profile: AgentExposureProfile,
): AgentRiskApplicability {
    // The migration inserts the placeholder as autonomy 6 / EXTERNAL_EGRESS /
    // TERMINAL with ZERO tool grants — worst-case on every axis the CHECK
    // constraints allow. Its zero grants mean "nobody ever granted anything to
    // a synthetic row", not "this agent can call nothing", so the ASI02 gate
    // must not fire on it. Every risk applies, unconditionally.
    if (profile.isLegacyPlaceholder) return APPLIES;

    switch (code) {
        case 'ASI02':
            return profile.toolGrantCount === 0 && profile.registrationEnforced
                ? { applicable: false, basis: 'NO_TOOL_GRANTS' }
                : APPLIES;
        case 'ASI08':
            return profile.autonomyLevel === 0
                ? { applicable: false, basis: 'SUGGEST_ONLY' }
                : APPLIES;
        default:
            // Fail-closed. An unknown code is IN scope: OWASP renumbering the
            // list, or a tenant installing an edition this build has never
            // seen, must not quietly excuse a risk from the readout.
            return APPLIES;
    }
}

/**
 * The shipped title each gated code MUST still carry, read by the guard test
 * against BOTH representations of the framework (the YAML library and the seed
 * fixture).
 *
 * This is not documentation. The rule above is keyed on `ASI02` and `ASI08`
 * because of what those codes MEAN in the shipped taxonomy; if OWASP renumbers
 * and the catalogue is updated, the codes keep resolving and the gate silently
 * moves to the wrong risks. The guard turns that into a red build.
 */
export const GATED_RISK_TITLES = {
    ASI02: 'Tool Misuse and Exploitation',
    ASI08: 'Cascading Failures',
} as const;
