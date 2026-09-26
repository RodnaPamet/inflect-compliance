/**
 * MCP wire protocol — JSON-RPC 2.0 over streamable HTTP.
 *
 * We implement the Model Context Protocol wire format DIRECTLY rather than
 * pulling in `@modelcontextprotocol/sdk`, for two reasons:
 *   1. The SDK's `StreamableHTTPServerTransport` is built around Node's
 *      `http.IncomingMessage` / `ServerResponse`; Next.js App Router route
 *      handlers speak the Web `Request` / `Response` API. Bridging the two is
 *      fragile and would fight the framework.
 *   2. "Thin adapter" is the whole design ethos of IC's MCP server — a small,
 *      auditable JSON-RPC handler that we fully control keeps every tool call
 *      on the existing TenantApiKey → RLS → permission → usecase → audit chain
 *      with no hidden transport behaviour.
 *
 * This module is PURE protocol: JSON-RPC framing + MCP method dispatch. It
 * knows nothing about auth, tenants, or tools — the route wires those in via
 * the `McpHandlers` callbacks. For a read/propose tool server there are no
 * server-initiated messages, so every request gets a single JSON response
 * (`application/json`); the SSE branch of streamable HTTP is unnecessary.
 */

/** The protocol revisions this server understands. Newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const SERVER_INFO = {
    name: 'inflect-compliance-mcp',
    version: '1.0.0',
} as const;

// ─── JSON-RPC 2.0 types ───

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: JsonRpcId;
    method: string;
    params?: unknown;
}

export interface JsonRpcSuccess {
    jsonrpc: '2.0';
    id: JsonRpcId;
    result: unknown;
}

export interface JsonRpcError {
    jsonrpc: '2.0';
    id: JsonRpcId;
    error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** Standard JSON-RPC + MCP error codes. */
export const RpcErrorCode = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
} as const;

export function rpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
    return { jsonrpc: '2.0', id, result };
}

export function rpcError(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
): JsonRpcError {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// ─── MCP tool / resource shapes ───

export interface McpToolDescriptor {
    name: string;
    description: string;
    /** JSON Schema for the tool's arguments (draft-07 subset). */
    inputSchema: Record<string, unknown>;
    /**
     * MCP tool annotations, as the server declared them — `readOnlyHint`,
     * `destructiveHint`, `idempotentHint`, `openWorldHint`.
     *
     * Kept rather than dropped because the subsystem that governs external
     * WRITES turns on exactly one question: is this tool a write? MCP has a
     * declared answer and this client discarded it at the boundary, so the
     * field could not be pinned — and a server could flip `readOnlyHint` from
     * true to false and produce an IDENTICAL manifest hash.
     *
     * Advisory by the spec's own words, and treated as such: it is ATTESTED,
     * never trusted. Measured 2026-09-26 against Microsoft's Entra MCP server,
     * whose three tools all declare `readOnlyHint: true`.
     */
    annotations?: Record<string, unknown>;
}

export interface McpResourceDescriptor {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}

/** A tool result — MCP `content` blocks. IC tools always return one text block
 *  carrying a JSON-serialised structured result the agent can reason over. */
export interface McpToolResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

export interface McpResourceContents {
    contents: Array<{ uri: string; mimeType?: string; text: string }>;
}

/**
 * The tenant-scoped callbacks the route supplies. Each already runs the
 * authenticated, RLS-scoped, audited chain — this protocol layer just routes
 * to them.
 */
export interface McpHandlers {
    listTools: () => McpToolDescriptor[] | Promise<McpToolDescriptor[]>;
    callTool: (name: string, args: unknown) => Promise<McpToolResult>;
    listResources: () => McpResourceDescriptor[] | Promise<McpResourceDescriptor[]>;
    readResource: (uri: string) => Promise<McpResourceContents>;
}

// ─── Dispatch ───

/**
 * Route a single JSON-RPC request to the matching MCP method. Returns the
 * JSON-RPC response, or `null` for a notification (no `id`) which gets a bare
 * 202 with no body.
 *
 * Handler exceptions are NOT swallowed here — the route maps AppErrors
 * (unauthorized/forbidden) to the right HTTP status, and unexpected throws to
 * a JSON-RPC InternalError, so tool-level failures never leak internals.
 */
export async function dispatchMcp(
    request: JsonRpcRequest,
    handlers: McpHandlers,
): Promise<JsonRpcResponse | null> {
    const { id = null, method, params } = request;
    const isNotification = request.id === undefined;

    switch (method) {
        case 'initialize': {
            const requested =
                (params as { protocolVersion?: string } | undefined)?.protocolVersion;
            const protocolVersion =
                requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
                    ? requested
                    : LATEST_PROTOCOL_VERSION;
            return rpcSuccess(id, {
                protocolVersion,
                capabilities: { tools: {}, resources: {} },
                serverInfo: SERVER_INFO,
                instructions:
                    'IC compliance MCP server. Read-only tenant-inspection tools. ' +
                    'All results are scoped to the authenticated tenant. This server ' +
                    'never mutates data directly — any write capability is a human-approved proposal.',
            });
        }

        case 'notifications/initialized':
        case 'notifications/cancelled':
            // Client-side notifications — acknowledge with no response.
            return null;

        case 'ping':
            return rpcSuccess(id, {});

        case 'tools/list':
            return rpcSuccess(id, { tools: await handlers.listTools() });

        case 'tools/call': {
            const p = params as { name?: string; arguments?: unknown } | undefined;
            if (!p?.name) return rpcError(id, RpcErrorCode.InvalidParams, 'Missing tool name');
            const result = await handlers.callTool(p.name, p.arguments ?? {});
            return rpcSuccess(id, result);
        }

        case 'resources/list':
            return rpcSuccess(id, { resources: await handlers.listResources() });

        case 'resources/read': {
            const p = params as { uri?: string } | undefined;
            if (!p?.uri) return rpcError(id, RpcErrorCode.InvalidParams, 'Missing resource uri');
            return rpcSuccess(id, await handlers.readResource(p.uri));
        }

        default:
            if (isNotification) return null;
            return rpcError(id, RpcErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
}
