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
 */
import type { NextRequest } from 'next/server';

import { extractBearerToken, verifyApiKey } from '@/lib/auth/api-key-auth';
import { assertRegisteredAgent } from '@/lib/agentic/agent-registration-gate';
import { unauthorized, forbidden } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

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
    ctx: RequestContext;
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
    // Its return value is deliberately DISCARDED. `verifyApiKey` already put the
    // credential's own binding on `ctx.agentId`, and that is the right value for
    // attribution: a proposal made by an agent whose tenant does not enforce the
    // gate is still that agent's proposal, and narrowing the id to "only when
    // ACTIVE" would write those rows unattributed. The gate decides whether the
    // request runs; it does not decide who made it.
    await assertRegisteredAgent(result.ctx, {
        method: req.method,
        path: new URL(req.url).pathname,
    });

    return { ctx: result.ctx };
}
