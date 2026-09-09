/**
 * The seam every agent-detail tab plugs into.
 *
 * Each tab OWNS ITS OWN FETCH. It is given the two identifiers and nothing
 * else, deliberately: the alternative — the shell fetching everything and
 * threading props down — makes six independently-failing endpoints into one
 * page that is blank whenever any of them is down, and makes every tab a
 * reason to edit the shell. A tab that cannot load says so in its own panel
 * while the rest of the page keeps working.
 *
 * This file is a SINGLE-WRITER SEAM. Six lanes build against it in parallel,
 * so a widening after they start is a six-way conflict on the one file none
 * of them owns. Everything a tab could plausibly need is here already; a lane
 * that finds it needs more should say so rather than add it.
 */
export interface AgentTabProps {
    /**
     * Kept even though `useTenantApiUrl()` supplies it to anything inside the
     * tenant provider: a tab that renders a `<Link>` out to a Finding or an
     * Evidence row needs the slug in hand, and one prop is cheaper than six
     * lanes each discovering the hook separately.
     */
    tenantSlug: string;
    agentId: string;
    /**
     * Bumped by the shell after a mutation elsewhere on the page.
     *
     * Reads go through `useTenantSWR`, whose key is the URL and therefore does
     * not change when a sibling tab mutates something. Bridge it in exactly
     * these three lines, the same three lines in every tab:
     *
     *     const { data, error, isLoading, mutate } =
     *         useTenantSWR<Payload>(`/admin/agents/${agentId}/...`);
     *     useEffect(() => { void mutate(); }, [refreshToken, mutate]);
     *
     * It fires once on mount as well, which SWR dedupes inside its 5s window —
     * cheaper than a `useRef` dance to skip the first run, and still correct if
     * that dedupe window ever changes.
     */
    refreshToken?: number;
    /**
     * Call after a mutation that other tabs would care about — suspending the
     * agent, pulling the breaker, activating a card. The shell bumps
     * `refreshToken` for every tab rather than routing the news, so a tab
     * never has to know who else is listening.
     *
     * Fire it ONLY on `res.ok`. A failed write that revalidates every sibling
     * tells five other panels something changed when nothing did.
     */
    onChanged?: () => void;
}

/**
 * Permission flags, resolved on the server and threaded down rather than
 * re-derived per tab.
 *
 * Each interface below names ONE key, and only the tabs gated by that key
 * extend it. A tab that cannot see a flag cannot accidentally gate on the
 * wrong one, and a lane reading its own props knows without asking which
 * authority it is holding.
 *
 * `admin.agent_registry` is deliberately NOT among them: the page refuses to
 * render without it, so every tab that mounts may assume it. A flag every tab
 * would receive as `true` is not a flag, it is noise in six signatures.
 */

/** Overview (status moves) and Risk assessment. */
export interface RegistryWritableTabProps extends AgentTabProps {
    /**
     * Whether this principal may CHANGE the register, not merely read it.
     * Identical to the page-level gate today, and named separately anyway:
     * splitting read from write is the expected next move on that key, and
     * this is the prop that absorbs it when it lands.
     */
    canManageRegistry: boolean;
}

/** Policy card. Gated by `admin.agent_policy_card` — the GET too. */
export interface PolicyCardTabProps extends AgentTabProps {
    /**
     * FALSE means the tab is unreachable, not read-only: the route rule
     * carries no `methods` restriction, so the GET 403s as well. The shell
     * disables the tab, and this flag is what the lane checks before it
     * fetches at all — belt and braces, because a disabled tab is a UI state
     * and a 403 is a fact.
     */
    canEditPolicyCard: boolean;
}

/** Tools. Gated by `admin.agent_tool_exposure` — the GET too. */
export interface ToolsTabProps extends AgentTabProps {
    /** Same shape as the policy card's flag: absent means no read either. */
    canGrantTools: boolean;
}

/** Circuit breaker. */
export interface CircuitBreakerTabProps extends AgentTabProps {
    /**
     * `admin.agent_registry` AND the role-tier `canAdmin`, ANDed on the server.
     *
     * `closeAgentCircuitBreaker` calls `assertCanAdmin` on top of the route
     * gate, and `canAdmin` comes from the membership's BASE ROLE rather than
     * the permissions blob. A custom role with baseRole EDITOR can hold
     * agent_registry, pass the route, and still be refused inside the usecase —
     * so gating this button on the route key alone renders a control that
     * 403s for the very person it rendered for.
     *
     * Reading the breaker needs neither: that GET is the register key, which
     * the page has already required.
     */
    canCloseBreaker: boolean;
}
