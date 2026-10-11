/**
 * THE OUTBOUND MCP WIRE: one egress path, one capped reader, one timeout.
 *
 * Two clients speak JSON-RPC to a server somebody else runs — the tools client
 * (`app-layer/integrations/mcp/client.ts`) and the legacy-access client
 * (`lib/mcp/client/`). Their METHOD SETS stay separate, deliberately and
 * permanently: the legacy-access client is contractually forbidden from ever
 * sending `tools/*`, enforced structurally by a closed `CLIENT_METHODS` set, and
 * putting `resources/read` in a module that also exports `callTool` would turn
 * that guarantee into a convention enforced by nothing (#3303).
 *
 * ── WHAT IS SHARED AND WHAT IS NOT ──────────────────────────────────────────
 *
 * Shared, because it was written twice: reaching the network through
 * `safeFetch`, bounding the attempt with a deadline the caller owns, and
 * reading the body with a byte cap that ABORTS rather than truncates.
 *
 * NOT shared, because the two dialects genuinely disagree: the `accept` header
 * and the server-sent-events policy. The legacy-access client refuses SSE by
 * contract; the tools client must accept it, because the 2025-06-18 streamable
 * transport lets the SERVER choose, and Microsoft's Entra MCP server answers
 * every call in SSE. A shared helper that set `accept: application/json` and
 * refused `text/event-stream` — which is what #3303 originally proposed — would
 * break the tools client outright. So the caller supplies its own headers and
 * decides what to do with the content type it gets back.
 *
 * Status interpretation is also the caller's. The two clients map the same HTTP
 * codes onto different error types with different remedies, and a shared module
 * that threw one of them would be deciding for both.
 *
 * ── THE SINK LIVES HERE NOW ─────────────────────────────────────────────────
 *
 * `safeFetch` is called in exactly one place in the outbound MCP surface: the
 * branch below. `tests/guards/ssrf-egress-coverage.test.ts` registers THIS file
 * as the sink and separately asserts that neither client calls `fetch(` at all,
 * which is a stronger property than the per-file literal check it replaces —
 * that one was satisfied by any occurrence of `safeFetch(` anywhere in a file
 * that might also fetch elsewhere.
 *
 * ── TWO BEHAVIOURS THE TOOLS CLIENT DID NOT HAVE ────────────────────────────
 *
 * Unifying on the stronger of each pair, so the move is not behaviour-neutral
 * and should not be read as if it were:
 *
 *  - The timeout now covers THE BODY READ, not just the response head. The
 *    tools client cleared its timer immediately after `safeFetch` returned, so
 *    a server dribbling bytes slowly was bounded only by the byte cap and could
 *    hold the request open indefinitely. The legacy-access client already kept
 *    its controller live through the read; now both do.
 *  - A declared `content-length` above the cap is refused before a byte of body
 *    is read. Free when a server happens to tell the truth, and never the check
 *    — the streaming count below is.
 */
import { safeFetch } from '@/app-layer/automation/webhook-safety';

export type WireFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The attempt exceeded the budget. `phase` says whether head or body. */
export class WireTimeoutError extends Error {
    constructor(
        readonly phase: 'request' | 'body',
        readonly budgetMs: number,
    ) {
        super(`mcp wire: ${phase} exceeded ${budgetMs}ms`);
        this.name = 'WireTimeoutError';
    }
}

/** The body exceeded the cap. Nothing beyond `cap` plus one chunk was buffered. */
export class WireCapExceededError extends Error {
    constructor(readonly cap: number) {
        super(`mcp wire: response exceeded ${cap} bytes`);
        this.name = 'WireCapExceededError';
    }
}

/** The socket failed, or `safeFetch` refused the address. `cause` is preserved. */
export class WireEgressError extends Error {
    constructor(override readonly cause: unknown) {
        super('mcp wire: egress failed');
        this.name = 'WireEgressError';
    }
}

export interface WirePostOptions {
    readonly url: string;
    /** Caller-owned, INCLUDING `accept` — see the header. */
    readonly headers: Record<string, string>;
    readonly body: string;
    /** Per-attempt ceiling. */
    readonly timeoutMs: number;
    /**
     * Absolute epoch-ms ceiling for the whole operation, when the caller is
     * running several attempts under one budget. The effective timeout is the
     * lesser of this and `timeoutMs`.
     */
    readonly deadlineAt?: number;
    /** Test seam. The ONLY path that reaches the network unprotected. */
    readonly fetchImpl?: WireFetch;
}

export interface WireResponse {
    readonly status: number;
    /**
     * Mirrors `Response.ok`. Present because both callers branch on it, and a
     * shape that merely LOOKS like a Response while omitting it turns every
     * `if (!res.ok)` into an unconditional throw — which is exactly what the
     * first run of this conversion did to every 200.
     */
    readonly ok: boolean;
    readonly headers: Headers;
    /**
     * Read the body with a byte cap, aborting the transfer the moment it is
     * exceeded. Separate from the response on purpose: both callers inspect
     * status and content type BEFORE deciding to read, and one of them answers
     * some requests without reading a body at all.
     */
    readBody(cap: number): Promise<string>;
    /** Release the timer without reading. For a response with no body to read. */
    discard(): void;
}

export async function wirePost(opts: WirePostOptions): Promise<WireResponse> {
    const remaining =
        opts.deadlineAt === undefined ? opts.timeoutMs : opts.deadlineAt - Date.now();
    if (remaining <= 0) throw new WireTimeoutError('request', 0);
    const budget = Math.min(opts.timeoutMs, remaining);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);

    let res: Response;
    try {
        const init: RequestInit = {
            method: 'POST',
            headers: opts.headers,
            body: opts.body,
            signal: controller.signal,
        };
        // An explicit branch, NOT `opts.fetchImpl ?? safeFetch`. Two reasons, and
        // the SSRF sink registry found the first: resolving into an alias means
        // `safeFetch(` never literally appears here, so the registry's check —
        // "this sink calls safeFetch" — has nothing to match and passes on the
        // import alone. The second is for a reader: a branch shows that exactly
        // one path reaches the network unprotected and that it is the test seam,
        // where a defaulted alias reads as if both were the same thing.
        res = opts.fetchImpl
            ? await opts.fetchImpl(opts.url, init)
            : await safeFetch(opts.url, init);
    } catch (e) {
        clearTimeout(timer);
        if (controller.signal.aborted) throw new WireTimeoutError('request', budget);
        throw new WireEgressError(e);
    }

    let settled = false;
    const release = () => {
        if (!settled) {
            settled = true;
            clearTimeout(timer);
        }
    };

    return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        discard: release,
        async readBody(cap: number): Promise<string> {
            try {
                const declared = Number(res.headers.get('content-length') ?? '');
                if (Number.isFinite(declared) && declared > cap) {
                    controller.abort();
                    throw new WireCapExceededError(cap);
                }

                const stream = res.body;
                // No stream to cap. An absent body decodes to nothing, and
                // whether that is a contract violation is the caller's call.
                if (!stream) return '';

                const reader = stream.getReader();
                const decoder = new TextDecoder();
                let total = 0;
                let out = '';
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    total += value.byteLength;
                    if (total > cap) {
                        // Stop the transfer. Without this the server keeps
                        // sending and the socket keeps costing, even though we
                        // have already decided.
                        await reader.cancel().catch(() => undefined);
                        controller.abort();
                        throw new WireCapExceededError(cap);
                    }
                    out += decoder.decode(value, { stream: true });
                }
                out += decoder.decode();
                return out;
            } catch (e) {
                // The timer is still live here by design, so a slow body is
                // bounded too. Distinguish ITS abort from a cap refusal.
                if (e instanceof WireCapExceededError) throw e;
                if (controller.signal.aborted) throw new WireTimeoutError('body', budget);
                throw e instanceof WireEgressError ? e : new WireEgressError(e);
            } finally {
                release();
            }
        },
    };
}
