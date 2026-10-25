/**
 * /api/mcp — IC's remote MCP (Model Context Protocol) server.
 *
 * A THIN ADAPTER: it speaks the MCP JSON-RPC wire protocol over HTTP and
 * routes every tool/resource call through IC's EXISTING secured chain —
 *   Bearer TenantApiKey (or an RFC 8693 exchanged token, which resolves to
 *   one) → verifyApiKey → registration gate → principal
 *   resolution (the SAME resolveTenantContext a human goes through) →
 *   EFFECTIVE RequestContext (principal ∧ credential) →
 *   (per tool) token audience → live-credential re-check → deny-by-default
 *   exposure → autonomy ceiling → assertPermission / assertCan* — the
 *   SAME gate the equivalent human route uses → enforceApiKeyScope → usecase
 *   (runInTenantContext RLS + its own permission check) → per-domain redaction
 *   → appendAuditEntry.
 * It NEVER queries Prisma directly and NEVER invents an auth path. A second
 * tenant's key sees only its own data because RLS binds `app.tenant_id` from
 * the key's tenant on every usecase transaction.
 *
 * Phase 1 is READ-ONLY (tools + resources). Writes are the Phase-3
 * propose-not-commit surface — no tool here mutates.
 *
 * Transport: streamable HTTP, JSON responses only (no server-initiated SSE —
 * read tools need none). `withApiErrorHandling` gives the observability span,
 * request-id and AppError→HTTP mapping every REST route gets.
 *
 * Rate limiting is TWO budgets, because the default mutation tier keyed on the
 * caller's IP was the wrong unit here: a hosted MCP client calls from its
 * provider's egress addresses, so every customer agent hosted there would have
 * shared one bucket. Before authentication, `MCP_IP_CEILING_LIMIT` bounds what
 * one address can make the key lookup do. After it, `MCP_PER_KEY_LIMIT` is
 * the per-caller budget, keyed on the verified `apiKeyId` and charged per
 * JSON-RPC message, so a batch cannot carry more than a minute's budget.
 *
 * Every read tool call's arguments pass the AI Guard's egress slice before the
 * funnel runs (`assertMcpArgumentsAllowed`) — the slice `runGuardedTool` runs
 * for agents Inflect hosts, which this door used to skip. Propose calls are
 * scanned by the proposal queue itself.
 */
import { NextRequest } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { isAppError, unauthorized } from '@/lib/errors/types';
import {
    enforceApiKeyRateLimit,
    isRateLimitBypassed,
    MCP_PER_KEY_LIMIT,
    MCP_IP_CEILING_LIMIT,
} from '@/lib/security/rate-limit-middleware';
import { completeMcpAuthentication, verifyMcpCredential } from '@/lib/mcp/auth';
import { assertMcpArgumentsAllowed } from '@/lib/mcp/argument-guard';
import {
    dispatchMcp,
    rpcError,
    RpcErrorCode,
    type JsonRpcRequest,
    type JsonRpcResponse,
    type McpHandlers,
} from '@/lib/mcp/protocol';
import { listReadToolDescriptors, runReadTool, McpToolNotFoundError } from '@/lib/mcp/tools/registry';
import { approvedToolDescriptors } from '@/lib/agentic/tool-manifest-store';
import {
    listProposeToolDescriptors,
    runProposeTool,
    isProposeTool,
    McpProposeToolNotFoundError,
} from '@/lib/mcp/tools/propose-tools';
import { listMcpResources, readMcpResource } from '@/lib/mcp/resources';

export const runtime = 'nodejs';

/**
 * POST /api/mcp — the single JSON-RPC endpoint. Auth failures (missing/invalid
 * key, missing `mcp:read` scope) surface as HTTP 401/403 (transport-level).
 * Tool/resource errors surface IN-BAND as JSON-RPC errors (HTTP 200) so the
 * client's MCP session stays intact and no internal detail leaks.
 */
export const POST = withApiErrorHandling(async (req: NextRequest) => {
    // Transport-level auth, step one — throws unauthorized/forbidden → HTTP
    // 401/403. Only the credential and its MCP scope: cheap, and enough to know
    // which key to charge. Building the invocation is step two, after the
    // charge (#4205).
    const verified = await verifyMcpCredential(req);

    // ── The per-key budget, charged per MESSAGE, before any work ────────────
    //
    // The bucket is the VERIFIED key, not anything the caller can vary. Every
    // `/api/mcp` caller presents an API key (an exchanged token resolves to its
    // issuing key), so a missing id is a broken invariant, refused rather than
    // pooled into a shared bucket.
    //
    // Charged BEFORE the invocation is built, because building it sends a live
    // `tools/list` to every external connection the agent has grants on. A key
    // over its budget used to drive those calls on every request before its
    // 429. A malformed request is charged too, one unit, because it is still a
    // request: it used to cost nothing (#4205).
    const charge = (units: number): Response | undefined => {
        if (isRateLimitBypassed()) return undefined;
        const apiKeyId = verified.keyCtx.apiKeyId;
        if (!apiKeyId) {
            throw unauthorized('MCP requires a Bearer TenantApiKey');
        }
        return enforceApiKeyRateLimit({
            scope: 'mcp-api-key',
            config: MCP_PER_KEY_LIMIT,
            apiKeyId,
            units,
        }).response;
    };

    let payload: unknown;
    try {
        payload = await req.json();
    } catch {
        return (
            charge(1) ??
            jsonResponse(rpcError(null, RpcErrorCode.ParseError, 'Invalid JSON'), { status: 400 })
        );
    }

    // JSON-RPC allows a single request or a batch (array).
    const requests = Array.isArray(payload) ? payload : [payload];

    // A batch larger than the whole budget could never fit, so it is refused
    // as a malformed request rather than told to retry. An empty batch is
    // malformed too: JSON-RPC 2.0 answers it with one Invalid Request error.
    // Each costs one unit.
    if (requests.length === 0 || requests.length > MCP_PER_KEY_LIMIT.maxAttempts) {
        const message =
            requests.length === 0
                ? 'An empty batch is not a valid request.'
                : `Batch of ${requests.length} messages exceeds the limit of ` +
                  `${MCP_PER_KEY_LIMIT.maxAttempts} per minute per API key; send smaller batches.`;
        return (
            charge(1) ??
            jsonResponse(rpcError(null, RpcErrorCode.InvalidRequest, message), { status: 400 })
        );
    }

    const limited = charge(requests.length);
    if (limited) return limited;

    // Transport-level auth, step two: the registration gate and the invocation.
    //
    // `invocation` carries everything one tool call is authorized against: the
    // EFFECTIVE context (the principal's authority intersected with the
    // credential's scopes), the principal's own permissions, the registered
    // agent, and that agent's deny-by-default tool allowlist. It is built once
    // per HTTP request and passed down, so a tool cannot construct its own —
    // which is what makes "no tool self-authorizes" a structural property
    // rather than a convention.
    const { invocation } = await completeMcpAuthentication(verified);

    const handlers: McpHandlers = {
        // The catalogue is filtered TWICE and the second filter is the newer
        // one: first to what this agent is granted and its principal may see,
        // then to the tools whose DEFINITION this tenant has approved. The
        // second is where tool poisoning is stopped, because `tools/list` is
        // where a description is delivered into the model's context — it does
        // its work there whether or not that tool is ever called. See
        // `approvedToolDescriptors`.
        listTools: () =>
            approvedToolDescriptors(invocation.ctx.tenantId, [
                ...listReadToolDescriptors(invocation),
                ...listProposeToolDescriptors(invocation),
            ]),
        // Read tools and propose (write-proposal) tools share the endpoint. Read
        // tools require the resource scope; propose tools additionally require
        // the mcp:propose capability. A propose tool NEVER creates a record — it
        // queues a human-approved proposal.
        //
        // A read's arguments are guarded after the gate and before the read
        // runs: `beforeRun` is called once the tool has resolved and passed
        // `authorizeToolCall` (#4205). A propose call is not scanned here: the
        // queue scans the proposed content itself and quarantines a non-clean
        // item as a row a reviewer sees (see `assertMcpArgumentsAllowed`).
        callTool: async (name, args) => {
            if (isProposeTool(name)) return runProposeTool(invocation, name, args);
            return runReadTool(invocation, name, args, {
                beforeRun: () => assertMcpArgumentsAllowed(invocation.ctx, name, args),
            });
        },
        // Resources take the INVOCATION, not a bare ctx. Until this change they
        // were the one door into `/api/mcp` that skipped the shared gate: scope
        // enforcement only, no audit row on refusal, no audience, no ceiling.
        listResources: () => listMcpResources(invocation),
        readResource: (uri) => readMcpResource(invocation, uri),
    };

    const responses: JsonRpcResponse[] = [];

    for (const raw of requests) {
        const request = raw as JsonRpcRequest;
        const id = request?.id ?? null;
        try {
            const response = await dispatchMcp(request, handlers);
            if (response !== null) responses.push(response);
        } catch (err) {
            responses.push(toRpcError(id, err));
        }
    }

    // All notifications → 202 with no body.
    if (responses.length === 0) {
        return new Response(null, { status: 202 });
    }

    const body = Array.isArray(payload) ? responses : responses[0];
    return jsonResponse(body);
}, {
    // The pre-authentication ceiling, in its own scope: MCP traffic no longer
    // shares the `api-mutation` bucket every other route called from the same
    // address draws on. See `MCP_IP_CEILING_LIMIT` for the sizing.
    rateLimit: { config: MCP_IP_CEILING_LIMIT, scope: 'mcp-ip' },
});

/**
 * GET /api/mcp — this server does not open a server-initiated SSE stream (read
 * tools produce no server→client notifications). Return 405 per the streamable
 * HTTP transport's optional-GET semantics.
 */
export function GET() {
    return jsonResponse(
        { error: 'method_not_allowed', message: 'MCP requests use POST' },
        { status: 405 },
    );
}

/**
 * Map a thrown error to a JSON-RPC error, preserving the request id and never
 * leaking internals. AppErrors (unauthorized/forbidden/badRequest) carry a
 * safe public message; anything else collapses to a generic InternalError.
 */
function toRpcError(id: JsonRpcRequest['id'], err: unknown): JsonRpcResponse {
    if (err instanceof McpToolNotFoundError || err instanceof McpProposeToolNotFoundError) {
        return rpcError(id ?? null, RpcErrorCode.MethodNotFound, err.message);
    }
    if (isAppError(err)) {
        // forbidden/badRequest/unauthorized messages are caller-safe by design.
        const code =
            err.status === 400 ? RpcErrorCode.InvalidParams : RpcErrorCode.InvalidRequest;
        return rpcError(id ?? null, code, err.message);
    }
    return rpcError(id ?? null, RpcErrorCode.InternalError, 'Internal error');
}
