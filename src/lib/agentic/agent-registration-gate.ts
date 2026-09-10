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
 *   • An UNKNOWN or non-ACTIVE agent status reads as REFUSED **when the tenant
 *     enforces**. DRAFT is not a usable state (an agent arrives unscored),
 *     SUSPENDED is deliberate containment, RETIRED is the end of its life. Only
 *     ACTIVE is vouched for. A soft-deleted row passes nothing.
 *
 *     SUSPENDED is NOT "the kill switch" — that is `agentic/kill-switch.ts`, a
 *     boundary control with its own table and its own scopes. This sentence
 *     used to say otherwise and the confusion was load-bearing: see below.
 *
 *     When the tenant does NOT enforce, nothing is refused here — and that is
 *     where `standing` earns its place. The verdict's SHAPE is an input to
 *     authority assembly (`mcp/auth.ts` `buildMcpInvocation`), not only the
 *     output of a refusal decision, and for four of the seven situations above
 *     it used to be the same four nulls. A caller that cannot tell "there is no
 *     agent" from "the agent here is stopped" gives the stopped one the WIDER
 *     answer, because an absent narrowing term is correctly read as no
 *     narrowing. That was #2399. See `governedAgentIdOf`.
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
import type { AgentRiskTier, AgentStatus } from '@prisma/client';
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

/**
 * WHICH of the seven situations the register answered with.
 *
 * ALWAYS SET, in every tenant, enforcing or not — and that is the whole point
 * of the field. `reason` cannot carry this: it is `null` for a non-enforcing
 * tenant by design (nothing was refused), which is precisely the tenant where
 * the situations most need telling apart.
 *
 * `unknown_status` exists so that an `AgentStatus` added to the Prisma enum
 * without being taught to this module is CONTAINED rather than admitted — the
 * same fail direction `ceilingForRiskTier` takes for a tier it does not
 * recognise. The `Record` below makes it a compile error first; this is the
 * belt to that type's braces.
 */
export type AgentGateStanding =
    | 'no_binding' //     `ctx.agentId` absent — a human, or an ordinary integration key
    | 'unresolvable' //   a bound id that names no live row in this tenant
    | 'draft' //          resolved, never put into service
    | 'suspended' //      resolved, and an operator deliberately stopped it
    | 'retired' //        resolved, end of its life
    | 'unknown_status' // resolved, and this build does not know what its status means
    | 'vouched'; //       resolved and ACTIVE — the register vouches for it

/**
 * Total, so a new `AgentStatus` fails to compile here rather than falling into
 * a permissive default.
 *
 * The value type EXCLUDES the two pre-row situations. `no_binding` and
 * `unresolvable` describe a request that never produced an agent row, so a map
 * FROM a status cannot yield them — and saying that in the type is what lets
 * `denialFor` below take a narrowed parameter instead of a total one with an
 * unreachable branch. An unreachable branch in a denial mapper is precisely
 * where a future standing would acquire a silent default.
 */
const STANDING_BY_STATUS: Readonly<
    Record<AgentStatus, Exclude<AgentGateStanding, 'no_binding' | 'unresolvable'>>
> = {
    DRAFT: 'draft',
    ACTIVE: 'vouched',
    SUSPENDED: 'suspended',
    RETIRED: 'retired',
};

export interface AgentGateVerdict {
    /** Whether the tenant is enforcing at all. */
    enforcing: boolean;
    /**
     * The agent the register VOUCHES for — non-null exactly when
     * `standing === 'vouched'`. Unchanged by #2399: every existing reader keeps
     * the meaning it was written against. Keys the tool grants, the policy card
     * and attribution.
     */
    agentId: string | null;
    /**
     * The agent this credential is BOUND to, as the register holds it —
     * whatever its standing. Non-null for every standing from `'draft'` onward;
     * `null` only for `'no_binding'` and `'unresolvable'`.
     *
     * A RAW FACT, and deliberately not a decision. Nothing may key an
     * authorization term off this field directly: "the register produced a row"
     * is not "this agent's controls apply". Read it through
     * `governedAgentIdOf`, which is where the standing rule lives.
     */
    subjectAgentId: string | null;
    /** Which of the seven situations produced this verdict. Always set. */
    standing: AgentGateStanding;
    /**
     * That agent's registered rung on the 0-6 autonomy ladder, or `null` when
     * no row resolved.
     *
     * Meaningful whenever `subjectAgentId` is non-null — NOT only when
     * `agentId` is. A suspended agent has a registered autonomy level and it is
     * the same number it had while ACTIVE; whether that number still binds is
     * `governedAgentIdOf`'s question, not this field's.
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
     * Meaningful whenever `subjectAgentId` is non-null. Read on its own it is
     * still ambiguous in exactly the way that takes the product dark: `null` here is
     * "unscored" when an agent resolved, and "there is no agent" when one did
     * not, and those must resolve to opposite ceilings. Callers build the term
     * with `riskTierCeilingFor(governed === null ? null : { riskTier })`, where
     * `governed` is `governedAgentIdOf(verdict)`, rather than passing this
     * field to `ceilingForRiskTier` directly.
     *
     * Read HERE, from the same row and the same query as `autonomyLevel`, for
     * the reason stated above it: a second read is a second answer to "which
     * agent is this", free to disagree with the first.
     */
    riskTier: AgentRiskTier | null;
    /**
     * Set only when the caller was refused — i.e. only when `enforcing`.
     *
     * DO NOT make this unconditional. `assertRegisteredAgent` throws on
     * `if (!verdict.reason)`, so a reason set in a non-enforcing tenant is a 403
     * for every opted-out tenant. `standing` is the unconditional field; this
     * one stays the refusal.
     */
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
            subjectAgentId: null,
            standing: 'no_binding',
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
            // `subjectAgentId` stays NULL here, unlike a stopped agent: the
            // register produced no row, so there is nothing for a control to be
            // measured against. "The id names something the register cannot
            // produce" and "the register produced a stopped agent" are
            // different situations, and `standing` is what keeps them apart.
            subjectAgentId: null,
            standing: 'unresolvable',
            autonomyLevel: null,
            riskTier: null,
            reason: enforcing ? 'agent_not_found' : null,
        };
    }
    const standing = STANDING_BY_STATUS[agent.status] ?? 'unknown_status';

    return {
        enforcing,
        // Still only the ACTIVE one. Every existing reader of this field keeps
        // exactly the meaning it was written against.
        agentId: standing === 'vouched' ? agent.id : null,
        subjectAgentId: agent.id,
        standing,
        autonomyLevel: agent.autonomyLevel,
        riskTier: agent.riskTier,
        reason: standing === 'vouched' ? null : enforcing ? denialFor(standing) : null,
    };
}

/**
 * The refusal a non-vouched standing earns in an enforcing tenant.
 *
 * The parameter type is the point: a standing added to the union that is
 * neither vouched nor unbound must be given a denial reason here or this does
 * not compile.
 */
function denialFor(
    standing: Exclude<AgentGateStanding, 'vouched' | 'no_binding'>,
): AgentGateDenialReason {
    return standing === 'unresolvable' ? 'agent_not_found' : 'agent_not_active';
}

/**
 * The agent whose own register-side controls GOVERN this invocation.
 *
 * ── WHY THIS IS A FUNCTION AND NOT A FIELD ──────────────────────────────────
 *
 * Two different questions were being answered by one null, and #2399 was the
 * bill for that. They are now separate:
 *
 *   `agentId`  — does the register VOUCH for this caller? Keys the tool grants,
 *                the policy card, attribution.
 *   this       — is there an agent whose own limits this call must be measured
 *                against? Keys the kill switch's AGENT arm, the circuit
 *                breaker, the autonomy ceiling and the behavioural ledger.
 *
 * They differ in exactly one situation, and it is the one an operator reaches
 * for first: a SUSPENDED agent. Suspension is the only status where somebody
 * took a deliberate action about this specific agent, and it is the gesture an
 * operator makes to contain something. So it governs while it is not vouched
 * for — and before #2399 it did neither, which is why suspending an agent
 * WIDENED its credential: the tool allowlist, both autonomy terms, the policy
 * card, the circuit breaker and the AGENT arm of its own kill switch all
 * dropped away at once.
 *
 * DRAFT and RETIRED deliberately do not govern. Nobody put a DRAFT agent into
 * service, a key cannot be minted against one, and an ACTIVE agent cannot be
 * moved back to DRAFT — so the state is not reachable by any supported path.
 * RETIRED is the open asymmetry and it is recorded as one in
 * `docs/implementation-notes/2026-09-10-suspension-is-a-boundary-control.md`.
 *
 * `unknown_status` governs, for the same reason it exists at all: an unknown
 * status must be contained, not admitted.
 *
 * THIS SWITCH HAS NO `default`, ON PURPOSE. An eighth standing added to the
 * union is a compile error here rather than a silent `null` — and a silent
 * `null` from this function is allow-all at three separate controls.
 */
export function governedAgentIdOf(verdict: AgentGateVerdict): string | null {
    switch (verdict.standing) {
        case 'vouched':
        case 'suspended':
        case 'unknown_status':
            return verdict.subjectAgentId;
        case 'no_binding':
        case 'unresolvable':
        case 'draft':
        case 'retired':
            return null;
    }
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
