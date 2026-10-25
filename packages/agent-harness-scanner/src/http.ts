/**
 * THE SCANNER'S ONLY WAY OUT — a GET-only reader, the OAuth token exchange, and
 * an MCP listing.
 *
 * Read-only is a property of this module's SHAPE, not of the sources' good
 * behaviour. `ReadOnlyHttp` has one verb, `getJson`, and no method parameter,
 * so a source holding it has no way to spell a write. The OAuth token
 * exchange is a POST by protocol; it lives behind its own interface
 * (`TokenExchange`), and it changes nothing in the estate — it asks the
 * source's identity provider for a token to READ with. It has two grants and
 * no grant parameter: the client-credentials grant, and the JWT-bearer grant
 * (RFC 7523) Google's service accounts use (#3785).
 *
 * MCP is JSON-RPC over POST, so an MCP server is the one place a source sends a
 * body. `McpListingWire` has two functions and no method parameter: `open`
 * sends `initialize` and then the one-way `notifications/initialized` the
 * protocol requires, and `listTools` sends `tools/list`. There is no way to
 * spell `tools/call` with it (DPIA conditions 1 and 2, owner decisions 5 and 6
 * on #3686, 2026-10-19).
 *
 * `RegisterReadWire` is the one place a `tools/call` is sent, and it names its
 * tool itself: `read` calls `get_harness_register` with no arguments on the
 * Inflect endpoint the caller hands it, and can call nothing else (DPIA
 * condition 2 as amended by owner decision 7: one named tool, the scanner's own
 * tenant).
 *
 * Every request is held to four rules, each of which ends the source's read
 * with the contract's reason rather than an exception the runner has to guess
 * about:
 *
 *   • ORIGIN. The URL must be https and on the origin the caller names. A
 *     server-supplied next link that points anywhere else is not followed —
 *     the request carries the estate's credential — and the read is
 *     PAGINATION_TORN. Redirects are refused for the same reason.
 *   • TIME BOX. One deadline per source, shared by every request it makes:
 *     past it, TIME_BOX.
 *   • BYTE CAP. Per response and per source. A body is read through a stream
 *     that is CANCELLED at the cap, never read whole and measured afterwards.
 *     `Content-Length` is a free early refusal, not the check.
 *   • STATUS. 401/403 is AUTH_FAILED, 429 RATE_LIMITED, anything else that is
 *     not 2xx UNREACHABLE, and a body that is not JSON PAGINATION_TORN. The
 *     one exception is asked for by name: a 404 on a request marked
 *     `absentOk` is an absence, never an empty listing.
 *
 * Nothing here logs. A URL can carry a cursor and a header carries the
 * credential; neither belongs in a log line, so the callers log kinds and
 * counts and nothing else.
 */
import { SourceReadError, type IncompleteReason } from './source';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** What the reader and the token exchange share for one source: the wire, the clock, the deadline. */
export interface Transport {
    readonly fetchImpl: FetchLike;
    /** Epoch ms after which no further request is started. */
    readonly deadline: number;
    readonly now: () => number;
}

export interface ReadOnlyHttp {
    /**
     * GET a JSON document from `url`, which must be on `origin`. With
     * `absentOk`, a 404 resolves `{ absent: true }` instead of ending the read:
     * for a source that has already proved it can read the estate, and asks
     * for something the estate may simply not have (a directory with no files).
     */
    getJson(
        url: string,
        opts: { readonly origin: string; readonly headers: Readonly<Record<string, string>>; readonly absentOk?: boolean },
    ): Promise<{ readonly body: unknown; readonly headers: Headers; readonly absent?: true }>;
}

/** One MCP server, as a source reaches it: the endpoint URL, and the headers each request carries. */
export interface McpTarget {
    /** The server's Streamable HTTP endpoint, https. */
    readonly url: string;
    /** The read token's header, when the server takes one. Nothing else. */
    readonly headers: Readonly<Record<string, string>>;
}

/** An open MCP session: what `initialize` returned, and what every later request must carry. */
export interface McpSession {
    readonly target: McpTarget;
    readonly sessionId: string | null;
    readonly protocolVersion: string;
    /** Whether the server declared the `tools` capability. One that did not lists none. */
    readonly offersTools: boolean;
}

export interface McpListingWire {
    /** `initialize`, then `notifications/initialized`. Throws `SourceReadError`. */
    open(target: McpTarget): Promise<McpSession>;
    /** One page of `tools/list`. Throws `SourceReadError`. */
    listTools(session: McpSession, cursor: string | null): Promise<{ readonly tools: readonly unknown[]; readonly nextCursor: string | null }>;
}

/** The register read, over the scanner's own tenant's Inflect MCP endpoint. */
export interface RegisterReadWire {
    /** `initialize`, the notification, then `tools/call` of `HARNESS_REGISTER_TOOL`; the tool's JSON payload. */
    read(target: McpTarget): Promise<unknown>;
}

/** The one tool the scanner may call, on its own tenant's `/api/mcp`, and no other. */
export const HARNESS_REGISTER_TOOL = 'get_harness_register';

/** The protocol revision the scanner speaks. A server may answer with another it supports. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
/** The three messages the scanner may send an MCP server, and no other. `scanner-surface.ts` declares them. */
export const MCP_MESSAGES = ['initialize', 'notifications/initialized', 'tools/list'] as const;

/**
 * The OpenShell gateway, as the reader reaches it: the gRPC endpoint and the
 * bearer token every call carries.
 */
export interface OpenShellTarget {
    /** The gateway's gRPC endpoint, https. */
    readonly url: string;
    /** The bearer header, and nothing else. */
    readonly headers: Readonly<Record<string, string>>;
}

/**
 * THE OPENSHELL GATEWAY READ — a wire of its own, not a widened `ReadOnlyHttp`.
 *
 * The gateway speaks gRPC and nothing else: `proto/openshell.proto` at the
 * pinned release declares 84 RPCs on `openshell.v1.OpenShell` and carries ZERO
 * `google.api.http` annotations, so there is no REST transcoding for `getJson`
 * to reach. Widening `ReadOnlyHttp` with a second verb was considered and
 * refused (owner ruling 2026-10-24): its one-method shape is what makes a
 * source unable to write BY CONSTRUCTION, and a second method would turn that
 * into a property maintained by review. `McpListingWire` and `RegisterReadWire`
 * are the precedent — a narrow wire per protocol, each with its own declared
 * surface.
 *
 * READ-ONLY IS HELD THREE INDEPENDENT WAYS, which is why it is worth stating:
 *
 *   1. THIS INTERFACE. Three methods. There is no create, exec, delete or
 *      set-policy to call, and no method parameter to smuggle one through.
 *   2. THE DECLARED SURFACE. `scanner-surface.ts` names these three and they
 *      are hashed into `scannerManifestHash()`, so a fourth cannot ship without
 *      changing the hash every tenant sees on every scan.
 *   3. THE TOKEN'S SCOPE. All three RPCs declare `scope: "sandbox:read"` with
 *      `workspace_role: "user"` in the proto. Every mutation the reader must
 *      never make — `CreateSandbox`, `DeleteSandbox`, `ExecSandbox`,
 *      `AttachSandboxProvider` — declares `sandbox:write`. So a correctly
 *      scoped credential is refused by the GATEWAY before the method runs,
 *      independently of anything in this repository.
 *
 * The third is the only one that still holds if this file is wrong, which is
 * the reason the reader asks for `sandbox:read` and refuses to widen it.
 */
export interface OpenShellReadWire {
    /** One page of `ListSandboxes`. Throws `SourceReadError`. */
    listSandboxes(
        target: OpenShellTarget,
        cursor: string | null,
    ): Promise<{ readonly sandboxes: readonly unknown[]; readonly nextCursor: string | null }>;
    /** `GetSandbox` — one sandbox, including `spec.policy`. Throws `SourceReadError`. */
    getSandbox(target: OpenShellTarget, sandboxId: string): Promise<unknown>;
    /**
     * `GetSandboxPolicyStatus` — the revision the runtime has LOADED, which is
     * what separates a policy in force from one merely stored. Same
     * `sandbox:read` scope as the rest.
     */
    getSandboxPolicyStatus(target: OpenShellTarget, sandboxId: string): Promise<unknown>;
    /**
     * `ListSandboxProviders` — the providers attached to one sandbox.
     *
     * SECRET-BEARING IN SHAPE, which is why reading it is opt-in. The
     * `Provider` message it returns carries
     * `map<string, string> credentials = 3 [(openshell.options.v1.secret) = true]`.
     * Whether the gateway populates that under a `sandbox:read` token is NOT
     * established here, so the reader is built for the worse case: the call is
     * gated off by default and the member is never read.
     */
    listSandboxProviders(target: OpenShellTarget, sandboxId: string): Promise<{ readonly providers: readonly unknown[] }>;
    /**
     * `GetProviderProfile` — the profile a provider was created from, which
     * declares the endpoints a credential is scoped to.
     *
     * A DEFINITION, not an instance: `ProviderProfileCredential` carries
     * `name`, `env_vars` and `auth_style` and NO value, unlike the `Provider`
     * instance above. So this call is not secret-bearing — but it needs
     * `provider:read`, a SECOND scope on the client's credential, which is why
     * it is reached only through the same opt-in.
     */
    getProviderProfile(target: OpenShellTarget, profileId: string): Promise<unknown>;
}

/** The fully-qualified gRPC service the reader calls, and no other. */
export const OPENSHELL_SERVICE = 'openshell.v1.OpenShell';

/**
 * The three methods the reader may call on it, and no other. The siblings it
 * must not call sit on the SAME service — `ExecSandbox` and `DeleteSandbox`
 * among them — which is why this list is declared rather than assumed.
 */
export const OPENSHELL_METHODS = [
    'ListSandboxes',
    'GetSandbox',
    'GetSandboxPolicyStatus',
    'ListSandboxProviders',
    'GetProviderProfile',
] as const;

/**
 * The one OAuth scope the reader asks for. Named here so the request and the
 * declaration cannot drift: every method above requires exactly this, and every
 * mutation requires `sandbox:write`, which this token does not carry.
 */
export const OPENSHELL_READ_SCOPE = 'sandbox:read';

/**
 * The second scope, asked for ONLY when an estate opts in to reading providers.
 * `GetProviderProfile` requires it; nothing else the reader calls does. Kept
 * separate from `OPENSHELL_READ_SCOPE` so a default scan asks for one scope and
 * the widening is visible in configuration rather than implied.
 */
export const OPENSHELL_PROFILE_SCOPE = 'provider:read';

export interface TokenExchange {
    /**
     * The OAuth 2.0 client-credentials grant against `tokenUrl`, which must be on
     * `origin`. Returns the access token, or throws `SourceReadError`. The token
     * is held by the caller in memory for the length of one source read.
     */
    clientCredentials(req: {
        readonly tokenUrl: string;
        readonly origin: string;
        readonly clientId: string;
        readonly clientSecret: string;
        readonly scope: string;
    }): Promise<string>;
    /**
     * The OAuth 2.0 JWT-bearer grant (RFC 7523) against `tokenUrl`, which must
     * be on `origin`: `assertion` is a JWT the caller signed. Returns the access
     * token, or throws `SourceReadError`, as `clientCredentials` does.
     */
    jwtBearer(req: { readonly tokenUrl: string; readonly origin: string; readonly assertion: string }): Promise<string>;
}

/** RFC 7523's grant type, the one value `jwtBearer` sends. */
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** One response body, in bytes. A listing page is far smaller. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Every response one source reads, together. */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/** Whether `url` parses, is https, carries no userinfo, and is on `origin`. */
export function isOnOrigin(url: string, origin: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.origin === origin;
}

/** An https origin with no path, query or userinfo, or null. What a source's configured URL must reduce to. */
export function httpsOrigin(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
    if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search !== '' || parsed.hash !== '') return null;
    return parsed.origin;
}

function classifyThrow(err: unknown): SourceReadError {
    if (err instanceof SourceReadError) return err;
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return new SourceReadError('TIME_BOX', 'the read ran past its time box');
    return new SourceReadError('UNREACHABLE', 'the request did not complete');
}

function reasonForStatus(status: number): IncompleteReason {
    if (status === 401 || status === 403) return 'AUTH_FAILED';
    if (status === 429) return 'RATE_LIMITED';
    return 'UNREACHABLE';
}

/** Read a body through a stream that is cancelled at `cap`; `onBytes` charges the per-source budget. */
async function readCapped(res: Response, cap: number, onBytes: (n: number) => void): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > cap) {
        await res.body?.cancel();
        throw new SourceReadError('BYTE_CAP', 'the response declared more bytes than the cap');
    }
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        try {
            onBytes(value.byteLength);
            if (total > cap) throw new SourceReadError('BYTE_CAP', 'the response exceeded the byte cap');
        } catch (err) {
            await reader.cancel();
            throw err;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw new SourceReadError('PAGINATION_TORN', 'a page was not JSON');
    }
}

/** The per-source byte budget, shared by the reader and the token exchange. */
function budget(limit: number): (n: number) => void {
    let spent = 0;
    return (n) => {
        spent += n;
        if (spent > limit) throw new SourceReadError('BYTE_CAP', 'the source exceeded its byte budget');
    };
}

function remaining(t: Transport): number {
    const ms = t.deadline - t.now();
    if (ms <= 0) throw new SourceReadError('TIME_BOX', 'the source used its time box');
    return ms;
}

/**
 * One JSON-RPC response from an MCP server's answer: a JSON body, or a
 * Server-Sent Events stream read until the response with `id` arrives — and
 * then cancelled, because a stream need not end. Both are read under the byte
 * cap. Anything else is PAGINATION_TORN: an answer that is not the protocol's.
 */
async function readRpcResponse(res: Response, id: number, cap: number, onBytes: (n: number) => void): Promise<Record<string, unknown>> {
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const isResponse = (v: unknown): v is Record<string, unknown> =>
        v !== null && typeof v === 'object' && (v as { id?: unknown }).id === id && ('result' in v || 'error' in v);
    if (type === 'application/json') {
        const body = parseJson(await readCapped(res, cap, onBytes));
        if (!isResponse(body)) throw new SourceReadError('PAGINATION_TORN', 'the server answered with no response to the request');
        return body;
    }
    if (type !== 'text/event-stream' || !res.body) {
        await res.body?.cancel();
        throw new SourceReadError('PAGINATION_TORN', 'the server answered in a content type MCP does not use');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            onBytes(value.byteLength);
            if (total > cap) throw new SourceReadError('BYTE_CAP', 'the response exceeded the byte cap');
            buffered += decoder.decode(value, { stream: true });
            const events = buffered.split(/\r?\n\r?\n/);
            buffered = events.pop() ?? '';
            for (const event of events) {
                const data = event
                    .split(/\r?\n/)
                    .filter((l) => l.startsWith('data:'))
                    .map((l) => l.slice(5).replace(/^ /, ''))
                    .join('\n');
                if (data === '') continue;
                const parsed = parseJson(data);
                // A server may send its own notifications or requests first; they
                // are not the answer, and none of them is acted on.
                if (isResponse(parsed)) return parsed;
            }
        }
        throw new SourceReadError('PAGINATION_TORN', 'the stream ended with no response to the request');
    } finally {
        await reader.cancel().catch(() => undefined);
    }
}

/** A session id the server may hand back: visible ASCII, bounded. Anything else tears the session. */
const MCP_SESSION_ID = /^[\x21-\x7e]{1,256}$/;
const MCP_PROTOCOL = /^\d{4}-\d{2}-\d{2}$/;

export function createSourceWire(
    t: Transport,
    caps: { readonly response?: number; readonly source?: number } = {},
): {
    readonly http: ReadOnlyHttp;
    readonly tokens: TokenExchange;
    readonly mcp: McpListingWire;
    readonly register: RegisterReadWire;
    readonly openshell: OpenShellReadWire;
} {
    const responseCap = caps.response ?? MAX_RESPONSE_BYTES;
    const charge = budget(caps.source ?? MAX_SOURCE_BYTES);

    const http: ReadOnlyHttp = {
        async getJson(url, { origin, headers, absentOk }) {
            if (!isOnOrigin(url, origin)) {
                throw new SourceReadError('PAGINATION_TORN', 'refused a link off the configured origin');
            }
            try {
                const res = await t.fetchImpl(url, {
                    method: 'GET',
                    headers: { Accept: 'application/json', ...headers },
                    redirect: 'error',
                    signal: AbortSignal.timeout(remaining(t)),
                });
                if (res.status === 404 && absentOk === true) {
                    await res.body?.cancel();
                    return { body: null, headers: res.headers, absent: true };
                }
                if (!res.ok) {
                    await res.body?.cancel();
                    throw new SourceReadError(reasonForStatus(res.status), `the source answered HTTP ${res.status}`);
                }
                return { body: parseJson(await readCapped(res, responseCap, charge)), headers: res.headers };
            } catch (err) {
                throw classifyThrow(err);
            }
        },
    };

    /** POST one grant's form to a token endpoint on its origin; the access token, or the contract's reason. */
    async function exchange(tokenUrl: string, origin: string, form: URLSearchParams): Promise<string> {
        if (!isOnOrigin(tokenUrl, origin)) {
            throw new SourceReadError('AUTH_FAILED', 'the token endpoint is not on its configured origin');
        }
        try {
            const res = await t.fetchImpl(tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                body: form.toString(),
                redirect: 'error',
                signal: AbortSignal.timeout(remaining(t)),
            });
            if (!res.ok) {
                await res.body?.cancel();
                // Any refusal of the exchange is a credential the source could not use.
                const reason = res.status === 429 ? 'RATE_LIMITED' : res.status >= 500 ? 'UNREACHABLE' : 'AUTH_FAILED';
                throw new SourceReadError(reason, `the token endpoint answered HTTP ${res.status}`);
            }
            const body = parseJson(await readCapped(res, 64 * 1024, charge)) as { access_token?: unknown };
            if (typeof body.access_token !== 'string' || body.access_token === '') {
                throw new SourceReadError('AUTH_FAILED', 'the token endpoint returned no access token');
            }
            return body.access_token;
        } catch (err) {
            throw classifyThrow(err);
        }
    }

    const tokens: TokenExchange = {
        clientCredentials({ tokenUrl, origin, clientId, clientSecret, scope }) {
            return exchange(
                tokenUrl,
                origin,
                new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope }),
            );
        },
        jwtBearer({ tokenUrl, origin, assertion }) {
            return exchange(tokenUrl, origin, new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }));
        },
    };

    let rpcId = 0;
    /** POST one JSON-RPC message from `MCP_MESSAGES` to the target. The method is never a parameter of the wire. */
    async function post(
        target: McpTarget,
        method: (typeof MCP_MESSAGES)[number] | 'tools/call',
        params: Record<string, unknown> | undefined,
        session: { sessionId: string | null; protocolVersion: string | null },
    ): Promise<{ res: Response; id: number | null }> {
        let parsed: URL;
        try {
            parsed = new URL(target.url);
        } catch {
            throw new SourceReadError('UNREACHABLE', 'the MCP endpoint is not a URL');
        }
        if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
            throw new SourceReadError('UNREACHABLE', 'the MCP endpoint is not an https URL without credentials');
        }
        const notification = method.startsWith('notifications/');
        const id = notification ? null : ++rpcId;
        const headers: Record<string, string> = {
            ...target.headers,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
        };
        if (session.sessionId !== null) headers['Mcp-Session-Id'] = session.sessionId;
        if (session.protocolVersion !== null) headers['MCP-Protocol-Version'] = session.protocolVersion;
        const message = { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) };
        try {
            const res = await t.fetchImpl(target.url, {
                method: 'POST',
                headers,
                body: JSON.stringify(message),
                redirect: 'error',
                signal: AbortSignal.timeout(remaining(t)),
            });
            if (!res.ok) {
                await res.body?.cancel();
                throw new SourceReadError(reasonForStatus(res.status), `the MCP server answered HTTP ${res.status}`);
            }
            return { res, id };
        } catch (err) {
            throw classifyThrow(err);
        }
    }

    async function call(
        target: McpTarget,
        method: 'initialize' | 'tools/list' | 'tools/call',
        params: Record<string, unknown>,
        session: { sessionId: string | null; protocolVersion: string | null },
    ): Promise<{ result: Record<string, unknown>; headers: Headers }> {
        const { res, id } = await post(target, method, params, session);
        let answer: Record<string, unknown>;
        try {
            answer = await readRpcResponse(res, id as number, responseCap, charge);
        } catch (err) {
            throw classifyThrow(err);
        }
        if ('error' in answer) throw new SourceReadError('UNREACHABLE', `the MCP server refused ${method}`);
        const result = answer.result;
        if (result === null || typeof result !== 'object' || Array.isArray(result)) {
            throw new SourceReadError('PAGINATION_TORN', `the MCP server's ${method} result was not an object`);
        }
        return { result: result as Record<string, unknown>, headers: res.headers };
    }

    const mcp: McpListingWire = {
        async open(target) {
            const { result, headers } = await call(
                target,
                'initialize',
                {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    // The scanner offers the server nothing: no sampling, no roots, no elicitation.
                    capabilities: {},
                    clientInfo: { name: 'inflect-agent-harness-scanner', version: '1' },
                },
                { sessionId: null, protocolVersion: null },
            );
            const sessionHeader = headers.get('mcp-session-id');
            if (sessionHeader !== null && !MCP_SESSION_ID.test(sessionHeader)) {
                throw new SourceReadError('PAGINATION_TORN', 'the MCP server handed back a malformed session id');
            }
            const version = typeof result.protocolVersion === 'string' && MCP_PROTOCOL.test(result.protocolVersion)
                ? result.protocolVersion
                : null;
            if (version === null) throw new SourceReadError('PAGINATION_TORN', 'the MCP server named no protocol version');
            const capabilities = result.capabilities;
            const offersTools =
                capabilities !== null && typeof capabilities === 'object' && 'tools' in (capabilities as object);
            const session: McpSession = { target, sessionId: sessionHeader, protocolVersion: version, offersTools };
            // One-way: the server answers 202 and nothing else is read.
            const { res } = await post(target, 'notifications/initialized', undefined, session);
            await res.body?.cancel();
            return session;
        },
        async listTools(session, cursor) {
            const { result } = await call(session.target, 'tools/list', cursor === null ? {} : { cursor }, session);
            const tools = result.tools;
            const next = result.nextCursor;
            if (!Array.isArray(tools)) throw new SourceReadError('PAGINATION_TORN', 'a tools/list page had no tools array');
            if (next !== undefined && next !== null && (typeof next !== 'string' || next.length > 1024)) {
                throw new SourceReadError('PAGINATION_TORN', 'a tools/list page had a malformed cursor');
            }
            return { tools, nextCursor: typeof next === 'string' && next !== '' ? next : null };
        },
    };

    /*
        THE OPENSHELL WIRE IS DECLARED AND NOT YET CARRIED.

        The gateway speaks gRPC: HTTP/2 framing and protobuf encoding, which
        this `Transport` — fetch over JSON, shared by every other wire — does
        not do. Reaching it needs either a gRPC client dependency, which lands
        in the BLOCKING `npm audit --omit=dev --audit-level=moderate` gate and
        in this scanner's own supply chain, or generated protobuf codecs from
        NVIDIA's pinned protos. That is a dependency decision, and it is not
        this change.

        So the three methods answer UNREACHABLE with a reason that says which
        step is missing. That is the contract's own rule rather than a
        placeholder: "a source that could not be read is reported, never
        omitted", and UNREACHABLE is the reason that claims least. A scan
        configured for OpenShell therefore reports INCOMPLETE/UNREACHABLE and
        signs a truthful report, instead of throwing or — far worse — returning
        COMPLETE with no sandboxes, which would read as an estate that runs
        none.

        The source itself is complete and fully tested against a fake wire
        (`tests/unit/agent-harness-scanner/openshell-source.test.ts`): the
        policy-to-verdict mapping is pure and needs no transport. Only the
        bytes are missing.
    */
    const openshell: OpenShellReadWire = {
        async listSandboxes() {
            throw new SourceReadError('UNREACHABLE', 'the OpenShell gRPC transport is not built into this scanner');
        },
        async getSandbox() {
            throw new SourceReadError('UNREACHABLE', 'the OpenShell gRPC transport is not built into this scanner');
        },
        async getSandboxPolicyStatus() {
            throw new SourceReadError('UNREACHABLE', 'the OpenShell gRPC transport is not built into this scanner');
        },
        async listSandboxProviders() {
            throw new SourceReadError('UNREACHABLE', 'the OpenShell gRPC transport is not built into this scanner');
        },
        async getProviderProfile() {
            throw new SourceReadError('UNREACHABLE', 'the OpenShell gRPC transport is not built into this scanner');
        },
    };

    const register: RegisterReadWire = {
        async read(target) {
            const session = await mcp.open(target);
            const { result } = await call(target, 'tools/call', { name: HARNESS_REGISTER_TOOL, arguments: {} }, session);
            // Inflect's tool result: a JSON payload in the first text block. A
            // tool-level error is the server declining, never a register.
            if (result.isError === true) throw new SourceReadError('AUTH_FAILED', 'the register read was refused');
            const content = result.content;
            const first = Array.isArray(content) ? (content[0] as { type?: unknown; text?: unknown } | undefined) : undefined;
            if (first?.type !== 'text' || typeof first.text !== 'string') {
                throw new SourceReadError('PAGINATION_TORN', 'the register read returned no payload');
            }
            return parseJson(first.text);
        },
    };

    return { http, tokens, mcp, register, openshell };
}

/**
 * The next-page URL from an RFC 8288 `Link` header (`<url>; rel="next"`), or
 * null. Okta pages this way. The caller still holds the URL to its origin:
 * `getJson` refuses one that leaves it.
 */
export function nextLinkFrom(link: string | null): string | null {
    if (!link) return null;
    for (const part of link.split(',')) {
        const m = /<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i.exec(part);
        if (m) return m[1];
    }
    return null;
}
