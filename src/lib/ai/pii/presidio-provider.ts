/**
 * The Presidio analyzer, over HTTP (docs/ai-architecture/presidio.md, Phase 1.2).
 *
 * Constructed by `./mount.ts` and nowhere else (`tests/guards/pii-detector-single-seam.test.ts`):
 * the base URL is operator configuration (`AI_PII_BASE_URL`), never a tenant
 * value, and a provider is only built once a passing evaluation record exists
 * for the deployed configuration.
 *
 * The transport follows `src/lib/agentic/peer-agent-card-fetch.ts`, for the
 * same reasons (G6):
 *
 *   - https or nothing, decided here from the URL, above the test seam;
 *   - `safeFetch` in an EXPLICIT branch, never `fetchImpl ?? safeFetch`, so
 *     exactly one path reaches the network unprotected and it is the test seam;
 *   - one deadline over the request AND the body;
 *   - the request text is capped before it is sent, and the response body is
 *     read through a byte cap that ABORTS the transfer — never `res.json()`
 *     then a length check.
 *
 * ── THE ANSWER IS UNTRUSTED UNTIL CHECKED ───────────────────────────────────
 *
 * The response is schema-checked, every span is converted from Presidio's
 * code-point offsets to UTF-16 and refused if it does not fit the text, and a
 * type outside D-L1-1 is dropped (the request names the in-scope types; a
 * server returning others is ignoring the filter, and an extra span of a type
 * we did not ask about is not ours to act on). Any failure THROWS — the
 * provider never answers `[]` for "I could not tell".
 *
 * ── `safeFetch` AND AN IN-DEPLOYMENT SERVICE ────────────────────────────────
 *
 * `safeFetch` refuses http and private addresses. A Compose-internal
 * `http://presidio:…` is both, so on this transport an in-deployment service
 * is reachable only over https on an address the deployment-level egress
 * allowlist admits. Until Phase 1.1 decides that (it adds the container, after
 * the capacity budget's C1), a configured-but-unreachable detector BLOCKS
 * egress for a tenant with redaction on — the direction this must fail in.
 */
import { z } from 'zod';

import { safeFetch } from '@/app-layer/automation/webhook-safety';

import { entityTypeFromPresidio, PII_ENTITY_TYPES, PRESIDIO_ENTITY_NAME, type PiiLocale } from './entities';
import { codePointSpanToUtf16 } from './redact';
import { PiiDetectorError, type PiiAnalyzeOptions, type PiiDetector, type PiiSpan } from './types';

/** Request and body together, per analyse call. */
export const PII_ANALYZE_TIMEOUT_MS = 5_000;
/** The largest text sent in one call, in UTF-8 bytes. Larger text is refused, not truncated. */
export const PII_MAX_TEXT_BYTES = 256 * 1024;
/** The largest analyzer response read. */
export const PII_MAX_RESPONSE_BYTES = 1024 * 1024;

const PresidioResultSchema = z.array(
    z.object({
        entity_type: z.string(),
        start: z.number().int(),
        end: z.number().int(),
        score: z.number().min(0).max(1),
    }),
);

export interface PresidioProviderOptions {
    /** Operator configuration (`AI_PII_BASE_URL`). */
    readonly baseUrl: string;
    /** The score threshold the mounting record was measured at; the service is asked for exactly it. */
    readonly scoreThreshold: number;
    readonly timeoutMs?: number;
    /** Test seam. The ONLY path that reaches the network unprotected. */
    readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

class CapExceeded extends Error {}

export const PRESIDIO_DETECTOR_ID = 'presidio';

export function createPresidioDetector(opts: PresidioProviderOptions): PiiDetector {
    const id = PRESIDIO_DETECTOR_ID;
    const fail = (reason: ConstructorParameters<typeof PiiDetectorError>[0]) => new PiiDetectorError(reason, id);

    return {
        id,
        async analyze(text: string, locale: PiiLocale, callOpts: PiiAnalyzeOptions = {}): Promise<readonly PiiSpan[]> {
            let url: URL;
            try {
                url = new URL('analyze', opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`);
            } catch {
                throw fail('SCHEME_REFUSED');
            }
            if (url.protocol !== 'https:') throw fail('SCHEME_REFUSED');
            if (Buffer.byteLength(text, 'utf8') > PII_MAX_TEXT_BYTES) throw fail('TEXT_TOO_LARGE');
            if (text.length === 0) return [];

            const controller = new AbortController();
            const onCallerAbort = () => controller.abort();
            callOpts.signal?.addEventListener('abort', onCallerAbort, { once: true });
            if (callOpts.signal?.aborted) controller.abort();
            const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PII_ANALYZE_TIMEOUT_MS);
            try {
                const init: RequestInit = {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', accept: 'application/json' },
                    body: JSON.stringify({
                        text,
                        language: locale,
                        entities: PII_ENTITY_TYPES.map((t) => PRESIDIO_ENTITY_NAME[t]),
                        score_threshold: opts.scoreThreshold,
                    }),
                    signal: controller.signal,
                };
                let res: Response;
                try {
                    res = opts.fetchImpl ? await opts.fetchImpl(url.toString(), init) : await safeFetch(url.toString(), init);
                } catch {
                    throw fail(controller.signal.aborted ? 'TIMEOUT' : 'EGRESS_REFUSED');
                }
                if (!res.ok) {
                    await res.body?.cancel().catch(() => undefined);
                    throw fail('HTTP_ERROR');
                }
                let body: string;
                try {
                    body = await readCapped(res, controller);
                } catch (e) {
                    if (e instanceof CapExceeded) throw fail('TOO_LARGE');
                    throw fail(controller.signal.aborted ? 'TIMEOUT' : 'EGRESS_REFUSED');
                }
                let json: unknown;
                try {
                    json = JSON.parse(body);
                } catch {
                    throw fail('MALFORMED_RESPONSE');
                }
                const parsed = PresidioResultSchema.safeParse(json);
                if (!parsed.success) throw fail('MALFORMED_RESPONSE');

                const spans: PiiSpan[] = [];
                for (const r of parsed.data) {
                    const type = entityTypeFromPresidio(r.entity_type);
                    if (type === null) continue;
                    const units = codePointSpanToUtf16(text, r.start, r.end);
                    if (units === null) throw fail('SPAN_OUT_OF_RANGE');
                    spans.push({ type, start: units[0], end: units[1], score: r.score });
                }
                return spans;
            } finally {
                clearTimeout(timer);
                callOpts.signal?.removeEventListener('abort', onCallerAbort);
            }
        },
    };
}

async function readCapped(res: Response, controller: AbortController): Promise<string> {
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > PII_MAX_RESPONSE_BYTES) {
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
        if (total > PII_MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => undefined);
            controller.abort();
            throw new CapExceeded();
        }
        out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
}
