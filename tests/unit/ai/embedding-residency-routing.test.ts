/**
 * The embedding / rerank seam routes by residency and refuses rather than
 * falls back (`src/lib/ai/embeddings/select.ts`).
 *
 * Only `@/env` is mocked. The egress policy (`checkWebhookUrl`) is the real
 * one, so "the endpoint the policy refuses is refused up front" is asserted
 * against the policy that will refuse it at the socket.
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
    AI_EMBED_LOCAL_BASE_URL: 'https://tei-embed.internal-ops.example.com',
    AI_EMBED_LOCAL_MODEL: 'nemotron-embed-under-evaluation',
    AI_EMBED_LOCAL_DIMENSIONS: '1024',
    AI_EMBED_LOCAL_QUERY_PREFIX: 'query: ',
    AI_EMBED_LOCAL_PASSAGE_PREFIX: 'passage: ',
    AI_RERANK_LOCAL_BASE_URL: 'https://tei-rerank.internal-ops.example.com',
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

describe('the egress policy is asked when the route is chosen', () => {
    it.each([
        ['plain http on the compose network', 'http://tei-embed:80'],
        ['loopback', 'https://127.0.0.1:8080'],
        ['cloud metadata', 'https://169.254.169.254'],
    ])('%s is refused by name before any text is queued', (_label, url) => {
        configure({ AI_EMBED_LOCAL_BASE_URL: url, AI_RERANK_LOCAL_BASE_URL: url });
        const embed = getEmbeddingProvider({ residency: 'LOCAL_ONLY' });
        const rerank = getRerankProvider({ residency: 'LOCAL_ONLY' });
        expect(embed.ok ? null : embed.reason).toBe('EMBED_ENDPOINT_REFUSED_BY_EGRESS_POLICY');
        expect(rerank.ok ? null : rerank.reason).toBe('RERANK_ENDPOINT_REFUSED_BY_EGRESS_POLICY');
        expect(teiEmbeddingCtor).not.toHaveBeenCalled();
        expect(teiRerankCtor).not.toHaveBeenCalled();
    });
});
