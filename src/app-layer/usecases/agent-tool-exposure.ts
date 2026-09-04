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
 * ## Three refusals, and why each is here rather than in the database
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
 */
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import { isKnownMcpTool, MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';
import type { PrismaTx } from '@/lib/db-context';

import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { RegisteredAgentToolRepository } from '../repositories/RegisteredAgentToolRepository';
import { refreshAgentAssessmentStalenessInTx } from './agent-risk-assessment';
import { AgentToolGrantSchema } from '../schemas/agent-registry.schemas';
import type { RequestContext } from '../types';

/**
 * Resolve the agent inside the tenant transaction. See the header for why the
 * foreign key is not allowed to be the check.
 */
async function assertAgentGrantable(db: PrismaTx, ctx: RequestContext, agentId: string) {
    const agent = await db.registeredAgent.findFirst({
        where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, status: true },
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

export async function grantAgentTool(ctx: RequestContext, agentId: string, input: unknown) {
    assertCanWrite(ctx);
    const { toolName } = AgentToolGrantSchema.parse(input);
    if (!isKnownMcpTool(toolName)) {
        throw badRequest(`Unknown MCP tool "${toolName}".`);
    }

    return runInTenantContext(ctx, async (db) => {
        await assertAgentGrantable(db, ctx, agentId);
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
        // It WARNS; it does not block. Blocking here would make the correct,
        // audited act — widening an agent deliberately and on the record — the
        // thing that takes it dark, and the widening is inert anyway: the tier
        // in force was scored against the narrower basis and the ceiling
        // composes as a `min`. See `agent-assessment-staleness.ts`.
        const staleness = await refreshAgentAssessmentStalenessInTx(db, ctx, agentId);

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
