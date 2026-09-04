/**
 * MCP request authentication — the single entry gate for /api/mcp.
 *
 * INHERITS the existing machine-to-machine auth exactly: a Bearer TenantApiKey
 * is verified by `verifyApiKey` (the SAME function every public `/api/**` route
 * uses via `getLegacyCtx`), producing a full RLS-scoped `RequestContext`
 * (tenantId, userId = key creator, role, appPermissions derived from scopes,
 * apiKeyId, apiKeyScopes). There is NO parallel auth path — the MCP server is a
 * thin adapter over this.
 *
 * On top of key verification, MCP access requires the `mcp:read` CAPABILITY
 * scope — a key valid for the REST API cannot reach the agent surface unless it
 * was explicitly minted with `mcp:read`. Individual tools then additionally
 * enforce their RESOURCE scope (e.g. `risks:read`) + the usecase's own
 * permission check + RLS. `mcp:read` is the "may talk to MCP at all" gate;
 * resource scopes gate individual tools.
 *
 * THIRD GATE, and it asks a different question from the other two. Scope asks
 * what a credential may do; the agent-registration gate asks WHO IS ACTING. A
 * tenant with `requireRegisteredAgent` on refuses a key that does not name an
 * ACTIVE `RegisteredAgent`, however widely scoped that key is — so the register
 * is what decides which agents may run, and suspending an agent there actually
 * stops its traffic. Refusals write a hash-chained `AUTHZ_DENIED` row.
 *
 * The gate runs LAST, after key verification and the capability check, for the
 * same reason the read-tier rate limiter sits after the JWT gate: an
 * unauthenticated or unscoped caller should get the cheaper refusal, and the
 * expensive one should not be reachable by anyone holding no valid key.
 *
 * FOURTH GATE (Epic Agentic 2), and it asks the question the other three cannot:
 * WHOSE AUTHORITY IS THIS? `verifyApiKey` derives `role` and `appPermissions`
 * from the KEY'S SCOPES alone, so a key minted with `risks:write` by a READER
 * resolves to EDITOR with `risks.create` — reach its principal never had. That
 * is the confused deputy exactly as documented: ambient scope, no per-action
 * check against the requesting identity. `resolveAgentAuthority` resolves the
 * principal through the SAME `resolveTenantContext` a signed-in human goes
 * through and intersects the two, so the credential can never exceed the person
 * it speaks for. A principal that no longer resolves is a refusal, audited with
 * a reason naming the credential to rebind — see `agent-authority.ts`.
 */
import type { NextRequest } from 'next/server';

import { extractBearerToken, verifyApiKey } from '@/lib/auth/api-key-auth';
import {
    assertRegisteredAgent,
    evaluateAgentRegistration,
} from '@/lib/agentic/agent-registration-gate';
import {
    resolveAgentAuthority,
    PrincipalUnresolvedError,
    type AgentPrincipal,
    type PrincipalDenialReason,
} from '@/lib/agentic/agent-authority';
import { listGrantedToolNames } from '@/lib/agentic/agent-tool-exposure';
import { appendAuditEntry } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { unauthorized, forbidden } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

import type { McpInvocation } from './authorize';

/**
 * Enforce an MCP capability scope (`mcp:read` or `mcp:propose`). Mirrors
 * `enforceApiKeyScope`'s grant logic (`*` / `mcp:*` / `mcp:<cap>`). `mcp:read`
 * is the endpoint gate; `mcp:propose` gates the propose-not-commit write tools
 * and is strictly more privileged. Throws `forbidden` when the key lacks it.
 */
export function enforceMcpCapability(ctx: RequestContext, capability: 'read' | 'propose' | 'orchestrate'): void {
    const scopes = ctx.apiKeyScopes;
    // Session-auth (no api key) — MCP is API-key only, but be defensive.
    if (!scopes) return;
    if (scopes.includes('*') || scopes.includes('mcp:*') || scopes.includes(`mcp:${capability}`)) return;
    throw forbidden(`API key does not have the "mcp:${capability}" capability scope.`);
}

export interface McpAuthResult {
    /**
     * The EFFECTIVE context — principal ∧ credential. Every tool runs on this,
     * never on the raw key context, which is why it is the only `ctx` this
     * module returns.
     */
    ctx: RequestContext;
    /** Everything one tool call is authorized against. */
    invocation: McpInvocation;
}

const PRINCIPAL_DENIAL_MESSAGE: Record<PrincipalDenialReason, string> = {
    principal_not_a_member:
        'The user this API key was created by is no longer a member of this tenant. An agent holds its principal\'s authority and no more, so the key must be re-minted by a current member.',
    principal_deactivated:
        'The user this API key was created by has been deactivated. An agent holds its principal\'s authority and no more.',
    principal_removed:
        'The user this API key was created by has been removed from this tenant. An agent holds its principal\'s authority and no more.',
    principal_tenant_unavailable:
        'This API key\'s principal could not be resolved in this tenant.',
};

/**
 * The refusal when a credential\'s principal no longer resolves. ONE
 * hash-chained `AUTHZ_DENIED` row, best-effort, then the 403 — the same shape
 * the registration gate uses, because it is the same class of event.
 */
async function denyUnresolvedPrincipal(
    ctx: RequestContext,
    reason: PrincipalDenialReason,
    surface: { method: string; path: string },
): Promise<never> {
    try {
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'API_KEY',
            // The KEY, not the user — the credential is the thing an operator
            // has to act on, and the user is already in `userId`.
            entity: 'TenantApiKey',
            entityId: ctx.apiKeyId ?? 'unknown-api-key',
            action: 'AUTHZ_DENIED',
            details: `Agent principal unresolved for ${surface.method} ${surface.path}`,
            detailsJson: {
                category: 'access',
                event: 'authz_denied',
                gate: 'agent_principal',
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
        logger.warn('audit: failed to record agent-principal AUTHZ_DENIED', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    throw forbidden(PRINCIPAL_DENIAL_MESSAGE[reason]);
}

/**
 * Authenticate an MCP HTTP request. Returns the tenant-scoped RequestContext
 * on success. Throws `unauthorized` if the Bearer key is missing/invalid,
 * `forbidden` if the key lacks an MCP capability scope, and `forbidden` again
 * (with a hash-chained `AUTHZ_DENIED` row) if the tenant requires registered
 * agents and this key does not name an ACTIVE one.
 */
export async function authenticateMcpRequest(
    req: NextRequest,
): Promise<McpAuthResult> {
    const token = extractBearerToken(req.headers.get('authorization'));
    if (!token) {
        throw unauthorized('MCP requires a Bearer TenantApiKey');
    }

    const clientIp =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        req.headers.get('x-real-ip') ??
        null;

    const result = await verifyApiKey(token, clientIp);
    if (!result.valid) {
        throw unauthorized(`API key authentication failed: ${result.reason}`);
    }

    // Capability gate: the key must carry an MCP capability — `mcp:read`
    // (read tools) or `mcp:propose` (propose tools), or `mcp:*` / `*`. Individual
    // read tools still require `mcp:read`; propose tools require `mcp:propose`.
    const scopes = result.ctx.apiKeyScopes ?? [];
    const hasMcp = scopes.includes('*') || scopes.includes('mcp:*') || scopes.includes('mcp:read') || scopes.includes('mcp:propose');
    if (!hasMcp) {
        throw forbidden('API key does not have an MCP capability scope (mcp:read / mcp:propose).');
    }

    // Agent-registration gate. Throws (and audits) when this tenant requires
    // every agent to be in the register and this credential is not bound to an
    // ACTIVE one.
    //
    // Its return value is the LIVE ACTIVE agent, or null — a narrower thing than
    // `ctx.agentId`, and the two are used for different jobs. This value keys the
    // deny-by-default tool allowlist, which must apply only to an agent the
    // register currently vouches for. `ctx.agentId` remains the ATTRIBUTION: a
    // proposal made by an agent whose tenant does not enforce the gate is still
    // that agent's proposal, and narrowing the attribution to "only when ACTIVE"
    // would write those rows unattributed. The gate decides whether the request
    // runs and what it may reach; it does not decide who made it.
    const surface = { method: req.method, path: new URL(req.url).pathname };
    const agentId = await assertRegisteredAgent(result.ctx, surface);

    const invocation = await buildMcpInvocation(result.ctx, agentId, surface);
    return { ctx: invocation.ctx, invocation };
}

/**
 * Assemble everything one tool call is authorized against.
 *
 * Exported because `/api/mcp` is not the only caller of the tool funnel: the
 * agentic workflow engine composes the same tools under a run model, and its
 * whole premise is that it "adds orchestration, NOT new authority". That is only
 * true while it enters through this door. `resolveMcpInvocation` below is the
 * engine's entry point.
 *
 * Throws `forbidden` — after exactly one hash-chained `AUTHZ_DENIED` row — when
 * the credential's principal no longer resolves.
 */
export async function buildMcpInvocation(
    keyCtx: RequestContext,
    agentId: string | null,
    surface: { method: string; path: string },
): Promise<McpInvocation> {
    // Authority: resolve the human this credential speaks for and narrow the
    // context to what BOTH of them hold. A SESSION context has already been
    // through `resolveTenantContext` in `getTenantCtx`, so it IS its own
    // principal and re-resolving would be a second identical query — the
    // narrowing only has anything to do when a credential is involved.
    let ctx = keyCtx;
    let principal: AgentPrincipal = {
        userId: keyCtx.userId,
        role: keyCtx.role,
        appPermissions: keyCtx.appPermissions,
        permissions: keyCtx.permissions,
    };

    if (keyCtx.apiKeyId) {
        try {
            const authority = await resolveAgentAuthority(keyCtx);
            ctx = authority.ctx;
            principal = authority.principal;
        } catch (err) {
            if (err instanceof PrincipalUnresolvedError) {
                await denyUnresolvedPrincipal(keyCtx, err.reason, surface);
            }
            throw err;
        }
    }

    // Deny-by-default exposure list, read fresh per request so a revoke takes
    // effect on the next call. `null` when the caller is bound to no live ACTIVE
    // agent — a signed-in human, or a tenant that has switched the register off.
    // See `agent-tool-exposure.ts` for why that is not an exposure bypass.
    const grantedTools = agentId ? await listGrantedToolNames(ctx.tenantId, agentId) : null;

    return { ctx, principal, agentId, grantedTools };
}

/**
 * The workflow engine's entry point into the tool funnel.
 *
 * Uses `evaluateAgentRegistration` rather than `assertRegisteredAgent`: the
 * engine's own route has already decided whether the caller may start a run, and
 * re-running the registration REFUSAL here would add a second, differently-timed
 * denial to a path that already has one. What it needs from the register is the
 * resolved agent id, so the deny-by-default tool allowlist applies to an
 * agent-driven run exactly as it does to a direct tool call — otherwise
 * orchestration would be a way around it, which is the one thing the engine
 * promises it is not.
 */
export async function resolveMcpInvocation(ctx: RequestContext): Promise<McpInvocation> {
    const verdict = await evaluateAgentRegistration(ctx);
    return buildMcpInvocation(ctx, verdict.agentId, {
        method: 'POST',
        path: '/api/mcp (workflow engine)',
    });
}
