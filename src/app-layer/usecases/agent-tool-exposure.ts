/**
 * Agent tool exposure — usecase. Granting an agent a tool, and taking it back.
 *
 * ## Why this is a privileged action with its own key
 *
 * A grant is the difference between an agent that can read the risk register and
 * one that cannot. `admin.agent_registry` decides WHETHER an agent may act at
 * all; `admin.agent_tool_exposure` decides WHAT it may reach. The second flag
 * moves whenever somebody wires up an automation, and folding it into the first
 * would have made every routine "let it read tasks too" carry the authority to
 * admit an agent nobody had scored. The route enforces the key, so a denial
 * writes a hash-chained `AUTHZ_DENIED` row — a usecase throw records nothing,
 * which is the whole of Epic D.3.
 *
 * ## Four refusals, and why each is here rather than in the database
 *
 *   • UNKNOWN TOOL. Validated against the live catalogue
 *     (`src/lib/mcp/tool-catalogue.ts`) rather than a DB enum, because a tool is
 *     a piece of code that ships with a deploy and an `ALTER TYPE` mid-rolling-
 *     deploy is the failure the `@@map("WorkItem*")` pins already record. A
 *     grant naming a tool that later DISAPPEARS is inert, which is the right
 *     direction — nothing can call a tool that is gone.
 *   • AGENT NOT IN THIS TENANT. The composite FK makes a cross-tenant grant
 *     unrepresentable, but Postgres runs FK checks as the table owner and so
 *     bypasses row security: the constraint would be satisfied by another
 *     tenant's agent id. Resolved INSIDE the tenant transaction instead, the
 *     same fix `createApiKey` needed for its agent binding.
 *   • RETIRED AGENT. Granting a tool to an agent whose file is closed is a
 *     configuration error that would otherwise sit in the register looking
 *     deliberate. SUSPENDED is deliberately still grantable: suspension is a
 *     reversible kill switch, and an operator preparing an agent to come back
 *     should not have to un-suspend it first to fix its tool list.
 *   • A TOOL THE ASSESSED TIER CANNOT REACH. See `assertGrantWithinTier` below.
 *     The granted-tool count is NOT a scorer input, so a grant cannot be
 *     answered by re-scoring the agent the way an axis widening is — the rung
 *     the tool requires, against the rung the tier permits, is what bounds it.
 */
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { isKnownMcpTool, mcpToolCapabilityClass, MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';
import {
    AUTONOMY_REQUIRED_BY_CAPABILITY,
    ceilingForRiskTier,
    DENY_CEILING,
} from '@/lib/agentic/autonomy-ceiling';
import type { PrismaTx } from '@/lib/db-context';

import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { RegisteredAgentToolRepository } from '../repositories/RegisteredAgentToolRepository';
import { reassessAgentAfterChangeInTx } from './agent-risk-assessment';
import { AgentToolGrantSchema } from '../schemas/agent-registry.schemas';
import type { RequestContext } from '../types';

/**
 * Resolve the agent inside the tenant transaction. See the header for why the
 * foreign key is not allowed to be the check.
 */
async function assertAgentGrantable(db: PrismaTx, ctx: RequestContext, agentId: string) {
    const agent = await db.registeredAgent.findFirst({
        where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, status: true, riskTier: true },
    });
    // Same shape whether absent or foreign, so a caller learns nothing about
    // another tenant's id space.
    if (!agent) throw notFound('Registered agent not found');
    if (agent.status === 'RETIRED') {
        throw badRequest(
            'This agent is retired. Reactivate it before changing what it may reach.',
        );
    }
    return agent;
}

export async function listAgentTools(ctx: RequestContext, agentId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        await assertAgentGrantable(db, ctx, agentId);
        const tools = await RegisteredAgentToolRepository.listForAgent(db, ctx, agentId);
        return {
            agentId,
            granted: tools,
            /** The full catalogue, so a UI can offer what is not yet granted. */
            available: MCP_TOOL_NAMES,
        };
    });
}

/**
 * ── A GRANT THE TIER COULD NEVER EXERCISE IS REFUSED ────────────────
 *
 * A granted tool is NOT an input to the risk score. `scoreAgentRisk` reads four
 * declared axes and the questionnaire; `RegisteredAgentTool` appears in none of
 * them, which is why widening the tool list — unlike widening an axis — cannot
 * be answered by re-scoring the agent. There is nothing to recompute.
 *
 * What bounds a grant instead is the rung. Every tool call goes through
 * `min(key max, registered autonomy, tier cap)` on every request, and each tool
 * declares the rung it requires. So the assessed tier already decides HOW FAR a
 * grant can reach; the grant only decides WHICH tools within that reach. That
 * is what makes granting safe without a re-score — the tier is not being
 * bypassed, it is being spent.
 *
 * This refusal closes the remaining gap, which is a configuration error rather
 * than an escalation: granting a PROPOSE tool to an agent capped at READ writes
 * a row that looks deliberate in the register and refuses at the boundary
 * forever. Same shape as the RETIRED refusal above and as
 * `assertRaiseWithinTier` in the register usecase — the error arrives where the
 * operator is asking for the thing.
 *
 * An UNSCORED agent is deliberately NOT refused here. Its ceiling is
 * `DENY_CEILING`, so on this rule every grant would fail — and preparing a
 * DRAFT agent's tool list before assessing it is an ordinary, correct workflow.
 * Activation is where the score is demanded; making the register's own
 * preparation the outage is the failure mode this subsystem keeps naming.
 */
function assertGrantWithinTier(
    agent: { riskTier: Parameters<typeof ceilingForRiskTier>[0] },
    toolName: string,
): void {
    if (agent.riskTier === null || agent.riskTier === undefined) return;

    const cap = ceilingForRiskTier(agent.riskTier);
    const required = AUTONOMY_REQUIRED_BY_CAPABILITY[mcpToolCapabilityClass(toolName)];
    if (cap !== DENY_CEILING && required <= cap) return;

    throw badRequest(
        `"${toolName}" needs autonomy ${required}, and this agent's assessed risk ` +
            `tier (${agent.riskTier}) caps it at ${cap}. Granting it would write a ` +
            `permission the tool boundary refuses on every call. Re-assess the agent ` +
            `— reducing its data access or making its actions reversible is what ` +
            `lowers the tier, and the tier is what lifts the cap.`,
    );
}

export async function grantAgentTool(ctx: RequestContext, agentId: string, input: unknown) {
    assertCanWrite(ctx);
    const { toolName } = AgentToolGrantSchema.parse(input);
    if (!isKnownMcpTool(toolName)) {
        throw badRequest(`Unknown MCP tool "${toolName}".`);
    }

    return runInTenantContext(ctx, async (db) => {
        const agent = await assertAgentGrantable(db, ctx, agentId);
        assertGrantWithinTier(agent, toolName);
        const granted = await RegisteredAgentToolRepository.grant(db, ctx, agentId, toolName);

        await logEvent(db, ctx, {
            action: 'AGENT_TOOL_GRANTED',
            entityType: 'RegisteredAgent',
            entityId: agentId,
            detailsJson: {
                category: 'access',
                entityName: 'RegisteredAgentTool',
                operation: 'create',
                summary: `Granted MCP tool "${toolName}" to agent ${agentId}`,
                after: { toolName, agentId },
            },
        });

        // A grant is one of the assessment's staleness triggers — the agent can
        // now reach something it could not when somebody scored it. Re-evaluated
        // in THIS transaction so the note commits with the grant that caused it,
        // and so the register never shows a fresh assessment beside a tool it
        // never saw.
        //
        // It WARNS; it does not block, and here the warning is the whole of the
        // remedy available: the tool count is not a scorer input, so unlike an
        // axis widening there is no tier to recompute (the reconcile below will
        // find the axes unchanged and re-score nothing). The rung check above is
        // what bounds the grant; this records that the ANSWERS — "is every tool
        // this agent holds within its reviewed blast radius" — were given before
        // it held this one.
        const staleness = await reassessAgentAfterChangeInTx(db, ctx, agentId);

        return { agentId, toolName, grantedAt: granted.createdAt, staleness };
    });
}

export async function revokeAgentTool(ctx: RequestContext, agentId: string, toolName: string) {
    assertCanWrite(ctx);
    return runInTenantContext(ctx, async (db) => {
        // No `assertAgentGrantable` here, deliberately: revoking must work on a
        // RETIRED agent too. Taking authority away is never the move to refuse
        // — the same reason `suspendRegisteredAgent` carries no precondition.
        const count = await RegisteredAgentToolRepository.revoke(db, ctx, agentId, toolName);
        if (count === 0) throw notFound('That tool is not granted to this agent');

        await logEvent(db, ctx, {
            action: 'AGENT_TOOL_REVOKED',
            entityType: 'RegisteredAgent',
            entityId: agentId,
            detailsJson: {
                category: 'access',
                entityName: 'RegisteredAgentTool',
                operation: 'delete',
                summary: `Revoked MCP tool "${toolName}" from agent ${agentId}`,
                before: { toolName, agentId },
            },
        });

        return { agentId, toolName, revoked: true };
    });
}
