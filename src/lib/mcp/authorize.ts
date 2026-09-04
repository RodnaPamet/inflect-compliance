/**
 * Per-invocation authorization for MCP tool calls — the one gate, applied once
 * per tool call, reusing the checks the equivalent human route already makes.
 *
 * ## What runs, in order, and why that order
 *
 *   1. EXPOSURE — is this tool on the agent's allowlist? Deny-by-default.
 *   2. CAPABILITY — does the CREDENTIAL carry `mcp:propose`? (propose tools).
 *   3. RESOURCE SCOPE — does the CREDENTIAL carry `risks:read`?
 *   4. PERMISSION — may the PRINCIPAL do this? `assertPermission`, the SAME
 *      function `requirePermission` calls on the equivalent human route.
 *   5. POLICY — the shared `assertCanRead` / `assertCanWrite` the mirrored route
 *      applies, where `PermissionSet` has no key to name.
 *
 * Cheapest and least-revealing first, and CREDENTIAL checks before PRINCIPAL
 * checks. That ordering is not cosmetic: 1-3 are configuration — a key scoped
 * for controls calling a risks tool is an integration that needs a wider key,
 * and its refusal should say "scope", by name, so somebody can fix it. 4-5 are
 * the authority question, and a refusal there means the human this agent speaks
 * for genuinely may not do this. If the order were reversed, every under-scoped
 * integration would surface as a generic "Permission denied" and the audit trail
 * would fill with rows that look like an agent exceeding its authority when it
 * was only pointed at the wrong tool. An agent probing for reach it does not
 * have is the whole reason these rows exist; burying that in routine
 * misconfiguration is how a security signal stops being read.
 *
 * ## Exactly one audit row per denial
 *
 * Every refusal writes ONE hash-chained `AUTHZ_DENIED` row and throws. Step 4
 * does it inside `assertPermission` (the same row a denied human route writes,
 * `entity: 'Permission'`); every other step does it through `denyToolCall`
 * below (`entity: 'McpTool'`). The steps are ordered and each returns by
 * throwing, so no path can produce two rows — and the paths that used to produce
 * ZERO rows (a scope throw, a bare `assertCanRead` throw inside a usecase: what
 * an agent denial looked like before today) now produce one.
 *
 * ## The 403 never names the permission key
 *
 * `assertPermission` throws the generic `forbidden('Permission denied')`; the
 * key travels only in the audit row. The messages here name the TOOL and the
 * SCOPES, both of which the caller supplied or already holds, and nothing else.
 */
import { appendAuditEntry } from '@/lib/audit';
import { enforceApiKeyScope } from '@/lib/auth/api-key-auth';
import { forbidden } from '@/lib/errors/types';
import { logger } from '@/lib/observability/logger';
import { assertPermission } from '@/lib/security/permission-middleware';
import { assertCanRead, assertCanWrite } from '@/app-layer/policies/common';
import { isAppError } from '@/lib/errors/types';
import type { PermissionSet } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import type { AgentPrincipal } from '@/lib/agentic/agent-authority';

import { enforceMcpCapability } from './auth';
import type { McpToolAuthorization, ScopeAction } from './tools/types';

/** The MCP surface, for the audit row. Mirrors `requirePermission`'s reqMeta. */
export const MCP_SURFACE = { method: 'POST', path: '/api/mcp' } as const;

/**
 * Everything one tool call is authorized against. Assembled once per HTTP
 * request by the route and passed down, so a tool cannot construct its own.
 */
export interface McpInvocation {
    /** principal ∧ credential — what the tool runs on. */
    ctx: RequestContext;
    /** The principal's own authority. See agent-authority.ts. */
    principal: AgentPrincipal;
    /**
     * The registered agent the credential speaks for, when it resolved to a live
     * ACTIVE one. `null` means the tenant is not enforcing the register — see
     * `agent-tool-exposure.ts` for why that is not an exposure bypass.
     */
    agentId: string | null;
    /**
     * The tools this agent is granted. `null` when there is no agent, which is
     * the only state that skips the exposure check.
     */
    grantedTools: ReadonlySet<string> | null;
}

/** Why a tool call was refused, for the audit row an operator reads. */
export type McpDenialReason =
    | 'tool_not_granted'
    | 'capability_denied'
    | 'scope_denied'
    | 'policy_denied';

/**
 * Write ONE hash-chained `AUTHZ_DENIED` row and throw. Best-effort audit, on the
 * same principle as `requirePermission`'s: an audit outage must never turn a
 * refusal into an admission, so the throw happens whether or not the row landed.
 */
export async function denyToolCall(
    ctx: RequestContext,
    reason: McpDenialReason,
    detail: { tool: string; agentId: string | null; message: string; extra?: Record<string, unknown> },
): Promise<never> {
    try {
        await appendAuditEntry({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            actorType: 'API_KEY',
            entity: 'McpTool',
            entityId: detail.tool,
            action: 'AUTHZ_DENIED',
            details: `Agent tool call refused: ${reason} for ${detail.tool}`,
            detailsJson: {
                category: 'access',
                event: 'authz_denied',
                gate: 'mcp_tool_invocation',
                reason,
                tool: detail.tool,
                agentId: detail.agentId,
                apiKeyId: ctx.apiKeyId ?? null,
                role: ctx.role,
                method: MCP_SURFACE.method,
                path: MCP_SURFACE.path,
                ...(detail.extra ?? {}),
            },
            requestId: ctx.requestId,
            metadataJson: { apiKeyId: ctx.apiKeyId ?? null, reason, tool: detail.tool },
        });
    } catch (err) {
        logger.warn('audit: failed to record MCP AUTHZ_DENIED', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    throw forbidden(detail.message);
}

/** The permission set a tool's keys are evaluated against. */
function permissionsFor(inv: McpInvocation, authorize: McpToolAuthorization): PermissionSet {
    return authorize.basis === 'principal' ? inv.principal.appPermissions : inv.ctx.appPermissions;
}

/**
 * Is this tool exposed to this agent? Deny-by-default when there is an agent;
 * no list to consult when there is not.
 */
export function isToolExposed(inv: McpInvocation, toolName: string): boolean {
    if (inv.grantedTools === null) return true;
    return inv.grantedTools.has(toolName);
}

/**
 * The gate. Throws `forbidden` — after exactly one audit row — when this
 * invocation may not call this tool.
 */
export async function authorizeToolCall(
    inv: McpInvocation,
    tool: {
        name: string;
        authorize: McpToolAuthorization;
        resourceScope: { resource: string; action: ScopeAction };
        /** Propose tools only — the MCP capability the credential must carry. */
        capability?: 'read' | 'propose' | 'orchestrate';
    },
): Promise<void> {
    // 1. Deny-by-default exposure.
    if (!isToolExposed(inv, tool.name)) {
        await denyToolCall(inv.ctx, 'tool_not_granted', {
            tool: tool.name,
            agentId: inv.agentId,
            message:
                `This agent is not granted the "${tool.name}" tool. An administrator ` +
                'must grant it in the agent register before it can be called.',
        });
    }

    // 2. Credential capability (propose tools). Message preserved verbatim from
    //    `enforceMcpCapability` — it names a scope, not a permission key.
    if (tool.capability) {
        try {
            enforceMcpCapability(inv.ctx, tool.capability);
        } catch (err) {
            if (!isAppError(err)) throw err;
            await denyToolCall(inv.ctx, 'capability_denied', {
                tool: tool.name,
                agentId: inv.agentId,
                message: err.message,
                extra: { capability: tool.capability },
            });
        }
    }

    // 3. Credential resource scope. Same treatment: the existing message is the
    //    actionable one and is safe (it echoes scopes the caller already holds).
    try {
        enforceApiKeyScope(inv.ctx, tool.resourceScope.resource, tool.resourceScope.action);
    } catch (err) {
        if (!isAppError(err)) throw err;
        await denyToolCall(inv.ctx, 'scope_denied', {
            tool: tool.name,
            agentId: inv.agentId,
            message: err.message,
            extra: {
                resource: tool.resourceScope.resource,
                action: tool.resourceScope.action,
            },
        });
    }

    const { authorize } = tool;

    // 4. Permission keys — through the SAME `assertPermission` the human
    //    route's `requirePermission` calls. It audits its own denial and
    //    throws the generic 403, so nothing is added here.
    if (authorize.keys && authorize.keys.length > 0) {
        await assertPermission(
            { ...inv.ctx, appPermissions: permissionsFor(inv, authorize) },
            { keys: authorize.keys, mode: 'all' },
            MCP_SURFACE,
        );
    }

    // 5. The shared read/write policy, for a mirrored route that has no
    //    permission key to name. `assertCanRead` / `assertCanWrite` throw
    //    without auditing — which is precisely how an agent denial used to be
    //    invisible — so the throw is caught and turned into the one row.
    if (authorize.policy) {
        const permissions =
            authorize.basis === 'principal' ? inv.principal.permissions : inv.ctx.permissions;
        const probe: RequestContext = { ...inv.ctx, permissions };
        try {
            if (authorize.policy === 'write') assertCanWrite(probe);
            else assertCanRead(probe);
        } catch (err) {
            if (!isAppError(err)) throw err;
            await denyToolCall(inv.ctx, 'policy_denied', {
                tool: tool.name,
                agentId: inv.agentId,
                message: 'Permission denied',
                extra: { policy: authorize.policy, basis: authorize.basis },
            });
        }
    }
}

/**
 * Strip the sections of a result whose domain the acting context cannot see.
 *
 * Gating the CALL is not enough for a payload that aggregates several domains:
 * an agent whose principal cannot see risks must not receive risk counts because
 * the tool it called is nominally a controls tool. Paths are dotted and removed
 * from a structural copy; a path that does not exist is a no-op, so a payload
 * shape change degrades to "redacts nothing extra" rather than throwing.
 */
export function applyRedaction(
    inv: McpInvocation,
    rules: readonly { key: string; paths: readonly string[] }[] | undefined,
    data: unknown,
): unknown {
    if (!rules || rules.length === 0) return data;
    const perms = inv.ctx.appPermissions as unknown as Record<
        string,
        Record<string, boolean> | undefined
    >;
    const missing = rules.filter((r) => {
        const [domain, action] = r.key.split('.');
        return perms[domain]?.[action] !== true;
    });
    if (missing.length === 0) return data;

    // Structural clone via JSON: every tool result is already JSON-serialised
    // into the MCP text block one line later, so nothing survives this that
    // would have survived the wire.
    const copy = JSON.parse(JSON.stringify(data ?? null));
    for (const rule of missing) {
        for (const p of rule.paths) deletePath(copy, p);
    }
    // The marker tells the agent it is reading a PARTIAL answer. Without it a
    // redacted payload is indistinguishable from a tenant that has no risks,
    // and an agent reasoning over the difference would draw the opposite
    // conclusion from the right one.
    //
    // Only onto a plain object: spreading an array into an object literal turns
    // it into `{0: …, 1: …}` and silently breaks every consumer. No tool
    // declaring `redact` returns an array today; this is the guard against the
    // one that does.
    if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) return copy;
    return { ...(copy as Record<string, unknown>), redactedDomains: missing.map((m) => m.key) };
}

/**
 * Drop rows the acting context may not see from the arrays a tool declares.
 *
 * Composed after `applyRedaction` — it takes that pass's OUTPUT and clones
 * again, rather than mutating a shared object, so a tool can declare both
 * without either pass depending on whether the other ran. A path that is not an
 * array is a no-op: a payload shape change degrades to "filters nothing extra"
 * rather than throwing mid-response.
 */
export function applyRowRedaction(
    inv: McpInvocation,
    rules: readonly { path: string; keyOf: (row: unknown) => string | null }[] | undefined,
    data: unknown,
): unknown {
    if (!rules || rules.length === 0) return data;
    const perms = inv.ctx.appPermissions as unknown as Record<
        string,
        Record<string, boolean> | undefined
    >;
    const granted = (key: string): boolean => {
        const [domain, action] = key.split('.');
        return perms[domain]?.[action] === true;
    };

    const copy = JSON.parse(JSON.stringify(data ?? null));
    for (const rule of rules) {
        const parts = rule.path.split('.');
        let parent: unknown = copy;
        for (let i = 0; i < parts.length - 1; i++) {
            if (parent === null || typeof parent !== 'object') { parent = null; break; }
            parent = (parent as Record<string, unknown>)[parts[i]];
        }
        if (parent === null || typeof parent !== 'object') continue;
        const leaf = parts[parts.length - 1];
        const arr = (parent as Record<string, unknown>)[leaf];
        if (!Array.isArray(arr)) continue;
        (parent as Record<string, unknown>)[leaf] = arr.filter((row) => {
            const key = rule.keyOf(row);
            return key === null || granted(key);
        });
    }
    return copy;
}

function deletePath(root: unknown, dotted: string): void {
    const parts = dotted.split('.');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
        if (node === null || typeof node !== 'object') return;
        node = (node as Record<string, unknown>)[parts[i]];
    }
    if (node === null || typeof node !== 'object') return;
    delete (node as Record<string, unknown>)[parts[parts.length - 1]];
}
