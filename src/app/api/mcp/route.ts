/**
 * /api/mcp — IC's remote MCP (Model Context Protocol) server.
 *
 * A THIN ADAPTER: it speaks the MCP JSON-RPC wire protocol over HTTP and
 * routes every tool/resource call through IC's EXISTING secured chain —
 *   Bearer TenantApiKey → verifyApiKey → registration gate → principal
 *   resolution (the SAME resolveTenantContext a human goes through) →
 *   EFFECTIVE RequestContext (principal ∧ credential) →
 *   (per tool) deny-by-default exposure → assertPermission / assertCan* — the
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
 * request-id, rate limiting (mutation tier on POST), and AppError→HTTP mapping
 * every REST route gets.
 */
import { NextRequest } from 'next/server';

import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { isAppError } from '@/lib/errors/types';
import { authenticateMcpRequest } from '@/lib/mcp/auth';
import {
    dispatchMcp,
    rpcError,
    RpcErrorCode,
    type JsonRpcRequest,
    type JsonRpcResponse,
    type McpHandlers,
} from '@/lib/mcp/protocol';
import { listReadToolDescriptors, runReadTool, McpToolNotFoundError } from '@/lib/mcp/tools/registry';
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
    // Transport-level auth — throws unauthorized/forbidden → HTTP 401/403.
    //
    // `invocation` carries everything one tool call is authorized against: the
    // EFFECTIVE context (the principal's authority intersected with the
    // credential's scopes), the principal's own permissions, the registered
    // agent, and that agent's deny-by-default tool allowlist. It is built once
    // per HTTP request and passed down, so a tool cannot construct its own —
    // which is what makes "no tool self-authorizes" a structural property
    // rather than a convention.
    const { ctx, invocation } = await authenticateMcpRequest(req);

    let payload: unknown;
    try {
        payload = await req.json();
    } catch {
        return jsonResponse(
            rpcError(null, RpcErrorCode.ParseError, 'Invalid JSON'),
            { status: 400 },
        );
    }

    const handlers: McpHandlers = {
        listTools: () => [
            ...listReadToolDescriptors(invocation),
            ...listProposeToolDescriptors(invocation),
        ],
        // Read tools and propose (write-proposal) tools share the endpoint. Read
        // tools require the resource scope; propose tools additionally require
        // the mcp:propose capability. A propose tool NEVER creates a record — it
        // queues a human-approved proposal.
        callTool: (name, args) =>
            isProposeTool(name)
                ? runProposeTool(invocation, name, args)
                : runReadTool(invocation, name, args),
        listResources: () => listMcpResources(ctx),
        readResource: (uri) => readMcpResource(ctx, uri),
    };

    // JSON-RPC allows a single request or a batch (array).
    const requests = Array.isArray(payload) ? payload : [payload];
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
