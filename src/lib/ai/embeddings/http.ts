/**
 * The ONE network call of the embedding seam: a JSON request to an address
 * INSIDE the deployment's perimeter, deadline-bounded and byte-capped (G6's
 * read bounds; the MCP client is the pattern).
 *
 * Every provider in this directory reaches the network through
 * {@link requestJsonBounded} and nothing else —
 * `tests/guards/ssrf-egress-coverage.test.ts` holds that no other file here
 * contains a fetch call of any kind, and that this one dials only through
 * {@link perimeterFetch}.
 *
 * Four rules, each one careless edit from being undone:
 *
 *   • The address test is the PERIMETER's, not `safeFetch`'s. `inflect-local`
 *     is a residency claim, and `safeFetch` admits only public addresses — the
 *     one kind that makes the claim false (`perimeter.ts` says why). Every
 *     address the host resolves to must be inside, and the connection is
 *     PINNED to them, so DNS cannot move between the check and the connect.
 *     Redirects are refused, never followed: a hop would leave the pin.
 *   • There is no injectable `fetchImpl`. A test seam on a production module
 *     is a path around the address check that looks like dependency
 *     injection; tests mock `undici` and `node:dns` instead.
 *   • The deadline covers the WHOLE call — DNS resolution (which no signal can
 *     abort), the response head, and the body read — by racing every await
 *     against one abort promise.
 *   • The body is read through a byte-capped stream that CANCELS at the cap.
 *     `res.json()` would have allocated the whole body before a length check
 *     could run, which makes a cap a report rather than a defence.
 *     `Content-Length` is a free early refusal, never the check.
 *
 * Never throws: every failure is a named reason.
 *
 * @module lib/ai/embeddings/http
 */
// `fetch` and `Agent` come from the SAME package, as in `safeFetch`: a
// dispatcher from npm undici handed to Node's bundled fetch breaks whenever
// the two versions' handler interfaces disagree.
import { Agent, fetch as undiciFetch } from 'undici';

import { resolvePerimeterAddresses } from './perimeter';

export type BoundedPostFailure =
    | 'ENDPOINT_OUTSIDE_PERIMETER'
    | 'REDIRECT_REFUSED'
    | 'TIMEOUT'
    | 'ABORTED'
    | 'HTTP_STATUS'
    | 'RESPONSE_TOO_LARGE'
    | 'MALFORMED_RESPONSE'
    | 'NETWORK_ERROR';

export type BoundedPostResult =
    | { readonly ok: true; readonly json: unknown }
    | { readonly ok: false; readonly reason: BoundedPostFailure; readonly status?: number };

export interface BoundedPostOptions {
    readonly deadlineMs: number;
    readonly maxResponseBytes: number;
    readonly signal?: AbortSignal;
}

class Stopped extends Error {
    constructor(readonly reason: 'TIMEOUT' | 'ABORTED') {
        super(reason);
    }
}

/** Why {@link perimeterFetch} sent nothing. */
class PerimeterRefused extends Error {
    constructor(readonly reason: 'ENDPOINT_OUTSIDE_PERIMETER' | 'NETWORK_ERROR') {
        super(reason);
    }
}

class RedirectRefused extends Error {
    constructor(readonly status: number) {
        super(`redirect ${status}`);
    }
}

/**
 * The dial: resolve, require every address inside the perimeter, pin the
 * connection to those addresses, refuse a redirect. The hostname is kept for
 * TLS SNI and certificate checks when the scheme is https.
 */
async function perimeterFetch(url: string, init: RequestInit): Promise<Response> {
    const resolved = await resolvePerimeterAddresses(url);
    if (!resolved.ok) {
        throw new PerimeterRefused(resolved.reason === 'UNRESOLVABLE' ? 'NETWORK_ERROR' : 'ENDPOINT_OUTSIDE_PERIMETER');
    }
    const pinned = resolved.addresses.map((a) => ({ address: a.address, family: a.family }));
    const dispatcher = new Agent({
        // Short-lived: this Agent serves only this one pinned request.
        keepAliveTimeout: 1,
        keepAliveMaxTimeout: 1,
        connect: {
            lookup: (
                _hostname: string,
                _options: unknown,
                cb: (err: NodeJS.ErrnoException | null, addrs: { address: string; family: number }[]) => void,
            ) => {
                cb(null, pinned);
            },
        },
    } as unknown as ConstructorParameters<typeof Agent>[0]);
    const res = (await undiciFetch(url, {
        ...init,
        // Applied after the spread so no caller can opt back into following.
        redirect: 'manual',
        dispatcher,
    } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        throw new RedirectRefused(res.status);
    }
    return res;
}

/** Resolves to the body text, or `null` when it passed `cap` (reading stops there). */
async function readCapped(res: Response, cap: number): Promise<string | null> {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > cap) {
        await res.body?.cancel().catch(() => undefined);
        return null;
    }
    const stream = res.body;
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
            await reader.cancel().catch(() => undefined);
            return null;
        }
        out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
}

export interface BoundedRequest {
    readonly method: 'GET' | 'POST';
    /** A JSON body, for POST only. */
    readonly body?: string;
}

export async function requestJsonBounded(
    url: string,
    request: BoundedRequest,
    opts: BoundedPostOptions,
): Promise<BoundedPostResult> {
    const deadline = AbortSignal.timeout(opts.deadlineMs);
    const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
    const why = (): 'TIMEOUT' | 'ABORTED' => (opts.signal?.aborted && !deadline.aborted ? 'ABORTED' : 'TIMEOUT');

    if (signal.aborted) return { ok: false, reason: why() };
    let rejectStopped: (err: Stopped) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
        rejectStopped = reject;
    });
    const onAbort = () => rejectStopped(new Stopped(why()));
    signal.addEventListener('abort', onAbort, { once: true });
    // `stopped` may reject after the call has finished; that rejection is
    // handled here so it never surfaces as an unhandled one.
    stopped.catch(() => undefined);

    const headers: Record<string, string> = { accept: 'application/json' };
    if (request.body !== undefined) headers['content-type'] = 'application/json';

    try {
        const res = await Promise.race([
            perimeterFetch(url, { method: request.method, headers, body: request.body, signal }),
            stopped,
        ]);
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            return { ok: false, reason: 'HTTP_STATUS', status: res.status };
        }
        const text = await Promise.race([readCapped(res, opts.maxResponseBytes), stopped]);
        if (text === null) return { ok: false, reason: 'RESPONSE_TOO_LARGE' };
        try {
            return { ok: true, json: JSON.parse(text) as unknown };
        } catch {
            return { ok: false, reason: 'MALFORMED_RESPONSE' };
        }
    } catch (err) {
        if (err instanceof Stopped) return { ok: false, reason: err.reason };
        if (err instanceof PerimeterRefused) return { ok: false, reason: err.reason };
        if (err instanceof RedirectRefused) return { ok: false, reason: 'REDIRECT_REFUSED', status: err.status };
        if (signal.aborted) return { ok: false, reason: why() };
        return { ok: false, reason: 'NETWORK_ERROR' };
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}

/** A JSON POST: {@link requestJsonBounded} with a body. */
export function postJsonBounded(url: string, body: string, opts: BoundedPostOptions): Promise<BoundedPostResult> {
    return requestJsonBounded(url, { method: 'POST', body }, opts);
}

/** A JSON GET: {@link requestJsonBounded} with no body. */
export function getJsonBounded(url: string, opts: BoundedPostOptions): Promise<BoundedPostResult> {
    return requestJsonBounded(url, { method: 'GET' }, opts);
}
