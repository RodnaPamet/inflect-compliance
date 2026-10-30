/**
 * Which agent-register WRITES a viewer is offered (#4471).
 *
 * A write to the register passes three gates, in this order, and a page that
 * offers a control on fewer of them shows a button whose every press is
 * refused:
 *
 *   1. THE EDGE. `/api/t/:slug/admin/agents/**` is an admin path, and the
 *      middleware admits it only to a session whose BUILT-IN membership role in
 *      that tenant is OWNER or ADMIN, or AI_ADMIN on the agent paths
 *      (`checkAdminAccess` in `src/lib/auth/guard.ts`). A custom role never
 *      enters that check, so a custom role carrying the register key on an
 *      Editor, Reader or Auditor membership is refused before the route runs.
 *   2. THE ROUTE: a literal `requirePermission('admin.agent_registry')`.
 *   3. THE USECASE FLOOR: `assertAgentGovernanceWrite` for registering,
 *      amending, activating, suspending, retiring and scoring an agent;
 *      `assertAgentGovernanceAdmin` for the concurrency cap, the monthly budget
 *      and closing a circuit breaker. Each is "the coarse tier, OR the agent
 *      key", which is what admits the built-in AI admin: its coarse tier is
 *      READER's, so a page that asked `canWrite` / `canAdmin` alone withheld
 *      from it every control the server accepts from it.
 *
 * Each gate is asked through the function the server itself calls, never a
 * copy: the edge's own pure `checkAdminAccess`, and the floors' own `meets*`
 * booleans. So the page cannot drift from the server by having its own idea of
 * either. This module only ASKS; it widens nothing, and it is not an
 * authority — every write still passes all three gates on its own.
 *
 * The three-gate rule is every admin page's since #4467: this module is the
 * agent register's use of `offersAdminApiWrite`
 * (`src/lib/auth/admin-api-affordances.ts`), with its edge verdict from
 * `edgeAdmitsAdminApi` (`src/lib/auth/admin-api-edge.ts`).
 *
 * Pure: the session's claims are read by the server page and handed in, so a
 * unit test can drive every role without a request.
 */
import type { RequestContext } from '@/app-layer/types';
import {
    meetsAgentGovernanceAdmin,
    meetsAgentGovernanceWrite,
} from '@/app-layer/policies/agent-governance.policies';
import { offersAdminApiWrite } from '@/lib/auth/admin-api-affordances';
import { edgeAdmitsAdminApi, type EdgeAdminClaims } from '@/lib/auth/admin-api-edge';

export type { EdgeAdminClaims };

/**
 * Would the edge admit this session's WRITE to the agent admin API of
 * `tenantSlug`? Asked of `checkAdminAccess` with a POST, exactly as the
 * middleware asks it. `'defer'` (the tenant is not in a capped claim) admits,
 * as it does at the edge, which leaves that request to the DB-backed gates.
 */
export function edgeAdmitsAgentAdminWrite(
    tenantSlug: string,
    claims: EdgeAdminClaims | null | undefined,
): boolean {
    return edgeAdmitsAdminApi(tenantSlug, claims, '/agents', 'POST');
}

export interface AgentRegisterAffordances {
    /**
     * Register an agent, amend one, activate, suspend or retire it, and answer
     * or complete its risk assessment — every write behind
     * `assertAgentGovernanceWrite(ctx, 'agent_registry')`.
     */
    canManage: boolean;
    /**
     * Set the concurrent-run cap and the monthly token budget, and close a
     * circuit breaker — every write behind
     * `assertAgentGovernanceAdmin(ctx, 'agent_registry')`.
     */
    canAdminister: boolean;
}

/** The register writes this viewer is offered: all three gates, each asked as the server asks it. */
export function agentRegisterAffordances(
    ctx: RequestContext,
    edgeAdmits: boolean,
): AgentRegisterAffordances {
    const viewer = { edgeAdmits, appPermissions: ctx.appPermissions, permissions: ctx.permissions };
    return {
        canManage: offersAdminApiWrite(viewer, {
            key: 'admin.agent_registry',
            floor: meetsAgentGovernanceWrite(ctx, 'agent_registry'),
        }),
        canAdminister: offersAdminApiWrite(viewer, {
            key: 'admin.agent_registry',
            floor: meetsAgentGovernanceAdmin(ctx, 'agent_registry'),
        }),
    };
}
