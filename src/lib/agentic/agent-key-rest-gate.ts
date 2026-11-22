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
    const verdict = await agentKeyStopVerdict(ctx);
    if (!verdict) return;

    await auditRefusal(ctx, verdict.reason, surface, 'agent_key_rest', verdict.kill, verdict.status);

    // A kill is the more specific answer, and the one an operator acts on.
    throw forbidden(
        verdict.reason === 'agent_killed' && verdict.kill
            ? killRefusalMessage(verdict.kill.scope)
            : NOT_ACTIVE_MESSAGE,
    );
}

/**
 * THE SAME CONTROLS, FOR A JOB THE KEY QUEUED (#5189).
 *
 * `resolveKeyInitiatorContext` re-reads an agent-bound key by id so that, in its
 * own words, the job holds "key now ∧ the initiator's membership now" — the
 * point being that a key revoked while the job sat in the queue does not run.
 * That re-read goes through `resolveApiKeyForJob`, which checks revoked, expired
 * and tenant_deleted and nothing about the AGENT. So an operator could engage
 * the kill switch, or suspend the agent, and a queued evidence import or
 * SharePoint delta sync would still write evidence and link controls for a
 * stopped agent — while a REST request with the same key at the same moment got
 * a 403 and an `AUTHZ_DENIED` row.
 *
 * That is the owner's 2026-10-29 decision defeated by the QUEUE rather than
 * disagreed with: stopping an agent is meant to stop its credential, and a
 * surface that reads the key "now" while ignoring its agent is not reading now.
 *
 * RETURNS rather than throws, because that is this caller's contract — the job
 * context resolver answers with a refusal reason and its callers decide. The
 * audit row carries gate `agent_key_job`, so an operator can tell a job refusal
 * from a REST one; before this the job path wrote no row at all.
 */
export async function agentKeyJobRefusal(
    ctx: RequestContext,
    jobName: string,
): Promise<AgentKeyRestRefusal | null> {
    const verdict = await agentKeyStopVerdict(ctx);
    if (!verdict) return null;

    await auditRefusal(
        ctx,
        verdict.reason,
        { method: 'JOB', path: jobName },
        'agent_key_job',
        verdict.kill,
        verdict.status,
    );
    return verdict.reason;
}

/**
 * Is this agent-bound key's agent stopped? `null` means it may act.
 *
 * ONE read for both surfaces, so the two doors cannot disagree about which
 * switches count — the same reason this gate reads the funnel's own
 * `resolveKillState` rather than a query of its own. A key bound to no agent is
 * not this gate's concern and returns `null`.
 *
 * A read that FAILS propagates: the kill state is never assumed clear because
 * it could not be read.
 */
async function agentKeyStopVerdict(ctx: RequestContext): Promise<
    { reason: AgentKeyRestRefusal; kill: KillVerdict | null; status: string | null } | null
> {
    if (!ctx.agentId) return null;

    const [agent, kill] = await Promise.all([
        prisma.registeredAgent.findFirst({
            where: { id: ctx.agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { status: true },
        }),
        resolveKillState(ctx.tenantId, ctx.agentId),
    ]);

    if (kill) return { reason: 'agent_killed', kill, status: agent?.status ?? null };
    if (agent?.status !== ADMITTED_STATUS) {
        return { reason: 'agent_not_active', kill: null, status: agent?.status ?? null };
    }
    return null;
}

/**
 * The hash-chained denial row. Best-effort, as every `AUTHZ_DENIED` write is:
 * the refusal reaches the caller whether or not audit storage is reachable.
 */
async function auditRefusal(
    ctx: RequestContext,
    reason: AgentKeyRestRefusal,
    surface: { method: string; path: string },
    gate: 'agent_key_rest' | 'agent_key_job',
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
                // SPELLED AS LITERALS, not as the `gate` variable.
                // `no-raw-prompt-logging` counts value positions at an audit
                // sink that it cannot read, and caps them — a bare `gate,`
                // made this one opaque and pushed that ceiling from 225 to
                // 226. Raising the ceiling would loosen
                // `HOLES_PER_SINK_CEILING`, which that guard's own history
                // says a diff should not do. Enumerating the two values at the
                // sink is what the rule wants to see, and it is also the
                // honest statement: these are the only gates that write here.
                gate: gate === 'agent_key_job' ? 'agent_key_job' : 'agent_key_rest',
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
