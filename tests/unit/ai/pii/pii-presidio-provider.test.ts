/**
 * The Presidio provider over its test seam. Invariants:
 *
 *   - it asks for exactly the D-L1-1 types, in the requested locale, at the
 *     record's threshold;
 *   - it converts code-point offsets and drops out-of-scope types;
 *   - EVERY failure throws a named reason — it never answers [] for "could not
 *     tell" — and no failure message carries the analysed text;
 *   - https only, decided above the test seam; text and response are capped.
 */
import { createPresidioDetector, PII_MAX_RESPONSE_BYTES, PII_MAX_TEXT_BYTES } from '@/lib/ai/pii/presidio-provider';
import { PiiDetectorError } from '@/lib/ai/pii/types';

const BASE = 'https://pii.internal.test';
const SECRET_TEXT = 'Zara Quillfeather, phone +359 88 000 1111';

type Seen = { url: string; body: Record<string, unknown> };

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

function detectorAnswering(respond: () => Response | Promise<Response>, seen: Seen[] = [], extra: { timeoutMs?: number } = {}) {
    return createPresidioDetector({
        baseUrl: BASE,
        scoreThreshold: 0.35,
        timeoutMs: extra.timeoutMs,
        fetchImpl: async (url, init) => {
            seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
            return respond();
        },
    });
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
    try {
        await p;
        return 'RESOLVED';
    } catch (e) {
        expect(e).toBeInstanceOf(PiiDetectorError);
        // No failure message may carry the analysed text.
        expect((e as Error).message).not.toContain('Zara');
        return (e as PiiDetectorError).reason;
    }
}

describe('the request', () => {
    it('names exactly the D-L1-1 types, the locale and the record threshold, at /analyze', async () => {
        const seen: Seen[] = [];
        const d = detectorAnswering(() => jsonResponse([]), seen);
        await d.analyze(SECRET_TEXT, 'bg');
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe(`${BASE}/analyze`);
        expect(seen[0].body).toEqual({
            text: SECRET_TEXT,
            language: 'bg',
            entities: ['PERSON', 'EMAIL_ADDRESS', 'PHONE_NUMBER', 'IBAN_CODE', 'BG_EGN'],
            score_threshold: 0.35,
        });
    });
});

describe('the answer', () => {
    it('maps types, converts code-point offsets to UTF-16, and drops types outside D-L1-1', async () => {
        const text = '😀 Zara at Plovdiv';
        const d = detectorAnswering(() =>
            jsonResponse([
                { entity_type: 'PERSON', start: 2, end: 6, score: 0.9, analysis_explanation: null },
                { entity_type: 'LOCATION', start: 10, end: 17, score: 0.9 },
            ]),
        );
        const spans = await d.analyze(text, 'en');
        expect(spans).toEqual([{ type: 'PERSON', start: 3, end: 7, score: 0.9 }]);
        expect(text.slice(spans[0].start, spans[0].end)).toBe('Zara');
    });

    it('a span past the text is a failure, never clamped', async () => {
        const d = detectorAnswering(() => jsonResponse([{ entity_type: 'PERSON', start: 0, end: 500, score: 1 }]));
        expect(await reasonOf(d.analyze(SECRET_TEXT, 'en'))).toBe('SPAN_OUT_OF_RANGE');
    });
});

describe('every failure throws a named reason', () => {
    it.each<[string, string, () => Response | Promise<Response>]>([
        ['HTTP 500', 'HTTP_ERROR', () => new Response('boom', { status: 500 })],
        ['not JSON', 'MALFORMED_RESPONSE', () => new Response('<html>', { status: 200 })],
        ['wrong shape', 'MALFORMED_RESPONSE', () => jsonResponse({ results: [] })],
        ['score out of range', 'MALFORMED_RESPONSE', () => jsonResponse([{ entity_type: 'PERSON', start: 0, end: 4, score: 7 }])],
        [
            'declared oversize',
            'TOO_LARGE',
            () => new Response('[]', { status: 200, headers: { 'content-length': String(PII_MAX_RESPONSE_BYTES + 1) } }),
        ],
        ['streamed oversize', 'TOO_LARGE', () => new Response(`[${' '.repeat(PII_MAX_RESPONSE_BYTES + 10)}]`, { status: 200 })],
        [
            'network refusal',
            'EGRESS_REFUSED',
            () => {
                throw new Error('ECONNREFUSED');
            },
        ],
    ])('%s → %s', async (_label, reason, respond) => {
        expect(await reasonOf(detectorAnswering(respond).analyze(SECRET_TEXT, 'en'))).toBe(reason);
    });

    it('a service that never answers is a TIMEOUT', async () => {
        const d = createPresidioDetector({
            baseUrl: BASE,
            scoreThreshold: 0.5,
            timeoutMs: 20,
            fetchImpl: (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                }),
        });
        expect(await reasonOf(d.analyze(SECRET_TEXT, 'en'))).toBe('TIMEOUT');
    });

    it('text over the cap is refused before anything is sent', async () => {
        const seen: Seen[] = [];
        const d = detectorAnswering(() => jsonResponse([]), seen);
        expect(await reasonOf(d.analyze('a'.repeat(PII_MAX_TEXT_BYTES + 1), 'en'))).toBe('TEXT_TOO_LARGE');
        expect(seen).toHaveLength(0);
    });
});

describe('https only, decided above the test seam', () => {
    it.each(['http://presidio:3000', 'ftp://pii.test', 'not a url'])('%s is refused without a request', async (baseUrl) => {
        const seen: string[] = [];
        const d = createPresidioDetector({
            baseUrl,
            scoreThreshold: 0.5,
            fetchImpl: async (url) => {
                seen.push(url);
                return jsonResponse([]);
            },
        });
        expect(await reasonOf(d.analyze(SECRET_TEXT, 'en'))).toBe('SCHEME_REFUSED');
        expect(seen).toEqual([]);
    });
});
