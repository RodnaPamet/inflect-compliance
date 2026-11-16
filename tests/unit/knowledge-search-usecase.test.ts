/**
 * `searchKnowledge` says WHY it cannot answer, and never answers "nothing"
 * when it could not look (vector store Phase 3.1). Every branch here returns
 * before the store or the database is read; the answering path runs against
 * the real tables in `tests/integration/knowledge-search-tool.test.ts`.
 */
jest.mock('@/app-layer/services/knowledge-index', () => ({ readResidency: jest.fn(async () => ({ residency: 'EXTERNAL' })) }));

import { createVectorRepository } from '@/app-layer/repositories/VectorRepository';
import { createInProcessVectorStore } from '@/app-layer/repositories/vector/in-process-store';
import type { KnowledgeSearchMount } from '@/app-layer/services/knowledge-search-mount';
import { knowledgeRetrieverRevision } from '@/app-layer/services/knowledge-search-revision';
import { searchKnowledge } from '@/app-layer/usecases/knowledge-search';
import { StubEmbeddingProvider, STUB_EMBEDDING_MODEL, type EmbedOptions, type EmbeddingResult } from '@/lib/ai/embeddings';
import { makeRequestContext } from '../helpers/make-context';

const DIMS = 64;
const MOUNTED: KnowledgeSearchMount = {
    state: 'MOUNTED',
    revision: knowledgeRetrieverRevision({ model: STUB_EMBEDDING_MODEL, dimensions: DIMS }),
    record: { file: 'r.json', ranAt: '2026-11-16T00:00:00.000Z' },
    figures: { recallAt10VsExact: 1, recallScored: 1, p95LatencyMs: 1, latencySamples: 1 },
};

class RecordingStub extends StubEmbeddingProvider {
    inputs: EmbedOptions[] = [];
    async embed(texts: readonly string[], opts: EmbedOptions): Promise<EmbeddingResult> {
        this.inputs.push(opts);
        return super.embed(texts, opts);
    }
}

const ctx = makeRequestContext('READER');
const vectors = () => createVectorRepository(createInProcessVectorStore());

describe('searchKnowledge refuses by name, before reading anything', () => {
    it('a caller who may not read any indexed source is refused by that source’s own policy', async () => {
        const noPolicies = { ...ctx, appPermissions: { ...ctx.appPermissions, policies: { ...ctx.appPermissions.policies, view: false } } };
        await expect(searchKnowledge(noPolicies, { query: 'q' }, { mount: MOUNTED })).rejects.toThrow(/permission to view policies/);
    });

    it('the gate closed, the store off, no route, a different revision: each is named', async () => {
        const stub = new RecordingStub(DIMS);
        const embedder = () => ({ ok: true as const, provider: stub });
        expect(await searchKnowledge(ctx, { query: 'q' }, { mount: { state: 'ABSENT', reason: 'VECTOR_STORE_DISABLED' } })).toEqual({
            available: false,
            reason: 'VECTOR_STORE_DISABLED',
        });
        expect(
            await searchKnowledge(ctx, { query: 'q' }, { mount: { state: 'UNMOUNTED', reason: 'NO_RECORD', detail: '', revision: MOUNTED.revision } }),
        ).toEqual({ available: false, reason: 'NOT_EVALUATED', detail: 'NO_RECORD' });
        expect(await searchKnowledge(ctx, { query: 'q' }, { mount: MOUNTED, vectors: null, embedder })).toEqual({
            available: false,
            reason: 'VECTOR_STORE_DISABLED',
        });
        expect(
            await searchKnowledge(ctx, { query: 'q' }, {
                mount: MOUNTED,
                vectors: vectors(),
                embedder: () => ({ ok: false as const, reason: 'EMBED_ROUTE_NOT_CONFIGURED' as const }),
            }),
        ).toEqual({ available: false, reason: 'EMBEDDING_NOT_CONFIGURED', detail: 'EMBED_ROUTE_NOT_CONFIGURED' });
        const other = new RecordingStub(DIMS * 2);
        expect(
            await searchKnowledge(ctx, { query: 'q' }, { mount: MOUNTED, vectors: vectors(), embedder: () => ({ ok: true as const, provider: other }) }),
        ).toEqual({ available: false, reason: 'REVISION_CHANGED' });
        expect(other.inputs).toEqual([]);
    });

    it('embeds the question as a QUERY, and an empty index is an available answer with no hits', async () => {
        const stub = new RecordingStub(DIMS);
        const result = await searchKnowledge(ctx, { query: '  access reviews  ' }, {
            mount: MOUNTED,
            vectors: vectors(),
            embedder: () => ({ ok: true as const, provider: stub }),
        });
        expect(result).toEqual({ available: true, embeddingModel: STUB_EMBEDDING_MODEL, hits: [], droppedStale: 0 });
        expect(stub.inputs).toEqual([{ inputType: 'query' }]);
    });
});
