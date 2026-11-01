/**
 * WHAT AN AGENT CREDENTIAL CAN DO RIGHT NOW (#4879).
 *
 * `/admin/mcp` answers "what can act right now, and what have we switched
 * off". It used to answer with the KEY's state alone, so a key bound to a
 * suspended agent, or behind an engaged kill switch, read "Live" although the
 * agent tools refuse it — and since #4481 the REST API refuses it too.
 *
 * This is the answer the page shows, decided in the order the agent tools
 * decide it, from the same facts:
 *
 *   1. A revoked or expired key does nothing (`inactive`).
 *   2. The registration gate (`agent-registration-gate.ts`): when the workspace
 *      requires registered agents, a key bound to no agent, to an agent that
 *      no longer resolves, or to an agent that is not ACTIVE is refused.
 *   3. The kill switch (`kill-switch.ts`): a platform or workspace kill stops
 *      every credential; an agent's own kill stops the credentials its agent
 *      GOVERNS — the funnel reads the kill for `governedAgentIdOf(verdict)`, so
 *      a draft or retired agent's kill does not reach a key it does not govern.
 *   4. A suspended agent's calls are refused at the tool boundary.
 *   5. An ACTIVE agent nobody has risk-assessed reaches nothing (the ceiling is
 *      `DENY_CEILING`).
 *
 * What is left either acts under its agent's controls (`governed`), or acts at
 * the agent tools with none of an agent's controls (`ungoverned`) — a key bound
 * to no agent, or to a draft, retired or removed agent, in a workspace that
 * does not require registered agents. That second case is not a stop, and
 * saying "Live" for it would hide the widest answer the page can give.
 *
 * `governed` mirrors `governedAgentIdOf`: ACTIVE and SUSPENDED agents govern
 * their keys, DRAFT, RETIRED and removed ones do not. The ceiling is computed
 * from the same rule (`agentTermsApply`), so the number the page shows is the
 * number the funnel enforces.
 *
 * Pure, with type-only imports, so it is unit-tested without a database.
 *
 * @module lib/agentic/agent-credential-standing
 */
import type { AgentStatus } from '@prisma/client';

/** Why a live key cannot act at the agent tools. */
export type AgentCredentialStop =
    | 'NOT_REGISTERED'
    | 'AGENT_REMOVED'
    | 'AGENT_DRAFT'
    | 'AGENT_SUSPENDED'
    | 'AGENT_RETIRED'
    | 'KILL_PLATFORM'
    | 'KILL_TENANT'
    | 'KILL_AGENT'
    | 'UNASSESSED';

/** Why a live key acts with none of an agent's controls. */
export type AgentCredentialUngoverned = 'NO_AGENT' | 'AGENT_REMOVED' | 'AGENT_DRAFT' | 'AGENT_RETIRED';

export type AgentCredentialStanding =
    | { kind: 'inactive' }
    | { kind: 'stopped'; reason: AgentCredentialStop }
    | { kind: 'ungoverned'; reason: AgentCredentialUngoverned }
    | { kind: 'governed' };

export interface AgentCredentialFacts {
    /** Neither revoked nor expired. */
    live: boolean;
    /** The key's bound agent id, or `null` when it is bound to none. */
    agentId: string | null;
    /**
     * The bound agent as the register holds it, or `null` when the key is bound
     * to none OR the row no longer resolves (soft-deleted). `agentId` tells the
     * two apart.
     */
    agent: { status: AgentStatus; riskTier: string | null } | null;
    /** Whether the workspace requires registered agents. */
    enforcing: boolean;
    /** The kills in force: platform, workspace, and per-agent. */
    kills: { platform: boolean; tenant: boolean; agentIds: ReadonlySet<string> };
}

/**
 * Does the agent's own row narrow this key at the tool boundary? The same
 * answer `governedAgentIdOf` gives, keyed on the status rather than the
 * verdict. Total over `AgentStatus`, so a new status fails to compile here.
 */
const GOVERNS: Readonly<Record<AgentStatus, boolean>> = {
    ACTIVE: true,
    SUSPENDED: true,
    DRAFT: false,
    RETIRED: false,
};

const REFUSED_WHEN_ENFORCING: Readonly<Record<AgentStatus, AgentCredentialStop | null>> = {
    ACTIVE: null,
    SUSPENDED: 'AGENT_SUSPENDED',
    DRAFT: 'AGENT_DRAFT',
    RETIRED: 'AGENT_RETIRED',
};

/** Whether the agent's autonomy and risk-tier terms apply to this key. */
export function agentTermsApply(agent: AgentCredentialFacts['agent']): boolean {
    return agent !== null && GOVERNS[agent.status];
}

export function agentCredentialStanding(facts: AgentCredentialFacts): AgentCredentialStanding {
    if (!facts.live) return { kind: 'inactive' };

    const { agent, agentId, enforcing, kills } = facts;

    // 2. The registration gate.
    if (agentId === null) {
        if (enforcing) return { kind: 'stopped', reason: 'NOT_REGISTERED' };
    } else if (agent === null) {
        if (enforcing) return { kind: 'stopped', reason: 'AGENT_REMOVED' };
    } else if (enforcing) {
        const refusal = REFUSED_WHEN_ENFORCING[agent.status];
        if (refusal) return { kind: 'stopped', reason: refusal };
    }

    // 3. The kill switch.
    if (kills.platform) return { kind: 'stopped', reason: 'KILL_PLATFORM' };
    if (kills.tenant) return { kind: 'stopped', reason: 'KILL_TENANT' };
    const governs = agentTermsApply(agent);
    if (governs && agentId !== null && kills.agentIds.has(agentId)) {
        return { kind: 'stopped', reason: 'KILL_AGENT' };
    }

    if (agentId === null) return { kind: 'ungoverned', reason: 'NO_AGENT' };
    if (agent === null) return { kind: 'ungoverned', reason: 'AGENT_REMOVED' };

    // 4. Suspension.
    if (agent.status === 'SUSPENDED') return { kind: 'stopped', reason: 'AGENT_SUSPENDED' };
    if (agent.status === 'DRAFT') return { kind: 'ungoverned', reason: 'AGENT_DRAFT' };
    if (agent.status === 'RETIRED') return { kind: 'ungoverned', reason: 'AGENT_RETIRED' };

    // 5. An ACTIVE agent nobody has assessed reaches nothing.
    if (agent.riskTier === null) return { kind: 'stopped', reason: 'UNASSESSED' };
    return { kind: 'governed' };
}
