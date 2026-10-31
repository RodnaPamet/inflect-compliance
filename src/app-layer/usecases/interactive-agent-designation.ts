/**
 * WHICH AGENT ANSWERS ON ASK (#4629).
 *
 * `TenantSecuritySettings.interactiveAgentId` names the agent that answers a
 * person's question on the Ask page. `resolveInteractiveAgent` has read it
 * since #3868 and refused every question `NO_AGENT_DESIGNATED` while it is
 * null, telling the asker to designate one on the agent register — and nothing
 * in the product could write it. This is that writer.
 *
 * ── WHO MAY DESIGNATE (owner decision, 2026-10-30) ──────────────────────────
 *
 * The register key, `admin.agent_registry`, on the agent's own page. Choosing
 * which agent answers the workspace's people is the same judgement as deciding
 * which agents may act in the tenant at all — the register's job — and the
 * route takes that key literally so a refusal writes `AUTHZ_DENIED`. The floor
 * here is the register's own (`assertAgentGovernanceWrite`), so an AI admin,
 * whose coarse tier is READER's, can designate as it can register.
 *
 * ── WHAT IT DOES NOT CHECK ──────────────────────────────────────────────────
 *
 * Standing, the kill switch and the breaker are not checked here. The resolver
 * asks the last two on every question and the Flue gate asks standing, each
 * with a named refusal; refusing the DESIGNATION on them as well would be a
 * second control over facts that change after it — an agent un-killed
 * tomorrow would still be undesignatable today. What is refused here is what
 * can never answer: an agent this workspace does not hold, and a retired one.
 *
 * Clearing names the agent being cleared, and clears only while it is still
 * the designation, so two people acting on two agents' pages cannot clear each
 * other's choice.
 */
import { runInTenantContext } from '@/lib/db-context';
import { conflict, notFound } from '@/lib/errors/types';
import { logEvent } from '../events/audit';
import { assertCanRead } from '../policies/common';
import { assertAgentGovernanceWrite } from '../policies/agent-governance.policies';
import type { RequestContext } from '../types';

/** The designated agent's id, or null when none is. */
export async function getInteractiveAgentDesignation(ctx: RequestContext): Promise<string | null> {
    assertCanRead(ctx);
    const settings = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { interactiveAgentId: true },
        }),
    );
    return settings?.interactiveAgentId ?? null;
}

/** Make `agentId` the agent that answers on Ask, replacing any other. */
export async function designateInteractiveAgent(
    ctx: RequestContext,
    agentId: string,
): Promise<{ interactiveAgentId: string; previous: string | null }> {
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    return runInTenantContext(ctx, async (db) => {
        const agent = await db.registeredAgent.findFirst({
            where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true, status: true },
        });
        if (!agent) throw notFound('Agent not found');
        if (agent.status === 'RETIRED') {
            throw conflict('A retired agent cannot answer questions. Choose another agent.');
        }
        const before = await db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { interactiveAgentId: true },
        });
        const previous = before?.interactiveAgentId ?? null;
        if (previous === agent.id) return { interactiveAgentId: agent.id, previous };

        await db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            // UPSERT: a tenant nobody has configured has no settings row, and
            // those are exactly the tenants a first designation is for.
            create: { tenantId: ctx.tenantId, interactiveAgentId: agent.id },
            update: { interactiveAgentId: agent.id },
        });
        await logEvent(db, ctx, {
            action: 'INTERACTIVE_AGENT_DESIGNATED',
            entityType: 'RegisteredAgent',
            entityId: agent.id,
            details: `Ask is now answered by agent ${agent.name}`,
            // `access`: this decides which agent reads the workspace's records
            // on behalf of every person who asks a question.
            detailsJson: {
                category: 'access',
                operation: 'grant',
                summary: 'Interactive agent designated',
                previousAgentId: previous,
            },
        });
        return { interactiveAgentId: agent.id, previous };
    });
}

/** Stop `agentId` answering on Ask. A no-op when it is not the designation. */
export async function clearInteractiveAgent(
    ctx: RequestContext,
    agentId: string,
): Promise<{ cleared: boolean }> {
    assertAgentGovernanceWrite(ctx, 'agent_registry');
    return runInTenantContext(ctx, async (db) => {
        // Conditional on the agent still being the designation, so clearing an
        // agent that has since been replaced does not clear its replacement.
        const { count } = await db.tenantSecuritySettings.updateMany({
            where: { tenantId: ctx.tenantId, interactiveAgentId: agentId },
            data: { interactiveAgentId: null },
        });
        if (count === 0) return { cleared: false };
        await logEvent(db, ctx, {
            action: 'INTERACTIVE_AGENT_CLEARED',
            entityType: 'RegisteredAgent',
            entityId: agentId,
            details: 'Ask is answered by no agent',
            detailsJson: { category: 'access', operation: 'revoke', summary: 'Interactive agent cleared' },
        });
        return { cleared: true };
    });
}
