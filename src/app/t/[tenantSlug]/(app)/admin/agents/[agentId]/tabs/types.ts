/**
 * The seam every agent-detail tab plugs into.
 *
 * Each tab OWNS ITS OWN FETCH. It is given the two identifiers and nothing
 * else, deliberately: the alternative — the shell fetching everything and
 * threading props down — makes six independently-failing endpoints into one
 * page that is blank whenever any of them is down, and makes every tab a
 * reason to edit the shell. A tab that cannot load says so in its own panel
 * while the rest of the page keeps working.
 */
export interface AgentTabProps {
    tenantSlug: string;
    agentId: string;
    /** Bumped by the shell after a mutation elsewhere on the page. */
    refreshToken?: number;
    /**
     * Call after a mutation that other tabs would care about — suspending the
     * agent, pulling the breaker, activating a card. The shell bumps
     * `refreshToken` for every tab rather than routing the news, so a tab
     * never has to know who else is listening.
     */
    onChanged?: () => void;
}
