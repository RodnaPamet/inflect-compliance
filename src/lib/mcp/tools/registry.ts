/**
 * MCP read-tool registry + the single execution funnel.
 *
 * `runReadTool` is the ONE path every MCP tool call takes. It:
 *   1. resolves the tool by name;
 *   2. AUTHORIZES the invocation through `authorizeToolCall` — deny-by-default
 *      tool exposure, the agent's versioned POLICY CARD, then the credential's
 *      resource scope, then the SAME `assertPermission` / `assertCan*` gate the
 *      equivalent human route uses, against the principal-narrowed context.
 *      Every refusal writes exactly one hash-chained `AUTHZ_DENIED` row;
 *   3. validates the agent's arguments against the tool's Zod schema;
 *   4. runs the tool — which calls exactly one existing read usecase with the
 *      tenant ctx (the usecase owns RLS + its own permission check);
 *   5. REDACTS the domains the acting principal may not see, for the tools whose
 *      payload spans more domains than their gate covers;
 *   6. audits the successful invocation as an `API_KEY` actor (who / which key
 *      / which tool / when).
 *
 * Because exposure, authorization, scope-enforcement, redaction and audit all
 * live HERE (not in each tool), a tool CANNOT self-authorize — there is nowhere
 * for it to do so — and the `mcp-server-coverage` ratchet can assert the whole
 * surface is gated by checking this one funnel plus that every tool declares an
 * `authorize` block.
 */
import { appendAuditEntry } from '@/lib/audit';
import { badRequest } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

import {
    applyRedaction,
    applyRowRedaction,
    authorizeToolCall,
    isToolLoadable,
    resolveOfferedTool,
    loadableSetOf,
    type McpInvocation,
} from '../authorize';
import { loadableToolsDigest } from '../loadable-tools';
import { RpcErrorCode, type McpToolDescriptor, type McpToolResult } from '../protocol';
import type { McpReadTool } from './types';
import { getCompliancePostureTool } from './get-compliance-posture';
import { listRisksTool } from './risk-tools';
import { listControlsTool, searchControlsTool } from './control-tools';
import { findCoverageGapsTool, getFrameworkStatusTool } from './framework-tools';
import { listEvidenceExpiringTool } from './evidence-tools';
import { listFindingsTool, listTasksTool } from './work-tools';
import { getTenantContextTool } from './context-tools';

/**
 * The registered read tools — the full tenant-inspection suite. Each is a thin
 * wrapper over an existing read usecase, scope-gated + audited by the funnel.
 */
// Tools are generic in their arg type; the registry stores them with the arg
// type erased to `unknown` (validation happens per-call via each tool's Zod
// `argsSchema`). The double-cast is the standard way to erase an invariant
// generic parameter without `any`.
export const READ_TOOLS = [
    getCompliancePostureTool,
    getTenantContextTool,
    listRisksTool,
    listControlsTool,
    searchControlsTool,
    findCoverageGapsTool,
    getFrameworkStatusTool,
    listEvidenceExpiringTool,
    listFindingsTool,
    listTasksTool,
] as unknown as ReadonlyArray<McpReadTool<unknown>>;

/**
 * MCP `tools/list` descriptors, filtered to what THIS invocation could actually
 * call: the tools it may LOAD — offered at assembly, granted in the register AND
 * permitted by the agent's policy card — and, of those, only the ones whose
 * permission keys the acting context holds.
 *
 * The card term is the one that was missing. This filter applied the grants and
 * stopped there, so an agent whose card narrowed its grants was still advertised
 * the wider list, and every call it planned against the difference 403'd — which
 * is the exact failure the next paragraph describes, arriving through the door
 * the filter was built to close.
 *
 * Advertising a tool an agent cannot call is not a security hole — the funnel
 * refuses it — but it is a correctness one: an agent plans against `tools/list`,
 * and a catalogue full of tools that 403 turns every plan into a sequence of
 * denials, each of which writes an `AUTHZ_DENIED` row. That row is the primary
 * rogue-agent signal (ASI10); a design that manufactures thousands of them from
 * ordinary planning is a design that trains operators to ignore it.
 */
export function listReadToolDescriptors(inv: McpInvocation): McpToolDescriptor[] {
    return READ_TOOLS.filter((t) => isToolLoadable(inv, t.name))
        .filter((t) => canSee(inv, t.authorize.keys))
        .map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        }));
}

/**
 * Advertising-time permission probe. Deliberately NOT the enforcement — it
 * writes no audit row and throws nothing, because a tool being absent from a
 * catalogue is not a denied access attempt. `authorizeToolCall` is the decision.
 */
function canSee(inv: McpInvocation, keys: readonly string[] | undefined): boolean {
    if (!keys || keys.length === 0) return true;
    const perms = inv.ctx.appPermissions as unknown as Record<
        string,
        Record<string, boolean> | undefined
    >;
    return keys.every((k) => {
        const [domain, action] = k.split('.');
        return perms[domain]?.[action] === true;
    });
}

export class McpToolNotFoundError extends Error {
    readonly rpcCode = RpcErrorCode.MethodNotFound;
    constructor(name: string) {
        super(`Unknown MCP tool: ${name}`);
        this.name = 'McpToolNotFoundError';
    }
}

/**
 * Execute a read tool through the full authorize → validate → usecase → redact
 * → audit chain. `inv` carries the EFFECTIVE, principal-narrowed context, the
 * principal's own authority, the agent, and that agent's tool allowlist —
 * assembled once per request by `buildMcpInvocation` so a tool cannot construct
 * its own. Throws:
 *   - `McpToolNotFoundError` for an unknown tool,
 *   - `forbidden` (via `authorizeToolCall`, after exactly one `AUTHZ_DENIED`
 *     row) for an ungranted tool, a missing capability or resource scope, or a
 *     principal who may not do this,
 *   - `badRequest` if the arguments fail validation,
 *   - whatever the underlying usecase throws.
 */
export async function runReadTool(
    inv: McpInvocation,
    name: string,
    rawArgs: unknown,
): Promise<McpToolResult> {
    // 0. LOAD the tool — through this invocation's pinned manifest, never
    //    straight out of `READ_TOOLS`. A name this build does not know at all is
    //    a protocol error (`null` below); a name the registry holds but this
    //    invocation's manifest never offered is a refusal with its own audit
    //    row. See `resolveOfferedTool` and `tool-manifest.ts`.
    const tool = await resolveOfferedTool(inv, READ_TOOLS, name);
    if (!tool) throw new McpToolNotFoundError(name);

    const ctx = inv.ctx;

    // 1. The one gate: token audience → credential liveness → deny-by-default
    //    exposure → the autonomy ceiling → the policy card → credential scope →
    //    the human route's own permission check. Audits exactly one row on
    //    whichever step refuses, and every one of them runs BEFORE step 3.
    //
    //    `capabilityClass: 'read'` is the AUTONOMY class, not a credential
    //    check: read tools deliberately carry no `capability`, because the
    //    endpoint gate already accepted `mcp:read` OR `mcp:propose` and
    //    re-checking here would newly refuse propose-only keys the read tools
    //    they can call today.
    //
    //    `rawArgs` goes in UNVALIDATED, and it has to: the policy card's data
    //    rung can depend on an argument, and validation happens at step 2 —
    //    after the gate, because nothing may run ahead of the gate.
    await authorizeToolCall(inv, { ...tool, capabilityClass: 'read' }, rawArgs);

    // 2. Validate arguments.
    const parsed = tool.argsSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
        throw badRequest(`Invalid arguments for tool "${name}": ${parsed.error.message}`);
    }

    // 3. Run the usecase (RLS + permission enforced inside the usecase).
    const data = await tool.run(ctx, parsed.data);

    // 4. Redact what the principal may not see. Sections first, then rows —
    //    both operate on a structural copy, so a tool can declare either or
    //    both without them fighting over the same object.
    const visible = applyRowRedaction(inv, tool.redactRows, applyRedaction(inv, tool.redact, data));

    // 5. Audit the invocation as an API_KEY actor, naming the card version that
    //    allowed it.
    await auditToolCall(
        ctx,
        name,
        inv.policyCard?.inForce.version ?? null,
        loadableToolsDigest(loadableSetOf(inv)),
    );

    return {
        content: [{ type: 'text', text: JSON.stringify(visible, null, 2) }],
    };
}

/**
 * Audit an MCP tool invocation. Attributed to the API key (M2M) — NOT a human
 * user — via `actorType: 'API_KEY'`, with the key id + tool recorded in
 * structured metadata. Best-effort: an audit-write failure must not fail the
 * tool call (the read already happened; the outer chain already RLS-scoped it).
 */
async function auditToolCall(
    ctx: RequestContext,
    tool: string,
    policyCardVersion: number | null,
    manifestDigest: string,
): Promise<void> {
    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: 'API_KEY',
        entity: 'McpTool',
        entityId: tool,
        action: 'MCP_TOOL_INVOKED',
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            tool,
            agentId: ctx.agentId ?? null,
            // Which policy-card version ALLOWED this call. The refusal rows
            // carry the same field, so a reader reconstructing what the rules
            // were does not have to infer the allow case from the absence of a
            // denial. `null` means the agent has no card.
            policyCardVersion,
            // A fingerprint of the SET of tools this invocation could load when
            // it made this call. Two calls in one run reporting different
            // digests is the rug-pull signal: the loadable set moved underneath
            // the agent. A digest and not the list — an audit row answers "same
            // or different", it is not a place to accumulate payload.
            toolManifestDigest: manifestDigest,
        },
        metadataJson: { apiKeyId: ctx.apiKeyId ?? null, scopes: ctx.apiKeyScopes ?? [] },
    }).catch(() => undefined);
}
