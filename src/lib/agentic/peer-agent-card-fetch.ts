/**
 * Read an A2A peer's agent card off the wire (#3673, step 2e).
 *
 * The card URL is typed by an operator and names a host in another
 * organisation, which is textbook SSRF input. So this follows
 * `src/lib/mcp/wire-transport.ts` exactly, for the same reasons
 * (`docs/a2a-threat-model.md`, I0 I and D):
 *
 *   - https or nothing, decided here from the URL, above the test seam;
 *   - `safeFetch` in an EXPLICIT branch, never `fetchImpl ?? safeFetch`, so
 *     `tests/guards/ssrf-egress-coverage.test.ts` has a literal call to find
 *     and exactly one path reaches the network unprotected: the test seam;
 *   - one deadline over the request AND the body, so a slow card is bounded;
 *   - a byte cap that ABORTS the transfer, never `res.text()` then a length
 *     check, which has already allocated the whole body by the time it could
 *     measure it. `Content-Length` is a free early refusal, not the check.
 *
 * The result names a reason and never carries the body text on failure:
 * card text is never logged (pinning rule 8), and a caller that logged a
 * failure's detail would do exactly that.
 */
import { safeFetch } from '@/app-layer/automation/webhook-safety';

import {
    AGENT_CARD_MAX_BYTES,
    hashAgentCard,
    parseAgentCard,
    type AgentCard,
    type AgentCardHashes,
} from './peer-agent-card';

/** Request and body together. */
export const AGENT_CARD_FETCH_TIMEOUT_MS = 10_000;

export type AgentCardFetchFailure =
    | 'SCHEME_REFUSED'
    | 'EGRESS_REFUSED'
    | 'TIMEOUT'
    | 'HTTP_ERROR'
    | 'TOO_LARGE'
    | 'NOT_JSON'
    | 'NOT_AN_AGENT_CARD'
    | 'ENDPOINT_NOT_HTTPS';

export type AgentCardFetchResult =
    | { readonly ok: true; readonly card: AgentCard; readonly hashes: AgentCardHashes }
    | { readonly ok: false; readonly reason: AgentCardFetchFailure };

export interface AgentCardFetchOptions {
    readonly timeoutMs?: number;
    /** Test seam. The ONLY path that reaches the network unprotected. */
    readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

class CapExceeded extends Error {}

export async function fetchAgentCard(cardUrl: string, opts: AgentCardFetchOptions = {}): Promise<AgentCardFetchResult> {
    let protocol: string | null = null;
    try {
        protocol = new URL(cardUrl).protocol;
    } catch {
        protocol = null;
    }
    if (protocol !== 'https:') return { ok: false, reason: 'SCHEME_REFUSED' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? AGENT_CARD_FETCH_TIMEOUT_MS);
    try {
        const init: RequestInit = {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: controller.signal,
        };
        let res: Response;
        try {
            res = opts.fetchImpl ? await opts.fetchImpl(cardUrl, init) : await safeFetch(cardUrl, init);
        } catch {
            return { ok: false, reason: controller.signal.aborted ? 'TIMEOUT' : 'EGRESS_REFUSED' };
        }
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            return { ok: false, reason: 'HTTP_ERROR' };
        }

        let text: string;
        try {
            text = await readCapped(res, controller);
        } catch (e) {
            if (e instanceof CapExceeded) return { ok: false, reason: 'TOO_LARGE' };
            return { ok: false, reason: controller.signal.aborted ? 'TIMEOUT' : 'EGRESS_REFUSED' };
        }

        const parsed = parseAgentCard(text);
        if (!parsed.ok) return { ok: false, reason: parsed.reason };
        return { ok: true, card: parsed.card, hashes: hashAgentCard(parsed.card) };
    } finally {
        clearTimeout(timer);
    }
}

async function readCapped(res: Response, controller: AbortController): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > AGENT_CARD_MAX_BYTES) {
        controller.abort();
        throw new CapExceeded();
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
        if (total > AGENT_CARD_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            controller.abort();
            throw new CapExceeded();
        }
        out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
}
