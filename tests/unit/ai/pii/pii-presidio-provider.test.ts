/**
 * The Presidio provider, reached through the real in-deployment dial (G6 as
 * amended 2026-11-12). The network is mocked where the dial reaches it —
 * `undici` and `node:dns` — never injected: the provider has no fetch seam, so
 * the address rule, the pin and the redirect refusal run in every test.
 * Invariants:
 *
 *   - it asks for exactly the D-L1-1 types, in the requested locale, at the
 *     record's threshold, at `<base>/analyze`;
 *   - it converts code-point offsets and drops out-of-scope types;
 *   - EVERY failure throws a named reason — it never answers [] for "could not
 *     tell" — and no failure message carries the analysed text;
 *   - the service must be INSIDE the deployment: http is admitted (the Compose
 *     network is plaintext by design), a public address is refused before any
 *     request, and a DNS failure is UNREACHABLE, not a refusal;
 *   - text and response are capped, and the cap aborts the read.
 */
const mockFetch = jest.fn<Promise<Response>, [string, RequestInit]>();
jest.mock('undici', () => ({
    Agent: class {},
    fetch: (url: string, init: RequestInit) => mockFetch(url, init),
}));
const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

import { createPresidioDetector, PII_MAX_RESPONSE_BYTES, PII_MAX_TEXT_BYTES } from '@/lib/ai/pii/presidio-provider';
import { PiiDetectorError } from '@/lib/ai/pii/types';

// The service on the Compose network: plaintext http by design, a private address.
const BASE = 'http://presidio:3000';
const INSIDE = [{ address: '172.18.0.20', family: 4 }];
const SECRET_TEXT = 'Zara Quillfeather, phone +359 88 000 1111';

type Seen = { url: string; body: Record<string, unknown> };

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

function detectorAnswering(respond: () => Response | Promise<Response>, seen: Seen[] = [], extra: { timeoutMs?: number; baseUrl?: string } = {}) {
    mockFetch.mockImplementation(async (url, init) => {
        seen.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return respond();
    });
    return createPresidioDetector({ baseUrl: extra.baseUrl ?? BASE, scoreThreshold: 0.35, timeoutMs: extra.timeoutMs });
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

beforeEach(() => {
    mockFetch.mockReset();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue(INSIDE);
});

describe('the request', () => {
    it('names exactly the D-L1-1 types, the locale and the record threshold, at /analyze, over http inside the deployment', async () => {
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
        expect(mockLookup).toHaveBeenCalledWith('presidio', expect.anything());
    });

    it('follows no redirect: the init it dials with is manual', async () => {
        const inits: RequestInit[] = [];
        mockFetch.mockImplementation(async (_url, init) => {
            inits.push(init);
            return jsonResponse([]);
        });
        await createPresidioDetector({ baseUrl: BASE, scoreThreshold: 0 }).analyze(SECRET_TEXT, 'en');
        expect(inits[0].redirect).toBe('manual');
    });
});

describe('the answer', () => {
    it('keeps the in-scope types, converts code-point offsets to UTF-16, and drops types outside D-L1-1', async () => {
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
        ['a redirect', 'EGRESS_REFUSED', () => new Response(null, { status: 302, headers: { location: 'https://example.test/' } })],
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
            'socket failure',
            'UNREACHABLE',
            () => {
                throw new Error('ECONNREFUSED');
            },
        ],
    ])('%s → %s', async (_label, reason, respond) => {
        expect(await reasonOf(detectorAnswering(respond).analyze(SECRET_TEXT, 'en'))).toBe(reason);
    });

    it('a service that never answers is a TIMEOUT', async () => {
        mockFetch.mockImplementation(() => new Promise<Response>(() => undefined));
        const d = createPresidioDetector({ baseUrl: BASE, scoreThreshold: 0.5, timeoutMs: 20 });
        expect(await reasonOf(d.analyze(SECRET_TEXT, 'en'))).toBe('TIMEOUT');
    });

    it('text over the cap is refused before anything is sent', async () => {
        const seen: Seen[] = [];
        const d = detectorAnswering(() => jsonResponse([]), seen);
        expect(await reasonOf(d.analyze('a'.repeat(PII_MAX_TEXT_BYTES + 1), 'en'))).toBe('TEXT_TOO_LARGE');
        expect(seen).toHaveLength(0);
    });
});

describe('the service is inside the deployment, or it is not dialled', () => {
    it('a host whose DNS answer is public is refused before any request', async () => {
        mockLookup.mockResolvedValue([{ address: '203.0.113.5', family: 4 }]);
        const d = detectorAnswering(() => jsonResponse([]));
        expect(await reasonOf(d.analyze(SECRET_TEXT, 'en'))).toBe('EGRESS_REFUSED');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('a host that does not resolve is UNREACHABLE — the service is not there — and nothing is sent', async () => {
        mockLookup.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND presidio'), { code: 'ENOTFOUND' }));
        const d = detectorAnswering(() => jsonResponse([]));
        expect(await reasonOf(d.analyze(SECRET_TEXT, 'en'))).toBe('UNREACHABLE');
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each(['https://203.0.113.5', 'http://169.254.169.254', 'http://metadata.google.internal'])(
        '%s is refused at the endpoint, before DNS',
        async (baseUrl) => {
            const d = detectorAnswering(() => jsonResponse([]), [], { baseUrl });
            expect(await reasonOf(d.analyze(SECRET_TEXT, 'en'))).toBe('EGRESS_REFUSED');
            expect(mockLookup).not.toHaveBeenCalled();
            expect(mockFetch).not.toHaveBeenCalled();
        },
    );

    it.each(['ftp://presidio', 'not a url'])('%s is refused without a request', async (baseUrl) => {
        const d = detectorAnswering(() => jsonResponse([]), [], { baseUrl });
        expect(await reasonOf(d.analyze(SECRET_TEXT, 'en'))).toBe('SCHEME_REFUSED');
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
