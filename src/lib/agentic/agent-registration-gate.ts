/**
 * Agent registration gate — the per-tenant refusal of unregistered agent traffic.
 *
 * ## What it is for
 *
 * The register says which autonomous agents a tenant runs, what authority each
 * holds, who is accountable, and which are switched off. A register nothing
 * consults is a spreadsheet. This is the seam that makes it load-bearing: when
 * `TenantSecuritySettings.requireRegisteredAgent` is on, a credential that does
 * not name an ACTIVE `RegisteredAgent` cannot reach `/api/mcp` at all.
 *
 * ## Fail direction, and where it points in each case
 *
 * Two different unknowns, deliberately resolved in opposite directions:
 *
 *   • An ABSENT `TenantSecuritySettings` row reads as ENFORCING. Rows here are
 *     written lazily, so "no row" is the state of every tenant nobody has
 *     configured — including every tenant created after this shipped. Reading it
 *     as "off" would mean the documented default (new tenants ON) was true only
 *     of tenants whose admin had happened to open a settings page. The migration
 *     back-fills a row for every tenant that existed at deploy time so this
 *     rule cannot retroactively switch them on.
 *
 *   • An UNKNOWN or non-ACTIVE agent status reads as REFUSED. DRAFT is not a
 *     usable state (an agent arrives unscored), SUSPENDED is the kill switch,
 *     RETIRED is the end of its life. Only ACTIVE passes. A soft-deleted row
 *     passes nothing.
 *
 * ## The audit row is the product, not a side effect
 *
 * Every refusal writes a hash-chained `AUTHZ_DENIED` entry through
 * `appendAuditEntry` — the same action `requirePermission` writes, because it is
 * the same class of event and a security reviewer filtering for denied access
 * should not have to know that agents have their own vocabulary. The write is
 * best-effort: an audit outage must not turn a refusal into an admission, so the
 * throw happens whether or not the row landed.
 */
import { prisma } from '@/lib/prisma';
import { appendAuditEntry } from '@/lib/audit';
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import type { AgentRiskTier } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';

/**
 * Why a request was refused. Carried into the audit row's `detailsJson` so an
 * operator reading the trail can tell "nobody registered this key" from "the
 * kill switch is down", which need completely different responses.
 */
export type AgentGateDenialReason =
    | 'no_agent_binding'
    | 'agent_not_found'
    | 'agent_not_active';

export interface AgentGateVerdict {
    /** Whether the tenant is enforcing at all. */
    enforcing: boolean;
    /** The agent the caller speaks for, when it resolved to a live ACTIVE one. */
    agentId: string | null;
    /**
     * That agent's registered rung on the 0-6 autonomy ladder, or `null` when
     * no live ACTIVE agent resolved.
     *
     * Read HERE rather than by a second query later because this is already the
     * one place that loads the agent to decide whether traffic runs, and the
     * autonomy ceiling is decided from the same row on the same request. A
     * separate read would be a second answer to "which agent is this", free to
     * disagree with the first between the two queries.
     */
    autonomyLevel: number | null;
    /**
     * That agent's SCORED operational risk tier, which caps how far up the
     * ladder it may actually be driven — see `riskTierCeilingFor`.
     *
     * Meaningful ONLY when `agentId` is non-null. Read on its own it is
     * ambiguous in exactly the way that takes the product dark: `null` here is
     * "unscored" when an agent resolved, and "there is no agent" when one did
     * not, and those must resolve to opposite ceilings. Callers build the term
     * with `riskTierCeilingFor(agentId === null ? null : { riskTier })` rather
     * than passing this field to `ceilingForRiskTier` directly.
     *
     * Read HERE, from the same row and the same query as `autonomyLevel`, for
     * the reason stated above it: a second read is a second answer to "which
     * agent is this", free to disagree with the first.
     */
    riskTier: AgentRiskTier | null;
    /** Set only when the caller was refused. */
    reason: AgentGateDenialReason | null;
}

/**
 * Read the tenant's enforcement flag. An absent settings row is ENFORCING —
 * see the header for why the absence has to resolve that way.
 */
export async function isAgentRegistrationEnforced(tenantId: string): Promise<boolean> {
    const row = await prisma.tenantSecuritySettings.findUnique({
        where: { tenantId },
        select: { requireRegisteredAgent: true },
    });
    return row?.requireRegisteredAgent ?? true;
}

/**
 * Resolve whether this context is allowed to act as an agent.
 *
 * Pure decision — writes nothing, throws nothing. `assertRegisteredAgent` is the
 * enforcing wrapper; this exists separately so a surface that wants to REPORT
 * the verdict (a diagnostics page, a dry-run) can do so without a refusal.
 */
export async function evaluateAgentRegistration(ctx: RequestContext): Promise<AgentGateVerdict> {
    const enforcing = await isAgentRegistrationEnforced(ctx.tenantId);

    if (!ctx.agentId) {
        return {
            enforcing,
            agentId: null,
            autonomyLevel: null,
            riskTier: null,
            reason: enforcing ? 'no_agent_binding' : null,
        };
    }

    // Read the agent by (id, tenantId) rather than by id alone. The FK already
    // makes a cross-tenant binding unrepresentable, but this query is the one
    // that decides whether traffic runs, and it does not get to rely on that.
    const agent = await prisma.registeredAgent.findFirst({
        where: { id: ctx.agentId, tenantId: ctx.tenantId, deletedAt: null },
        select: { id: true, status: true, autonomyLevel: true, riskTier: true },
    });

    if (!agent) {
        return {
            enforcing,
            agentId: null,
            autonomyLevel: null,
            riskTier: null,
            reason: enforcing ? 'agent_not_found' : null,
        };
    }
    if (agent.status !== 'ACTIVE') {
        return {
            enforcing,
            agentId: null,
            autonomyLevel: null,
            riskTier: null,
            reason: enforcing ? 'agent_not_active' : null,
        };
    }

    return {
        enforcing,
        agentId: agent.id,
        autonomyLevel: agent.autonomyLevel,
        riskTier: agent.riskTier,
        reason: null,
    };
}

const DENIAL_MESSAGE: Record<AgentGateDenialReason, string> = {
    no_agent_binding:
        'This API key is not registered to an agent. This tenant requires every agent to be in the register before it may use the agent surface.',
    agent_not_found:
        'The agent registered to this API key no longer exists. Register the agent again or rebind the key.',
    agent_not_active:
        'The agent registered to this API key is not active. An agent must be ACTIVE in the register to use the agent surface.',
};

/**
 * Enforce the gate. Refusals write a hash-chained `AUTHZ_DENIED` row and throw
 * `forbidden`. Returns the whole verdict when the caller passes — including when
 * the tenant is NOT enforcing, so a caller can still attribute the work and read
 * the agent's registered autonomy level without a second query.
 */
export async function assertRegisteredAgent(
    ctx: RequestContext,
    surface: { method: string; path: string },
): Promise<AgentGateVerdict> {
    const verdict = await evaluateAgentRegistration(ctx);
    if (!verdict.reason) return verdict;

    await auditAgentGateDenied(ctx, verdict.reason, surface);
    throw forbidden(DENIAL_MESSAGE[verdict.reason]);
}

/**
 * The hash-chained denial row. Best-effort by design: the refusal must reach the
 * caller whether or not audit storage is reachable, exactly as
 * `requirePermission` handles its own `AUTHZ_DENIED` write.
 */
async function auditAgentGateDenied(
    ctx: RequestContext,
    reason: AgentGateDenialReason,
    surface: { method: string; path: string },
): Promise<void> {
    try {
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'API_KEY',
            entity: 'RegisteredAgent',
            // The key, not the agent — there is no agent, and that IS the
            // finding. An operator reading the trail needs the credential to
            // revoke or bind.
            entityId: ctx.apiKeyId ?? 'unknown-api-key',
            action: 'AUTHZ_DENIED',
            details: `Unregistered agent refused for ${surface.method} ${surface.path}`,
            detailsJson: {
                category: 'access',
                event: 'authz_denied',
                gate: 'agent_registration',
                reason,
                apiKeyId: ctx.apiKeyId ?? null,
                agentId: ctx.agentId ?? null,
                method: surface.method,
                path: surface.path,
            },
            requestId: ctx.requestId,
            metadataJson: { apiKeyId: ctx.apiKeyId ?? null, reason },
        });
    } catch (err) {
        logger.warn('audit: failed to record agent-registration AUTHZ_DENIED', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
