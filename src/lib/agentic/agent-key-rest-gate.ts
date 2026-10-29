/**
 * AN AGENT-BOUND API KEY ON THE REST API ANSWERS TO ITS AGENT'S CONTROLS (#4481).
 *
 * Since #2224 an `iflk_` key is admitted at every `/api/t/**` route, but only
 * the MCP funnel read the agent behind a key. So a key bound to an agent kept
 * reading and writing over REST while that agent was killed or suspended:
 * stopping an agent stopped its tool calls and left its credential working.
 * Retirement was the exception only because its cascade revokes the key.
 *
 * Owner decision, 2026-10-29: the kill switch and the agent's status also stop
 * the key at REST. This is that gate. `tryApiKeyAuth` (`src/app-layer/context.ts`)
 * calls it for every agent-bound key, after `verifyApiKey` has narrowed the
 * key to its principal, and before any route sees the context.
 *
 *   • A KILL IN FORCE REFUSES — platform, tenant or agent scope, read with the
 *     funnel's own `resolveKillState`, so the two doors cannot disagree about
 *     which switches count.
 *   • A STATUS OTHER THAN ACTIVE REFUSES — draft, suspended, retired, or a row
 *     that no longer resolves. An allowlist: a status added later refuses
 *     until somebody decides otherwise here.
 *   • A READ THAT FAILS REFUSES. The kill state is not assumed clear because it
 *     could not be read; the error propagates and the request fails.
 *
 * Every refusal writes a hash-chained `AUTHZ_DENIED` row (gate
 * `agent_key_rest`), because a stopped agent's credential being turned away is
 * exactly what an operator needs to see. The MCP funnel is unchanged: it reads
 * the same controls per call and records its own refusals.
 *
 * What this gate does NOT do: limit a key to its agent's tool grants on REST.
 * A key's REST reach is still its scopes, intersected with its principal's
 * role. Keep keys meant for `/api/mcp` to the scopes their grants need.
 */
import { appendAuditEntry } from '@/lib/audit';
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import type { RequestContext } from '@/app-layer/types';

import { killRefusalMessage, resolveKillState, type KillVerdict } from './kill-switch';

/** Why an agent-bound key was turned away at REST. */
export type AgentKeyRestRefusal = 'agent_killed' | 'agent_not_active';

/** The one status that admits an agent-bound key at REST. */
const ADMITTED_STATUS = 'ACTIVE';

const NOT_ACTIVE_MESSAGE =
    'The agent this API key is registered to is not active, so the key may not be used. ' +
    'Activate the agent in the register, or use a key that is not bound to an agent.';

/**
 * Refuse an agent-bound key whose agent is stopped. A key bound to no agent is
 * not this gate's concern and passes untouched.
 */
export async function assertAgentKeyMayActAtRest(
    ctx: RequestContext,
    surface: { method: string; path: string },
): Promise<void> {
    if (!ctx.agentId) return;

    const [agent, kill] = await Promise.all([
        prisma.registeredAgent.findFirst({
            where: { id: ctx.agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { status: true },
        }),
        resolveKillState(ctx.tenantId, ctx.agentId),
    ]);

    // A kill is the more specific answer, and the one an operator acts on.
    if (kill) {
        await auditRefusal(ctx, 'agent_killed', surface, kill);
        throw forbidden(killRefusalMessage(kill.scope));
    }
    if (agent?.status !== ADMITTED_STATUS) {
        await auditRefusal(ctx, 'agent_not_active', surface, null, agent?.status ?? null);
        throw forbidden(NOT_ACTIVE_MESSAGE);
    }
}

/**
 * The hash-chained denial row. Best-effort, as every `AUTHZ_DENIED` write is:
 * the refusal reaches the caller whether or not audit storage is reachable.
 */
async function auditRefusal(
    ctx: RequestContext,
    reason: AgentKeyRestRefusal,
    surface: { method: string; path: string },
    kill: KillVerdict | null,
    status: string | null = null,
): Promise<void> {
    try {
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'API_KEY',
            entity: 'RegisteredAgent',
            entityId: ctx.agentId ?? 'unknown-agent',
            action: 'AUTHZ_DENIED',
            details: `Stopped agent's API key refused for ${surface.method} ${surface.path}`,
            detailsJson: {
                category: 'access',
                event: 'authz_denied',
                gate: 'agent_key_rest',
                reason,
                apiKeyId: ctx.apiKeyId ?? null,
                agentId: ctx.agentId ?? null,
                killScope: kill?.scope ?? null,
                killSwitchId: kill?.switchId ?? null,
                agentStatus: status,
                method: surface.method,
                path: surface.path,
            },
            requestId: ctx.requestId,
            metadataJson: { apiKeyId: ctx.apiKeyId ?? null, reason },
        });
    } catch (err) {
        logger.warn('audit: failed to record agent-key REST AUTHZ_DENIED', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : 'a non-Error value was thrown',
        });
    }
}
