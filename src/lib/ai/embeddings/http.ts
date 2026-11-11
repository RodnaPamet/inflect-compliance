/**
 * The ONE network call of the embedding seam: a JSON POST through `safeFetch`,
 * deadline-bounded and byte-capped (G6; the MCP client is the pattern).
 *
 * Every provider in this directory reaches the network through
 * {@link postJsonBounded} and nothing else —
 * `tests/guards/ssrf-egress-coverage.test.ts` holds that no other file here
 * contains a fetch call of any kind.
 *
 * Three rules, each one careless edit from being undone:
 *
 *   • `safeFetch` is called DIRECTLY, with no injectable `fetchImpl`. A test
 *     seam on a production module is a path around the SSRF defence that
 *     looks like dependency injection; tests mock the module instead.
 *   • The deadline covers the WHOLE call — DNS resolution inside `safeFetch`
 *     (which no signal can abort), the response head, and the body read — by
 *     racing every await against one abort promise.
 *   • The body is read through a byte-capped stream that CANCELS at the cap.
 *     `res.json()` would have allocated the whole body before a length check
 *     could run, which makes a cap a report rather than a defence.
 *     `Content-Length` is a free early refusal, never the check.
 *
 * Never throws: every failure is a named reason.
 *
 * @module lib/ai/embeddings/http
 */
import {
    RedirectNotAllowedError,
    SsrfBlockedError,
    safeFetch,
} from '@/app-layer/automation/webhook-safety';

export type BoundedPostFailure =
    | 'EGRESS_REFUSED'
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

export async function postJsonBounded(
    url: string,
    body: string,
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

    try {
        const res = await Promise.race([
            safeFetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body,
                signal,
            }),
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
        if (err instanceof SsrfBlockedError || err instanceof RedirectNotAllowedError) {
            return { ok: false, reason: 'EGRESS_REFUSED' };
        }
        if (signal.aborted) return { ok: false, reason: why() };
        return { ok: false, reason: 'NETWORK_ERROR' };
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}
