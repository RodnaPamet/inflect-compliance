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
import { findInternalSecret } from './egress-scan';
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
    // EGRESS. Ahead of the timer and the socket, because a refusal must not be
    // observable to the far end — not even as a connection it can time.
    //
    // Scanned here rather than in `callTool` so the check covers every method
    // this client will ever send, including ones added later. `initialize` and
    // `tools/list` pass our own constants and cannot trip it; the authorization
    // header is a tenant secret that travels BY DESIGN and is not part of
    // `params`, so it is correctly out of scope.
    const leaked = findInternalSecret(params);
    if (leaked) {
        throw new McpClientError(
            `mcp_egress_blocked: the arguments for ${method} contain ${leaked}, ` +
            'which must never be sent to an external server. The run was stopped ' +
            'before any bytes left. Nothing was sent.',
        );
    }

    const timeoutMs = opts.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
    const maxBytes = opts.maxResponseBytes ?? MCP_MAX_RESPONSE_BYTES;

    const requestId = `ic-${++nextId}`;

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
                id: requestId,
                method,
                ...(params ? { params } : {}),
            }),
            signal: controller.signal,
        } as RequestInit);
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        const challenge = describeAuthChallenge(res.headers.get('www-authenticate'));
        throw new McpClientError(
            `MCP server answered HTTP ${res.status} to ${method}${challenge ? ` (${challenge})` : ''}`,
        );
    }

    const text = await readBounded(res, maxBytes);

    // Streamable HTTP lets a server answer a POST with EITHER `application/json`
    // OR `text/event-stream`, and the choice is the SERVER'S. We send an
    // `Accept` naming both, so refusing to parse one of them was a promise this
    // client did not keep — Microsoft's Entra MCP server answers every call in
    // SSE, and the whole transport failed against it with "non-JSON body".
    const contentType = res.headers.get('content-type') ?? '';
    const payload = contentType.includes('text/event-stream')
        ? sseReplyTo(text, requestId)
        : text;

    if (payload === null) {
        // The stream parsed but carried no reply to THIS call. Distinguished
        // from a malformed body because the remedies differ: one is a protocol
        // mismatch, the other is a server that answered something else.
        throw new McpClientError(`MCP server sent no reply to ${method} in its event stream`);
    }

    let parsed: JsonRpcResponse;
    try {
        parsed = JSON.parse(payload) as JsonRpcResponse;
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
 * The JSON-RPC reply to ONE request, pulled out of an SSE body.
 *
 * Matched on the request id rather than taken as "the first message", because
 * an event stream legitimately carries more than the answer: a server may send
 * `notifications/message` log entries or progress events alongside it, and the
 * first `data:` line is not reliably the reply. Taking the first would work
 * against a quiet server and fail against a chatty one — the kind of bug that
 * shows up only in production, against whichever server talks most.
 *
 * Per the SSE grammar an event is terminated by a blank line and its `data:`
 * lines are joined with newlines. Anything unparseable is skipped rather than
 * fatal: one malformed event must not discard a well-formed reply beside it.
 *
 * Returns `null` when the stream held no reply to this id.
 */
function sseReplyTo(body: string, requestId: string): string | null {
    for (const frame of body.split(/\r?\n\r?\n/)) {
        const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data) continue;

        try {
            const message = JSON.parse(data) as { id?: unknown };
            if (message.id === requestId) return data;
        } catch {
            continue;
        }
    }
    return null;
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
/**
 * The SAFE part of a `WWW-Authenticate` challenge, for an error message.
 *
 * A bare "answered HTTP 401" names nothing an operator can act on. A resource
 * server uses this header to say WHICH credential problem it had — an expired
 * token, a missing scope, an audience it does not serve — and discarding it
 * turned one real 401 into three wrong theories before the cause was found.
 *
 * ── WHAT IS DELIBERATELY NOT INCLUDED ───────────────────────────────────────
 *
 * `error_description`, and for the reason `postToTokenEndpoint` already gives
 * for the identical field on a token response: a description is free text
 * chosen by the far end and can echo request parameters back, so surfacing it
 * puts whatever we sent into our own logs and UI. The `error` TOKEN is a closed
 * vocabulary (`invalid_token`, `insufficient_scope`, …) and carries the
 * diagnosis without the echo. `scope` is included because a scope the server
 * requires is the single most actionable thing it can tell us, and it describes
 * the SERVER's requirements rather than our request.
 *
 * `realm` is dropped as noise, not as a risk.
 *
 * Returns null for an absent or unparseable header — "the server said nothing"
 * and "the server said something I could not read" both mean there is nothing
 * to add, and a half-parsed challenge would be worse than none.
 */
export function describeAuthChallenge(header: string | null | undefined): string | null {
    if (!header) return null;
    const scheme = header.trim().split(/[\s,]/, 1)[0];
    const parts: string[] = [];
    if (scheme) parts.push(scheme);
    for (const name of ['error', 'scope'] as const) {
        // Bounded on purpose: a hostile server could otherwise put a megabyte
        // into a header and have us paste it into every log line.
        const m = new RegExp(`\\b${name}="([^"]{0,200})"`, 'i').exec(header);
        if (m) parts.push(`${name}=${m[1]}`);
    }
    return parts.length > 0 ? parts.join(' ') : null;
}

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
