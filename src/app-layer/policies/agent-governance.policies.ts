/**
 * The coarse FLOOR of an agent-governance write (#3699).
 *
 * The agent usecases gate twice: the route's literal `requirePermission` on an
 * agent key (`admin.agent_registry`, `agent_policy_card`, `agent_tool_exposure`,
 * `agent_kill_switch`) is the authority, and inside the usecase a coarse floor —
 * `assertCanWrite` for the register, the card, the grants, the kill switch, the
 * risk assessment and parameter sets; `assertCanAdmin` for the circuit
 * breaker, the tool manifests, external tools and the concurrency cap.
 *
 * Both floors read `ctx.permissions`, which `computePermissions` derives from
 * the role LADDER. The built-in `AI_ADMIN` role sits on READER's rung on
 * purpose — a higher rung would admit it to every usecase that gates on the
 * coarse tier alone, which is most of the product's writes — so neither floor
 * would ever admit it, and a role created to run the agent register could not
 * register an agent.
 *
 * So the floor here is "the coarse tier, OR the agent key the route requires".
 * It is a strict SUPERSET of the floor it replaces: every caller the old
 * floor admitted it still admits, and the only callers it newly admits are
 * ones that hold the key that gates the operation — the AI_ADMIN role, and a
 * custom role on a READER or AUDITOR base that an OWNER or ADMIN holding that
 * key chose to give it (`permissionsExceeding` refuses a grant the grantor
 * does not hold). That is the same judgement the ownership transfer made in
 * #3698: the key is the authority, and the coarse tier comes from a custom
 * role's BASE role. `canRead` stays required, so a context with no read access
 * at all is refused whatever it holds.
 *
 * No API key reaches a newly-admitted branch: `scopesToPermissions` never
 * carries `agent_registry`, `agent_policy_card`, `agent_tool_exposure` or
 * `agent_kill_switch` (they are subtracted from `*`, and no scope maps to
 * them), and those are the keys this floor is asked about.
 *
 * The refusal messages are the old floors', word for word, so a caller that
 * matched on them is unaffected.
 */
import { forbidden } from '@/lib/errors/types';
import type { RequestContext } from '../types';

/** The agent keys a governance floor may be satisfied by. */
export type AgentGovernanceKey =
    | 'agent_registry'
    | 'agent_tool_exposure'
    | 'agent_policy_card'
    | 'agent_kill_switch';

function holdsAgentKey(ctx: RequestContext, key: AgentGovernanceKey): boolean {
    return ctx.permissions.canRead === true && ctx.appPermissions?.admin?.[key] === true;
}

/**
 * Does the caller clear the floor of an agent-governance WRITE? The boolean
 * `assertAgentGovernanceWrite` throws on, for a page that must offer an action
 * exactly where the usecase would take it.
 */
export function meetsAgentGovernanceWrite(ctx: RequestContext, key: AgentGovernanceKey): boolean {
    return Boolean(ctx.permissions.canWrite) || holdsAgentKey(ctx, key);
}

/**
 * The floor of an agent-governance WRITE: `canWrite`, or the agent key.
 * Replaces `assertCanWrite` in the agent usecases.
 */
export function assertAgentGovernanceWrite(ctx: RequestContext, key: AgentGovernanceKey): void {
    if (meetsAgentGovernanceWrite(ctx, key)) return;
    throw forbidden('You do not have permission to modify records in this context.');
}

/**
 * Does the caller clear the floor of an agent-governance ADMIN act? The boolean
 * `assertAgentGovernanceAdmin` throws on, for the same reason
 * `meetsAgentGovernanceWrite` exists.
 */
export function meetsAgentGovernanceAdmin(ctx: RequestContext, key: AgentGovernanceKey): boolean {
    return Boolean(ctx.permissions.canAdmin) || holdsAgentKey(ctx, key);
}

/**
 * The floor of an agent-governance ADMIN act: `canAdmin`, or the agent key.
 * Replaces `assertCanAdmin` in the agent usecases.
 */
export function assertAgentGovernanceAdmin(ctx: RequestContext, key: AgentGovernanceKey): void {
    if (meetsAgentGovernanceAdmin(ctx, key)) return;
    throw forbidden('You do not have permission to perform administrative actions in this context.');
}
