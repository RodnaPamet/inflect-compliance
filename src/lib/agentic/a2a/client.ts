/**
 * THE A2A CLIENT — the third client over the one outbound wire (#3679;
 * `docs/a2a-threat-model.md` O4).
 *
 * Every byte Inflect sends to a peer leaves through `wirePost`
 * (`src/lib/mcp/wire-transport.ts`), which is the registered SSRF sink: https
 * only, decided from the URL above the test seam, `safeFetch` (DNS re-resolved
 * and pinned to public addresses, no redirects), a deadline that covers the
 * body, and a byte cap that aborts. This file contains no fetch call of any
 * kind, and `tests/guards/ssrf-egress-coverage.test.ts` holds it to that beside
 * the two MCP clients.
 *
 * Its method set is closed (`A2A_CLIENT_METHODS`): it can send `message/send`
 * and nothing else, so it cannot speak `tools/*`, and neither MCP client can
 * speak A2A.
 *
 * Before a socket opens, the body is scanned by `findInternalSecret`: a
 * ciphertext envelope, an Inflect API key or a peer credential addressed to
 * another organisation is refused here, whatever the task says.
 *
 * It signs nothing and verifies nothing. The caller hands it a body and the
 * receipt header for that exact body, and gets back the peer's exact body and
 * its receipt header for the caller to verify. Keeping the crypto out means
 * the bytes signed are the bytes sent: nothing here re-serialises.
 */
import {
    WireCapExceededError,
    WireSchemeRefusedError,
    WireTimeoutError,
    wirePost,
    type WireFetch,
} from '@/lib/mcp/wire-transport';
import { findInternalSecret } from '@/app-layer/integrations/mcp/egress-scan';

import { A2A_RECEIPT_HEADER } from './receipt';
import { A2A_CLIENT_METHODS, A2A_MAX_RESPONSE_BYTES } from './protocol';

/** One send, head and body together. */
export const A2A_SEND_TIMEOUT_MS = 30_000;

export interface A2aSendRequest {
    /** The peer's service endpoint, from its pinned card. */
    readonly url: string;
    /** The credential the peer issued Inflect, from the connection's secret. */
    readonly authorization?: string;
    /** The exact JSON-RPC body; the receipt's digest covers these bytes. */
    readonly body: string;
    readonly receiptHeader: string;
    readonly timeoutMs?: number;
    /** Test seam, passed straight to `wirePost`. No file under src/ passes one. */
    readonly fetchImpl?: WireFetch;
}

export type A2aSendFailure =
    /** Refused before anything left. The far end changed nothing. */
    | 'METHOD_REFUSED'
    | 'SECRET_IN_BODY'
    | 'SCHEME_REFUSED'
    /** The request was attempted; whether it arrived is not known. */
    | 'EGRESS_FAILED'
    | 'TIMEOUT'
    | 'TOO_LARGE'
    | 'HTTP_ERROR'
    | 'NOT_JSON';

export type A2aSendResult =
    | { readonly ok: true; readonly body: string; readonly receiptHeader: string | null }
    | {
          readonly ok: false;
          readonly reason: A2aSendFailure;
          /** False only when nothing can have reached the peer. */
          readonly mayHaveArrived: boolean;
      };

export async function sendA2aMessage(req: A2aSendRequest): Promise<A2aSendResult> {
    let parsed: { method?: unknown; params?: unknown };
    try {
        parsed = JSON.parse(req.body) as { method?: unknown; params?: unknown };
    } catch {
        return { ok: false, reason: 'METHOD_REFUSED', mayHaveArrived: false };
    }
    if (typeof parsed.method !== 'string' || !A2A_CLIENT_METHODS.has(parsed.method as 'message/send')) {
        return { ok: false, reason: 'METHOD_REFUSED', mayHaveArrived: false };
    }
    if (findInternalSecret(parsed.params)) {
        return { ok: false, reason: 'SECRET_IN_BODY', mayHaveArrived: false };
    }

    const headers: Record<string, string> = {
        'content-type': 'application/json',
        // JSON only. A2A's streaming method is outside the closed set, so an
        // event stream is never the answer to anything this client asks.
        accept: 'application/json',
        [A2A_RECEIPT_HEADER]: req.receiptHeader,
    };
    if (req.authorization) headers.authorization = req.authorization;

    let res;
    try {
        res = await wirePost({
            url: req.url,
            headers,
            body: req.body,
            timeoutMs: req.timeoutMs ?? A2A_SEND_TIMEOUT_MS,
            fetchImpl: req.fetchImpl,
        });
    } catch (e) {
        if (e instanceof WireSchemeRefusedError) return { ok: false, reason: 'SCHEME_REFUSED', mayHaveArrived: false };
        if (e instanceof WireTimeoutError) return { ok: false, reason: 'TIMEOUT', mayHaveArrived: true };
        return { ok: false, reason: 'EGRESS_FAILED', mayHaveArrived: true };
    }

    if (!res.ok) {
        res.discard();
        return { ok: false, reason: 'HTTP_ERROR', mayHaveArrived: true };
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!/^application\/json\b/i.test(contentType)) {
        res.discard();
        return { ok: false, reason: 'NOT_JSON', mayHaveArrived: true };
    }
    let body: string;
    try {
        body = await res.readBody(A2A_MAX_RESPONSE_BYTES);
    } catch (e) {
        if (e instanceof WireCapExceededError) return { ok: false, reason: 'TOO_LARGE', mayHaveArrived: true };
        if (e instanceof WireTimeoutError) return { ok: false, reason: 'TIMEOUT', mayHaveArrived: true };
        return { ok: false, reason: 'EGRESS_FAILED', mayHaveArrived: true };
    }
    return { ok: true, body, receiptHeader: res.headers.get(A2A_RECEIPT_HEADER) };
}
