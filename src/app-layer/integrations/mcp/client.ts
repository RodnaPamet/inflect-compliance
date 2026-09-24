/**
 * OUTBOUND MCP — the client half, so an agent can inspect a system this
 * deployment does not own.
 *
 * ── WHY THIS IS NOT UNDER `src/lib/mcp/` ────────────────────────────────────
 *
 * That directory is the SERVER: the inbound JSON-RPC handler, and
 * `tests/guardrails/mcp-server-coverage.test.ts` refuses ANY Prisma import
 * beneath it — the lock that stops a tool bypassing the
 * `TenantApiKey -> RLS -> permission -> usecase -> audit` chain. A client is
 * the opposite direction and will eventually need a connection row, so it
 * belongs with the integrations rather than inside that lock.
 *
 * The wire shapes are IMPORTED from the server's `protocol.ts` rather than
 * restated. One dialect, one place: a client that re-declared
 * `JsonRpcRequest` would drift from the server the first time either moved,
 * and the two are meant to speak the same protocol.
 *
 * ── EVERY REQUEST GOES THROUGH `safeFetch` ──────────────────────────────────
 *
 * An MCP server URL is tenant-supplied, which makes it exactly the SSRF
 * primitive `automation/webhook-safety.ts` was written for. That module
 * already does more than a fresh implementation would have: https only, DNS
 * re-resolution of every address to defeat rebinding, the connection PINNED
 * to those pre-validated IPs through an undici dispatcher so DNS cannot move
 * between check and connect, the hostname preserved for TLS SNI, and
 * redirects REFUSED rather than followed — because a re-validated hop proves
 * only that the next host is public, never that anybody configured it.
 *
 * Reusing it means an MCP connection inherits all of that, and any future
 * hardening lands in both places at once.
 *
 * ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────
 *
 * It does not decide authority. No grant check, no scope check, no audit row,
 * no catalogue pin. Those belong to the layers above and are tracked on the
 * issue: an external tool becomes reachable only by being PINNED into a
 * tenant's manifest and GRANTED to an agent, and a client that quietly
 * authorised its own calls would be the widening term this subsystem forbids.
 *
 * This is transport, and transport is all it is.
 */
import { safeFetch } from '@/app-layer/automation/webhook-safety';
import {
    LATEST_PROTOCOL_VERSION,
    type JsonRpcResponse,
    type McpToolDescriptor,
    type McpToolResult,
} from '@/lib/mcp/protocol';

/**
 * How long one call may take, and how much it may return.
 *
 * BOTH are needed and they fail differently. A timeout bounds a server that
 * never answers; the byte cap bounds one that answers for ever. Without the
 * second, a hostile or broken endpoint streams until the process dies, and
 * the failure surfaces as an OOM in a worker rather than as a bad connection.
 *
 * The cap is applied to the BODY WE READ, not to a `Content-Length` header:
 * a header is a claim by the other side and costs nothing to lie about.
 */
export const MCP_CALL_TIMEOUT_MS = 30_000;
export const MCP_MAX_RESPONSE_BYTES = 1_000_000;

export class McpClientError extends Error {
    constructor(
        message: string,
        readonly code?: number,
    ) {
        super(message);
        this.name = 'McpClientError';
    }
}

export interface McpClientOptions {
    /** Tenant-supplied endpoint. Validated by `safeFetch`, never here. */
    url: string;
    /** Sent as `Authorization`. The caller resolves it from the connection's secrets. */
    authorization?: string;
    timeoutMs?: number;
    maxResponseBytes?: number;
}

/** The identity this deployment presents to an external server. */
const CLIENT_INFO = { name: 'inflect-compliance', version: '1.0.0' } as const;

let nextId = 0;

/**
 * One JSON-RPC round trip.
 *
 * Notifications are not supported and that is deliberate: every call this
 * client makes is on behalf of an agent step that has to be recorded, and a
 * fire-and-forget message is a call with no result to record.
 */
async function rpc(
    opts: McpClientOptions,
    method: string,
    params?: Record<string, unknown>,
): Promise<unknown> {
    const timeoutMs = opts.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
    const maxBytes = opts.maxResponseBytes ?? MCP_MAX_RESPONSE_BYTES;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
        res = await safeFetch(opts.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Both, because the 2025-06-18 transport may answer either.
                Accept: 'application/json, text/event-stream',
                'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION,
                ...(opts.authorization ? { Authorization: opts.authorization } : {}),
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: `ic-${++nextId}`,
                method,
                ...(params ? { params } : {}),
            }),
            signal: controller.signal,
        } as RequestInit);
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        throw new McpClientError(`MCP server answered HTTP ${res.status} to ${method}`);
    }

    const text = await readBounded(res, maxBytes);

    let parsed: JsonRpcResponse;
    try {
        parsed = JSON.parse(text) as JsonRpcResponse;
    } catch {
        // The body is NOT included in the message. It is attacker-influenced
        // text of unknown shape, and an error string is one of the few places
        // in this codebase that reliably reaches a log.
        throw new McpClientError(`MCP server returned a non-JSON body for ${method}`);
    }

    if ('error' in parsed && parsed.error) {
        throw new McpClientError(
            `MCP server refused ${method}: ${parsed.error.message}`,
            parsed.error.code,
        );
    }
    return (parsed as { result?: unknown }).result;
}

/**
 * Read at most `maxBytes`, then stop.
 *
 * Streamed rather than `await res.text()`: text() buffers the whole body
 * before anything can look at its size, so a cap applied afterwards has
 * already paid the memory it was there to refuse.
 */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return '';

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new McpClientError(
                `MCP response exceeded ${maxBytes} bytes — refusing to buffer it`,
            );
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** Handshake. Returns the protocol version the server settled on. */
export async function initialize(opts: McpClientOptions): Promise<{ protocolVersion: string }> {
    const result = (await rpc(opts, 'initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
    })) as { protocolVersion?: unknown } | undefined;

    const version = typeof result?.protocolVersion === 'string' ? result.protocolVersion : null;
    if (!version) {
        throw new McpClientError('MCP server did not name a protocol version at initialize');
    }
    return { protocolVersion: version };
}

/**
 * THEIR catalogue, which is not an allowlist.
 *
 * What comes back is whatever the remote server chooses to advertise, and it
 * can change between calls. Nothing here may be called on the strength of
 * appearing in this list: it is the input to a PIN that a human approves, and
 * the pin is what makes a tool reachable.
 */
export async function listTools(opts: McpClientOptions): Promise<McpToolDescriptor[]> {
    const result = (await rpc(opts, 'tools/list')) as { tools?: unknown } | undefined;
    return Array.isArray(result?.tools) ? (result.tools as McpToolDescriptor[]) : [];
}

/** Call one tool. Authority is the caller's problem — see the header. */
export async function callTool(
    opts: McpClientOptions,
    name: string,
    args: Record<string, unknown>,
): Promise<McpToolResult> {
    const result = (await rpc(opts, 'tools/call', { name, arguments: args })) as McpToolResult;
    return result;
}
