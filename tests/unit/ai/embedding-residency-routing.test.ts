/**
 * The embedding / rerank seam routes by residency and refuses rather than
 * falls back (`src/lib/ai/embeddings/select.ts`).
 *
 * Only `@/env` is mocked. The perimeter check (`in-deployment-service.ts`) is the real
 * one, so "an endpoint outside the perimeter is refused up front" is asserted
 * against the rule the dial applies again at the socket.
 */
const mutableEnv: Record<string, string | undefined> = {};
jest.mock('@/env', () => ({ env: mutableEnv }));

const teiEmbeddingCtor = jest.fn();
const teiRerankCtor = jest.fn();
jest.mock('@/lib/ai/embeddings/tei-provider', () => {
    const actual = jest.requireActual('@/lib/ai/embeddings/tei-provider');
    return {
        ...actual,
        TeiEmbeddingProvider: class extends actual.TeiEmbeddingProvider {
            constructor(route: unknown) {
                super(route);
                teiEmbeddingCtor(route);
            }
        },
        TeiRerankProvider: class extends actual.TeiRerankProvider {
            constructor(route: unknown) {
                super(route);
                teiRerankCtor(route);
            }
        },
    };
});

import {
    getEmbeddingProvider,
    getRerankProvider,
    resolveEmbeddingRoute,
    resolveRerankRoute,
} from '@/lib/ai/embeddings/select';

const CONFIGURED = {
    AI_EMBED_LOCAL_BASE_URL: 'http://tei-embed:8080',
    AI_EMBED_LOCAL_MODEL: 'nemotron-embed-under-evaluation',
    AI_EMBED_LOCAL_DIMENSIONS: '1024',
    AI_EMBED_LOCAL_QUERY_PREFIX: 'query: ',
    AI_EMBED_LOCAL_PASSAGE_PREFIX: 'passage: ',
    AI_RERANK_LOCAL_BASE_URL: 'http://tei-rerank:8080',
    AI_RERANK_LOCAL_MODEL: 'nemotron-rerank-under-evaluation',
};

function configure(over: Record<string, string | undefined> = {}) {
    for (const k of Object.keys(mutableEnv)) delete mutableEnv[k];
    Object.assign(mutableEnv, CONFIGURED, over);
}

beforeEach(() => {
    jest.clearAllMocks();
    configure();
});

describe('a LOCAL_ONLY tenant with no local embed route is refused', () => {
    it('refuses by name and constructs nothing — no provider, no stub', () => {
        configure({ AI_EMBED_LOCAL_BASE_URL: undefined });
        expect(getEmbeddingProvider({ residency: 'LOCAL_ONLY' })).toEqual({
            ok: false,
            reason: 'LOCAL_EMBED_ROUTE_NOT_CONFIGURED',
        });
        expect(teiEmbeddingCtor).not.toHaveBeenCalled();
    });

    it('the rerank route refuses the same way', () => {
        configure({ AI_RERANK_LOCAL_BASE_URL: undefined });
        expect(getRerankProvider({ residency: 'LOCAL_ONLY' })).toEqual({
            ok: false,
            reason: 'LOCAL_RERANK_ROUTE_NOT_CONFIGURED',
        });
        expect(teiRerankCtor).not.toHaveBeenCalled();
    });
});

describe('the factory constructs nothing external for LOCAL_ONLY', () => {
    it('builds exactly the in-deployment provider, addressed by the operator base URL', () => {
        const choice = getEmbeddingProvider({ residency: 'LOCAL_ONLY' });
        expect(choice.ok && choice.provider.specifier).toBe('inflect-local/nemotron-embed-under-evaluation');
        expect(choice.ok && choice.provider.providerId).toBe('inflect-local');
        expect(teiEmbeddingCtor).toHaveBeenCalledTimes(1);
        expect(teiEmbeddingCtor.mock.calls[0][0]).toMatchObject({
            baseUrl: CONFIGURED.AI_EMBED_LOCAL_BASE_URL,
            dimensions: 1024,
            queryPrefix: 'query: ',
            passagePrefix: 'passage: ',
        });
    });

    it('the rerank provider likewise', () => {
        const choice = getRerankProvider({ residency: 'LOCAL_ONLY' });
        expect(choice.ok && choice.provider.specifier).toBe('inflect-local/nemotron-rerank-under-evaluation');
        expect(teiRerankCtor.mock.calls[0][0]).toMatchObject({ baseUrl: CONFIGURED.AI_RERANK_LOCAL_BASE_URL });
    });
});

describe('an EXTERNAL tenant has no external route to fall back on', () => {
    it.each([['EXTERNAL' as const], [null], [undefined]])(
        'residency %s with no service configured is refused, not routed elsewhere',
        (residency) => {
            configure({ AI_EMBED_LOCAL_BASE_URL: undefined, AI_RERANK_LOCAL_BASE_URL: undefined });
            expect(resolveEmbeddingRoute({ residency })).toEqual({ ok: false, reason: 'EMBED_ROUTE_NOT_CONFIGURED' });
            expect(resolveRerankRoute({ residency })).toEqual({ ok: false, reason: 'RERANK_ROUTE_NOT_CONFIGURED' });
        },
    );

    it('with the service configured, uses the same in-deployment route', () => {
        const route = resolveEmbeddingRoute({ residency: 'EXTERNAL' });
        expect(route.ok && route.specifier).toBe('inflect-local/nemotron-embed-under-evaluation');
    });
});

describe('absent configuration is a named refusal, never a guess', () => {
    it('no model named on the service', () => {
        configure({ AI_EMBED_LOCAL_MODEL: undefined, AI_RERANK_LOCAL_MODEL: undefined });
        expect(resolveEmbeddingRoute()).toEqual({ ok: false, reason: 'EMBED_MODEL_NOT_CONFIGURED' });
        expect(resolveRerankRoute()).toEqual({ ok: false, reason: 'RERANK_MODEL_NOT_CONFIGURED' });
    });

    it.each([[undefined], ['0'], ['-3'], ['12.5'], ['abc'], ['8193'], [' 1024']])(
        'a dimension of %p is refused',
        (dims) => {
            configure({ AI_EMBED_LOCAL_DIMENSIONS: dims });
            expect(resolveEmbeddingRoute()).toEqual({ ok: false, reason: 'EMBED_DIMENSIONS_NOT_CONFIGURED' });
        },
    );

    it('absent prefixes mean no prefix, not a default chosen in code', () => {
        configure({ AI_EMBED_LOCAL_QUERY_PREFIX: undefined, AI_EMBED_LOCAL_PASSAGE_PREFIX: undefined });
        const route = resolveEmbeddingRoute();
        expect(route.ok && [route.queryPrefix, route.passagePrefix]).toEqual(['', '']);
    });
});

describe('inflect-local routes only to an address inside the perimeter', () => {
    it.each([
        ['a public literal', 'https://93.184.216.34', 'ADDRESS_OUTSIDE_PERIMETER'],
        ['a public IPv6 literal', 'https://[2606:4700::1111]', 'ADDRESS_OUTSIDE_PERIMETER'],
        ['cloud metadata by address', 'http://169.254.169.254', 'ADDRESS_OUTSIDE_PERIMETER'],
        ['cloud metadata by name', 'http://metadata.google.internal', 'METADATA_HOST'],
        ['CGNAT space', 'http://100.64.0.9:8080', 'ADDRESS_OUTSIDE_PERIMETER'],
        ['a scheme that is not http', 'ftp://tei-embed', 'SCHEME_NOT_HTTP'],
        ['credentials in the URL', 'http://user:pw@tei-embed:8080', 'CREDENTIALS_IN_URL'],
        ['a URL that does not parse', 'http://', 'MALFORMED_URL'],
    ])('%s is refused by name before any text is queued', (_label, url, detail) => {
        configure({ AI_EMBED_LOCAL_BASE_URL: url, AI_RERANK_LOCAL_BASE_URL: url });
        const embed = getEmbeddingProvider({ residency: 'LOCAL_ONLY' });
        const rerank = getRerankProvider({ residency: 'LOCAL_ONLY' });
        expect(embed).toEqual({ ok: false, reason: 'EMBED_ENDPOINT_OUTSIDE_PERIMETER', detail });
        expect(rerank).toEqual({ ok: false, reason: 'RERANK_ENDPOINT_OUTSIDE_PERIMETER', detail });
        expect(teiEmbeddingCtor).not.toHaveBeenCalled();
        expect(teiRerankCtor).not.toHaveBeenCalled();
    });

    it.each([
        ['the compose network, plain http', 'http://tei-embed:8080'],
        ['an RFC 1918 literal', 'http://10.0.4.12:8080'],
        ['loopback', 'http://127.0.0.1:8080'],
        ['an IPv6 unique-local literal', 'https://[fd00::5]:8443'],
    ])('%s is admitted for a LOCAL_ONLY tenant', (_label, url) => {
        configure({ AI_EMBED_LOCAL_BASE_URL: url, AI_RERANK_LOCAL_BASE_URL: url });
        const embed = resolveEmbeddingRoute({ residency: 'LOCAL_ONLY' });
        const rerank = resolveRerankRoute({ residency: 'LOCAL_ONLY' });
        expect([embed.ok && embed.baseUrl, rerank.ok && rerank.baseUrl]).toEqual([url, url]);
    });
});
