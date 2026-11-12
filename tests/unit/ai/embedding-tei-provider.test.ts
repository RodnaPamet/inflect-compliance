/**
 * The TEI embedding and rerank providers, and the one bounded request they
 * share (`src/lib/ai/embeddings/tei-provider.ts`, `http.ts`, and the shared
 * in-deployment dial `http.ts` calls).
 *
 * The network is mocked where the production module reaches it — `undici`'s
 * fetch and `node:dns` — never injected: the module has no fetch seam to
 * inject through, by design. So the perimeter resolution, the pin and the
 * redirect refusal in the shared dial (`src/lib/ai/in-deployment-service.ts`)
 * run for real in every test here.
 */
const mockFetch = jest.fn<Promise<Response>, [string, (RequestInit & { dispatcher?: unknown }) | undefined]>();
const mockAgentOptions = jest.fn();
jest.mock('undici', () => ({
    Agent: class {
        constructor(opts: unknown) {
            mockAgentOptions(opts);
        }
    },
    fetch: (url: string, init?: RequestInit) => mockFetch(url, init),
}));

const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

const mockRecord = jest.fn();
jest.mock('@/lib/ai/embeddings/metrics', () => {
    const actual = jest.requireActual('@/lib/ai/embeddings/metrics');
    return { ...actual, recordEmbeddingRequest: (x: unknown) => mockRecord(x) };
});

const mockWarn = jest.fn();
jest.mock('@/lib/observability', () => ({ logger: { warn: (...a: unknown[]) => mockWarn(...a) } }));

import { postJsonBounded } from '@/lib/ai/embeddings/http';
import { rerankOrKeepHybridOrder } from '@/lib/ai/embeddings/rerank-fallback';
import { TeiEmbeddingProvider, TeiRerankProvider } from '@/lib/ai/embeddings/tei-provider';

const BASE = 'http://tei-embed:8080/';
const INSIDE = [{ address: '172.18.0.7', family: 4 }];
const DIMS = 3;

function embedder(specifier = 'inflect-local/embed-m') {
    return new TeiEmbeddingProvider({
        specifier,
        baseUrl: BASE,
        dimensions: DIMS,
        queryPrefix: 'query: ',
        passagePrefix: 'passage: ',
    });
}

function reranker(specifier = 'inflect-local/rerank-m') {
    return new TeiRerankProvider({ specifier, baseUrl: BASE });
}

function json(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

/** The body of the n-th POST (GETs carry none). */
function sentBody(post = 0): Record<string, unknown> {
    const posts = mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    return JSON.parse(String(posts[post][1]?.body)) as Record<string, unknown>;
}

/** A TEI whose /info names `infoModel` (`null`: names none) and whose /rerank answers `rerankBody`. */
function teiReranker(rerankBody: unknown, infoModel: string | null = 'rerank-m') {
    mockFetch.mockImplementation(async (url) =>
        url.endsWith('/info') ? json(infoModel === null ? {} : { model_id: infoModel }) : json(rerankBody),
    );
}

/** An OpenAI-compatible embeddings body, served by `model` (`null`: names none). */
function embeddings(data: unknown[], model: string | null = 'embed-m') {
    return model === null ? { data } : { model, data };
}

beforeEach(() => {
    mockFetch.mockReset();
    mockAgentOptions.mockReset();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue(INSIDE);
    mockRecord.mockReset();
    mockWarn.mockReset();
});

describe('embed() never sends a specifier addressed to another provider', () => {
    it.each([['inflect-external/embed-m'], ['inflect-stub/embed-m'], ['embed-m'], ['inflect-local/']])(
        'specifier %p is refused and nothing is sent',
        async (specifier) => {
            const out = await embedder(specifier).embed(['a'], { inputType: 'passage' });
            expect(out).toEqual({ ok: false, reason: 'SPECIFIER_NOT_THIS_PROVIDER' });
            expect(mockFetch).not.toHaveBeenCalled();
        },
    );

    it('rerank() refuses a foreign specifier the same way', async () => {
        const out = await reranker('inflect-external/rerank-m').rerank('q', ['p'], { topN: 1 });
        expect(out).toEqual({ ok: false, reason: 'SPECIFIER_NOT_THIS_PROVIDER' });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("the model on the wire is the specifier's own model part", async () => {
        mockFetch.mockResolvedValue(json(embeddings([{ index: 0, embedding: [1, 0, 0] }])));
        await embedder('inflect-local/embed-m').embed(['a'], { inputType: 'passage' });
        expect(sentBody().model).toBe('embed-m');
    });
});

describe('the input type reaches the model as its configured prefix', () => {
    it.each([
        ['query' as const, ['query: alpha', 'query: beta']],
        ['passage' as const, ['passage: alpha', 'passage: beta']],
    ])('%s texts are prefixed accordingly', async (inputType, expected) => {
        mockFetch.mockResolvedValue(
            json(embeddings([{ index: 0, embedding: [1, 0, 0] }, { index: 1, embedding: [0, 1, 0] }])),
        );
        await embedder().embed(['alpha', 'beta'], { inputType });
        expect(mockFetch.mock.calls[0][0]).toBe('http://tei-embed:8080/v1/embeddings');
        expect(sentBody().input).toEqual(expected);
    });
});

describe('a successful embed returns one vector per text, in input order', () => {
    it('reorders by the response index', async () => {
        mockFetch.mockResolvedValue(
            json(embeddings([{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }])),
        );
        const out = await embedder().embed(['first', 'second'], { inputType: 'passage' });
        expect(out).toEqual({ ok: true, vectors: [[1, 0, 0], [0, 1, 0]], model: 'embed-m', dimensions: DIMS });
        expect(mockRecord).toHaveBeenCalledWith(
            expect.objectContaining({ provider: 'inflect-local', operation: 'embed', outcome: 'ok' }),
        );
    });
});

describe('a response that does not account for every text is refused whole', () => {
    it.each([
        ['one vector short', 'COUNT_MISMATCH', embeddings([{ index: 0, embedding: [1, 0, 0] }])],
        [
            'an index twice', 'COUNT_MISMATCH',
            embeddings([{ index: 0, embedding: [1, 0, 0] }, { index: 0, embedding: [0, 1, 0] }]),
        ],
        [
            'an index out of range', 'COUNT_MISMATCH',
            embeddings([{ index: 0, embedding: [1, 0, 0] }, { index: 2, embedding: [0, 1, 0] }]),
        ],
        [
            'a vector of the wrong dimension', 'DIMENSION_MISMATCH',
            embeddings([{ index: 0, embedding: [1, 0, 0] }, { index: 1, embedding: [0, 1] }]),
        ],
        ['the wrong shape', 'MALFORMED_RESPONSE', { embeddings: [[1, 0, 0]] }],
    ])('%s → %s', async (_label, reason, body) => {
        mockFetch.mockResolvedValue(json(body));
        const out = await embedder().embed(['a', 'b'], { inputType: 'passage' });
        expect(out).toEqual({ ok: false, reason });
        expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: reason.toLowerCase() }));
    });
});

describe('bounds are refused before anything is sent', () => {
    it.each([
        ['no texts', 'EMPTY_INPUT', [] as string[]],
        ['65 texts', 'BATCH_TOO_LARGE', Array.from({ length: 65 }, () => 'x')],
        ['a body over 1 MiB', 'INPUT_TOO_LARGE', ['x'.repeat(1024 * 1024)]],
    ])('%s → %s', async (_label, reason, texts) => {
        const out = await embedder().embed(texts, { inputType: 'passage' });
        expect(out).toEqual({ ok: false, reason });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('64 texts is within the bound', async () => {
        mockFetch.mockResolvedValue(
            json(embeddings(Array.from({ length: 64 }, (_, index) => ({ index, embedding: [1, 0, 0] })))),
        );
        const out = await embedder().embed(Array.from({ length: 64 }, () => 'x'), { inputType: 'passage' });
        expect(out.ok).toBe(true);
    });
});

describe('transport failures degrade to a named reason, never a throw', () => {
    it('a non-2xx status carries the status', async () => {
        mockFetch.mockResolvedValue(new Response('busy', { status: 503 }));
        expect(await embedder().embed(['a'], { inputType: 'query' })).toEqual({
            ok: false,
            reason: 'HTTP_STATUS',
            status: 503,
        });
    });

    it('a socket error is NETWORK_ERROR', async () => {
        mockFetch.mockRejectedValue(new TypeError('fetch failed'));
        expect(await embedder().embed(['a'], { inputType: 'query' })).toEqual({ ok: false, reason: 'NETWORK_ERROR' });
    });

    it('a host DNS cannot resolve is NETWORK_ERROR, and nothing is dialled', async () => {
        mockLookup.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
        expect(await embedder().embed(['a'], { inputType: 'query' })).toEqual({ ok: false, reason: 'NETWORK_ERROR' });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('a body that is not JSON is malformed', async () => {
        mockFetch.mockResolvedValue(new Response('<html>', { status: 200 }));
        expect(await embedder().embed(['a'], { inputType: 'query' })).toEqual({
            ok: false,
            reason: 'MALFORMED_RESPONSE',
        });
    });

    it('the text sent is never logged, only the reason and the count', async () => {
        mockFetch.mockResolvedValue(new Response('busy', { status: 503 }));
        await embedder().embed(['the confidential passage'], { inputType: 'passage' });
        expect(mockWarn).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(mockWarn.mock.calls);
        expect(logged).not.toContain('confidential');
        expect(mockWarn.mock.calls[0][1]).toMatchObject({ reason: 'HTTP_STATUS', count: 1, operation: 'embed' });
    });
});

describe('an inflect-local call reaches only an address inside the perimeter', () => {
    it.each([
        ['a public address', [{ address: '93.184.216.34', family: 4 }]],
        ['cloud metadata', [{ address: '169.254.169.254', family: 4 }]],
        ['one public address among private ones', [...INSIDE, { address: '8.8.8.8', family: 4 }]],
    ])('a base URL resolving to %s sends nothing — ENDPOINT_OUTSIDE_PERIMETER', async (_label, addresses) => {
        mockLookup.mockResolvedValue(addresses);
        const out = await embedder().embed(['the confidential passage'], { inputType: 'passage' });
        expect(out).toEqual({ ok: false, reason: 'ENDPOINT_OUTSIDE_PERIMETER' });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('a public literal is refused before DNS is asked', async () => {
        const out = await postJsonBounded('https://93.184.216.34/v1/embeddings', '{}', {
            service: 'embed',
            deadlineMs: 1000,
            maxResponseBytes: 1024,
        });
        expect(out).toEqual({ ok: false, reason: 'ENDPOINT_OUTSIDE_PERIMETER' });
        expect(mockLookup).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('the connection is pinned to the addresses that were checked', async () => {
        mockFetch.mockResolvedValue(json(embeddings([{ index: 0, embedding: [1, 0, 0] }])));
        await embedder().embed(['a'], { inputType: 'passage' });
        const opts = mockAgentOptions.mock.calls[0][0] as {
            connect: { lookup: (h: string, o: unknown, cb: (e: unknown, a: unknown) => void) => void };
        };
        const answered = jest.fn();
        opts.connect.lookup('tei-embed', {}, answered);
        expect(answered).toHaveBeenCalledWith(null, [{ address: '172.18.0.7', family: 4 }]);
        expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
    });

    it('a redirect is refused, not followed', async () => {
        mockFetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com' } }));
        expect(await embedder().embed(['a'], { inputType: 'query' })).toEqual({
            ok: false,
            reason: 'REDIRECT_REFUSED',
            status: 302,
        });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe('the model that answered must be the configured model', () => {
    it.each([
        ['another model of the same dimension', 'some-other-embed'],
        ['no model named', null],
    ])('an embeddings answer from %s is SERVED_MODEL_MISMATCH, not ok', async (_label, served) => {
        mockFetch.mockResolvedValue(json(embeddings([{ index: 0, embedding: [1, 0, 0] }], served)));
        const out = await embedder().embed(['a'], { inputType: 'passage' });
        expect(out).toEqual({ ok: false, reason: 'SERVED_MODEL_MISMATCH' });
        expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'served_model_mismatch' }));
    });

    it.each([
        ['another reranker', 'some-other-rerank'],
        ['no model_id', null],
    ])('a reranker whose /info names %s is refused before any passage is sent', async (_label, served) => {
        teiReranker([{ index: 0, score: 0.5 }], served);
        const out = await reranker().rerank('q', ['the confidential passage'], { topN: 1 });
        expect(out).toEqual({ ok: false, reason: 'SERVED_MODEL_MISMATCH' });
        expect(mockFetch.mock.calls.map(([url]) => url)).toEqual(['http://tei-embed:8080/info']);
    });

    it('an /info that cannot be read stops the rerank with its own reason', async () => {
        mockFetch.mockResolvedValue(new Response('down', { status: 503 }));
        expect(await reranker().rerank('q', ['p'], { topN: 1 })).toEqual({ ok: false, reason: 'HTTP_STATUS', status: 503 });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe('the response is read under a byte cap that stops reading at the cap', () => {
    it('a declared Content-Length over the cap is refused without reading', async () => {
        const res = new Response('{}', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } });
        mockFetch.mockResolvedValue(res);
        const out = await postJsonBounded('http://tei-embed:8080', '{}', {
            service: 'embed',
            deadlineMs: 1000,
            maxResponseBytes: 1024,
        });
        expect(out).toEqual({ ok: false, reason: 'RESPONSE_TOO_LARGE' });
    });

    it('an undeclared, endless body is cancelled once it passes the cap', async () => {
        let pulls = 0;
        const endless = new ReadableStream<Uint8Array>({
            // Yields between chunks so a reader without a cap meets the
            // deadline and fails as TIMEOUT, rather than starving the loop.
            async pull(controller) {
                await new Promise((resolve) => setImmediate(resolve));
                pulls += 1;
                controller.enqueue(new Uint8Array(512));
            },
        });
        mockFetch.mockResolvedValue(new Response(endless, { status: 200 }));
        const out = await postJsonBounded('http://tei-embed:8080', '{}', {
            service: 'embed',
            deadlineMs: 5000,
            maxResponseBytes: 4096,
        });
        expect(out).toEqual({ ok: false, reason: 'RESPONSE_TOO_LARGE' });
        // 4096 / 512 = 8 chunks to reach the cap; a reader that buffered the
        // whole body would never return at all.
        expect(pulls).toBeLessThan(16);
    });
});

describe('the deadline covers the whole call, and a caller abort is told apart', () => {
    it('a service that never answers is a TIMEOUT', async () => {
        mockFetch.mockReturnValue(new Promise<Response>(() => undefined));
        const out = await postJsonBounded('http://tei-embed:8080', '{}', {
            service: 'embed',
            deadlineMs: 20,
            maxResponseBytes: 1024,
        });
        expect(out).toEqual({ ok: false, reason: 'TIMEOUT' });
    });

    it('a body that stalls after the head is a TIMEOUT too', async () => {
        const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
        mockFetch.mockResolvedValue(new Response(stalled, { status: 200 }));
        const out = await postJsonBounded('http://tei-embed:8080', '{}', {
            service: 'embed',
            deadlineMs: 20,
            maxResponseBytes: 1024,
        });
        expect(out).toEqual({ ok: false, reason: 'TIMEOUT' });
    });

    it("the caller's own abort is ABORTED, not TIMEOUT", async () => {
        mockFetch.mockReturnValue(new Promise<Response>(() => undefined));
        const caller = new AbortController();
        const pending = postJsonBounded('http://tei-embed:8080', '{}', {
            service: 'embed',
            deadlineMs: 10_000,
            maxResponseBytes: 1024,
            signal: caller.signal,
        });
        caller.abort();
        expect(await pending).toEqual({ ok: false, reason: 'ABORTED' });
    });

    it('an already-aborted signal sends nothing', async () => {
        const out = await postJsonBounded('http://tei-embed:8080', '{}', {
            service: 'embed',
            deadlineMs: 1000,
            maxResponseBytes: 1024,
            signal: AbortSignal.abort(),
        });
        expect(out).toEqual({ ok: false, reason: 'ABORTED' });
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('rerank', () => {
    it('posts query and passages to /rerank and returns the top N, highest score first', async () => {
        teiReranker([
            { index: 0, score: 0.1 },
            { index: 1, score: 0.9 },
            { index: 2, score: 0.5 },
        ]);
        const out = await reranker().rerank('which policy?', ['a', 'b', 'c'], { topN: 2 });
        expect(mockFetch.mock.calls.map(([url, init]) => [init?.method, url])).toEqual([
            ['GET', 'http://tei-embed:8080/info'],
            ['POST', 'http://tei-embed:8080/rerank'],
        ]);
        expect(sentBody()).toMatchObject({ query: 'which policy?', texts: ['a', 'b', 'c'] });
        expect(out).toEqual({
            ok: true,
            model: 'rerank-m',
            hits: [
                { index: 1, score: 0.9 },
                { index: 2, score: 0.5 },
            ],
        });
    });

    it('equal scores keep the input order', async () => {
        teiReranker([{ index: 1, score: 0.5 }, { index: 0, score: 0.5 }]);
        const out = await reranker().rerank('q', ['a', 'b'], { topN: 2 });
        expect(out.ok && out.hits.map((h) => h.index)).toEqual([0, 1]);
    });

    it('a passage left unscored refuses the whole answer', async () => {
        teiReranker([{ index: 0, score: 0.5 }]);
        expect(await reranker().rerank('q', ['a', 'b'], { topN: 2 })).toEqual({ ok: false, reason: 'COUNT_MISMATCH' });
    });

    it('more than 50 passages is refused before sending', async () => {
        const out = await reranker().rerank('q', Array.from({ length: 51 }, () => 'p'), { topN: 5 });
        expect(out).toEqual({ ok: false, reason: 'BATCH_TOO_LARGE' });
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('a reranker outage returns hybrid order', () => {
    it('the first topN of the hybrid order, with the reason, never an empty result', async () => {
        mockFetch.mockResolvedValue(new Response('down', { status: 502 }));
        const out = await rerankOrKeepHybridOrder(reranker(), 'q', ['a', 'b', 'c', 'd'], { topN: 3 });
        expect(out).toEqual({ reranked: false, order: [0, 1, 2], reason: 'HTTP_STATUS' });
    });

    it('no rerank route configured keeps the hybrid order too', async () => {
        const out = await rerankOrKeepHybridOrder(null, 'q', ['a', 'b'], { topN: 5 });
        expect(out).toEqual({ reranked: false, order: [0, 1], reason: 'NO_RERANK_PROVIDER' });
    });

    it('a working reranker re-orders', async () => {
        teiReranker([{ index: 0, score: 0.2 }, { index: 1, score: 0.8 }]);
        const out = await rerankOrKeepHybridOrder(reranker(), 'q', ['a', 'b'], { topN: 2 });
        expect(out).toEqual({ reranked: true, order: [1, 0] });
    });

    it('sends at most 50 passages however many hybrid hits arrive', async () => {
        mockFetch.mockImplementation(async (url, init) => {
            if (url.endsWith('/info')) return json({ model_id: 'rerank-m' });
            const texts = (JSON.parse(String(init?.body)) as { texts: string[] }).texts;
            return json(texts.map((_, index) => ({ index, score: index })));
        });
        await rerankOrKeepHybridOrder(reranker(), 'q', Array.from({ length: 80 }, (_, i) => `p${i}`), { topN: 10 });
        expect((sentBody().texts as string[]).length).toBe(50);
    });
});
