/**
 * The embedding seam's JSON adapter over the ONE in-deployment dial
 * (`src/lib/ai/in-deployment-service.ts`, G6 as amended 2026-11-12).
 *
 * Every provider in this directory reaches the network through
 * {@link requestJsonBounded} and nothing else, and this file reaches it only
 * through `inDeploymentRequest` — `tests/guards/ssrf-egress-coverage.test.ts`
 * holds that no file here contains a fetch call of any kind.
 *
 * What the shared dial guarantees, and so this seam inherits rather than
 * re-implements: every address the host resolves to is INSIDE the deployment
 * (`inflect-local` is a residency claim, and `safeFetch` admits only the public
 * addresses that make it false); the connection is pinned to those addresses;
 * redirects are refused; one deadline covers DNS, the head and the body; the
 * body is read through a cap that cancels. There is no injectable fetch: tests
 * mock `undici` and `node:dns`.
 *
 * What this adapter adds: the JSON headers, the JSON parse, and the seam's own
 * failure vocabulary. A name that does not resolve is `NETWORK_ERROR` here, as
 * it was before the dial moved — the seam reports the service as unreachable,
 * not the address as outside.
 *
 * Never throws: every failure is a named reason.
 *
 * @module lib/ai/embeddings/http
 */
import { inDeploymentRequest, type InDeploymentFailure } from '@/lib/ai/in-deployment-service';

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
    /** Which of the two in-deployment services this seam reaches. */
    readonly service: 'embed' | 'rerank';
    readonly deadlineMs: number;
    readonly maxResponseBytes: number;
    readonly signal?: AbortSignal;
}

const FAILURE: Record<InDeploymentFailure, BoundedPostFailure> = {
    OUTSIDE_DEPLOYMENT: 'ENDPOINT_OUTSIDE_PERIMETER',
    UNRESOLVABLE: 'NETWORK_ERROR',
    REDIRECT_REFUSED: 'REDIRECT_REFUSED',
    TIMEOUT: 'TIMEOUT',
    ABORTED: 'ABORTED',
    HTTP_STATUS: 'HTTP_STATUS',
    RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
    NETWORK_ERROR: 'NETWORK_ERROR',
};

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
    const headers: Record<string, string> = { accept: 'application/json' };
    if (request.body !== undefined) headers['content-type'] = 'application/json';

    const res = await inDeploymentRequest(
        opts.service,
        url,
        { method: request.method, headers, body: request.body },
        { deadlineMs: opts.deadlineMs, maxResponseBytes: opts.maxResponseBytes, signal: opts.signal },
    );
    if (!res.ok) {
        const reason = FAILURE[res.reason];
        // A status is reported only where it names the service's answer.
        return reason === 'HTTP_STATUS' || reason === 'REDIRECT_REFUSED'
            ? { ok: false, reason, status: res.status }
            : { ok: false, reason };
    }
    try {
        return { ok: true, json: JSON.parse(res.text) as unknown };
    } catch {
        return { ok: false, reason: 'MALFORMED_RESPONSE' };
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
