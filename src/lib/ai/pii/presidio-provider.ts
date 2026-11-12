/**
 * The Presidio analyzer, over HTTP (docs/ai-architecture/presidio.md, Phase 1.2).
 *
 * Constructed by `./mount.ts` and nowhere else (`tests/guards/pii-detector-single-seam.test.ts`):
 * the base URL is operator configuration (`AI_PII_BASE_URL`), never a tenant
 * value, and a provider is only built once a passing evaluation record exists
 * for the deployed configuration.
 *
 * ── AN IN-DEPLOYMENT SERVICE (G6 as amended 2026-11-12) ─────────────────────
 *
 * Presidio runs as a CPU service INSIDE the deployment — the roadmap rejects a
 * cloud PII API because it would be a sub-processor receiving every payload.
 * So it is held to the in-deployment rule, not to `safeFetch`, and reached only
 * through the shared dial `inDeploymentRequest('pii-detector', …)`
 * (`src/lib/ai/in-deployment-service.ts`):
 *
 *   - every address the host resolves to must be inside the deployment
 *     (RFC 1918, loopback, IPv6 ULA), and the connection is pinned to them;
 *   - http or https — a Compose-internal `http://presidio:3000` is the normal
 *     case, and the scheme was never the residency question;
 *   - one deadline over DNS, the request and the body; a byte cap that ABORTS
 *     the read; no redirect followed.
 *
 * It sat behind `safeFetch` until the amendment, which admits only PUBLIC
 * https addresses — every address but the right one for a container on the
 * Compose network, so a configured detector could never answer. There is no
 * fetch seam: tests mock `undici` and `node:dns`, so the address rule runs in
 * every test.
 *
 * ── THE ANSWER IS UNTRUSTED UNTIL CHECKED ───────────────────────────────────
 *
 * The response is schema-checked, every span is converted from Presidio's
 * code-point offsets to UTF-16 and refused if it does not fit the text, and a
 * type outside D-L1-1 is dropped (the request names the in-scope types; a
 * server returning others is ignoring the filter, and an extra span of a type
 * we did not ask about is not ours to act on). Any failure THROWS — the
 * provider never answers `[]` for "I could not tell".
 */
import { z } from 'zod';

import { checkPerimeterUrl, inDeploymentRequest, type InDeploymentFailure } from '@/lib/ai/in-deployment-service';

import { codePointSpanToUtf16 } from './redact';
import { isPiiEntityType, PII_ENTITY_TYPES, type PiiLocale } from './scope';
import { PiiDetectorError, type PiiAnalyzeOptions, type PiiDetector, type PiiDetectorFailure, type PiiSpan } from './types';

/** Resolution, request and body together, per analyse call. */
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
    /** Operator configuration (`AI_PII_BASE_URL`), read by `./mount.ts` alone. */
    readonly baseUrl: string;
    /** The score threshold the mounting record was measured at; the service is asked for exactly it. */
    readonly scoreThreshold: number;
    readonly timeoutMs?: number;
}

/**
 * The dial's failure → this provider's reason. Every one of them throws, and
 * the egress use turns any throw into a BLOCK for a tenant with redaction on.
 * A DNS failure is UNREACHABLE (a stopped container is NXDOMAIN), not a
 * refusal: the service is not there, which is a different repair.
 */
const DIAL_FAILURE: Record<InDeploymentFailure, PiiDetectorFailure> = {
    OUTSIDE_DEPLOYMENT: 'EGRESS_REFUSED',
    REDIRECT_REFUSED: 'EGRESS_REFUSED',
    UNRESOLVABLE: 'UNREACHABLE',
    NETWORK_ERROR: 'UNREACHABLE',
    TIMEOUT: 'TIMEOUT',
    ABORTED: 'TIMEOUT',
    HTTP_STATUS: 'HTTP_ERROR',
    RESPONSE_TOO_LARGE: 'TOO_LARGE',
};

export const PRESIDIO_DETECTOR_ID = 'presidio';

export function createPresidioDetector(opts: PresidioProviderOptions): PiiDetector {
    const id = PRESIDIO_DETECTOR_ID;
    const fail = (reason: PiiDetectorFailure) => new PiiDetectorError(reason, id);

    return {
        id,
        async analyze(text: string, locale: PiiLocale, callOpts: PiiAnalyzeOptions = {}): Promise<readonly PiiSpan[]> {
            let url: URL;
            try {
                url = new URL('analyze', opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`);
            } catch {
                throw fail('SCHEME_REFUSED');
            }
            if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('SCHEME_REFUSED');
            // The structural half of the rule, before anything is sent: a
            // literal public address is refused here, a hostname at the dial.
            if (!checkPerimeterUrl(url.href).ok) throw fail('EGRESS_REFUSED');
            if (Buffer.byteLength(text, 'utf8') > PII_MAX_TEXT_BYTES) throw fail('TEXT_TOO_LARGE');
            if (text.length === 0) return [];

            const res = await inDeploymentRequest(
                'pii-detector',
                url.href,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', accept: 'application/json' },
                    body: JSON.stringify({
                        text,
                        language: locale,
                        entities: [...PII_ENTITY_TYPES],
                        score_threshold: opts.scoreThreshold,
                    }),
                },
                {
                    deadlineMs: opts.timeoutMs ?? PII_ANALYZE_TIMEOUT_MS,
                    maxResponseBytes: PII_MAX_RESPONSE_BYTES,
                    signal: callOpts.signal,
                },
            );
            if (!res.ok) throw fail(DIAL_FAILURE[res.reason]);

            let json: unknown;
            try {
                json = JSON.parse(res.text);
            } catch {
                throw fail('MALFORMED_RESPONSE');
            }
            const parsed = PresidioResultSchema.safeParse(json);
            if (!parsed.success) throw fail('MALFORMED_RESPONSE');

            const spans: PiiSpan[] = [];
            for (const r of parsed.data) {
                if (!isPiiEntityType(r.entity_type)) continue;
                const units = codePointSpanToUtf16(text, r.start, r.end);
                if (units === null) throw fail('SPAN_OUT_OF_RANGE');
                spans.push({ type: r.entity_type, start: units[0], end: units[1], score: r.score });
            }
            return spans;
        },
    };
}
