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
 * `admin.agent_registry` is deliberately NOT among them, and since #3710 that
 * needs saying more carefully. The page renders for the INVENTORY read — the
 * read-only view key, or the register key — so a tab may no longer assume the
 * register key. The SHELL decides instead: it disables every tab whose read is
 * gated on that key (`AgentDetailPermissions.canReadRegistry`) for a reader who
 * lacks it, so a tab that mounts may still assume it, and no tab's signature
 * carries it.
 */

/** Overview (status moves) and Risk assessment. */
export interface RegistryWritableTabProps extends AgentTabProps {
    /**
     * Whether this principal may CHANGE the register, not merely read it. The
     * read/write split this prop was named to absorb landed in #3710: a reader
     * holding only the view key opens the page with this false.
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
     * Every gate closing a breaker passes, asked on the server by
     * `agentRegisterAffordances` (#4471): the edge, `admin.agent_registry`, and
     * `assertAgentGovernanceAdmin(ctx, 'agent_registry')` — the coarse admin
     * tier OR the register key — which `closeAgentCircuitBreaker` asserts.
     * The coarse tier alone withheld the button from the built-in AI admin,
     * whom the server accepts.
     *
     * Reading the breaker needs none of it: that GET is the register key,
     * which the page has already required.
     */
    canCloseBreaker: boolean;
    /**
     * `admin.agent_kill_switch` behind the edge — the kill-switch list route's
     * own gates — so the history below the breaker is fetched only by a reader
     * that route admits. Defaults to `canCloseBreaker`, which it used to be.
     */
    canReadKillHistory?: boolean;
}

/** Skills. The tab's read is the register key the page already required. */
export interface SkillsTabProps extends AgentTabProps {
    /**
     * `admin.agent_skill_review` (#3680): author, edit, evaluate, submit,
     * approve, reject and retire the WORKSPACE's own skills. The repository
     * corpus is read-only whatever this says. Optional and false by default, so
     * a caller that does not thread it renders the tab read-only.
     */
    canReviewSkills?: boolean;
    /**
     * `admin.agent_skill_author` (#3778): create a workspace skill, edit it
     * into a new version, attach its evaluation record and submit it. The
     * review acts above stay on `canReviewSkills`; a holder of only this half
     * authors and is offered no approval.
     */
    canAuthorSkills?: boolean;
}

/**
 * Behaviour (Step 1b of `docs/claude-agent-sdk-design.md`, #4144). The tab's
 * read and every act take `admin.agent_registry`, which the shell requires
 * before it enables the tab, and it exists only while `AGENT_PROFILES` is on.
 */
export interface BehaviourTabProps extends AgentTabProps {
    /**
     * A retired agent's profile cannot change: the usecase refuses
     * `AGENT_RETIRED` to a new version, a submission and an approval, so the
     * tab offers none of them. Rejecting a version still open stays available,
     * because it puts nothing in force.
     */
    retired: boolean;
}
