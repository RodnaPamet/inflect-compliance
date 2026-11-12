/**
 * The deterministic stub providers and the retriever revision key
 * (`src/lib/ai/embeddings/stub-provider.ts`, `revision.ts`).
 */
import { modelOf } from '@/lib/ai/embeddings/types';
import { StubEmbeddingProvider, StubRerankProvider, stubVector } from '@/lib/ai/embeddings/stub-provider';
import {
    InvalidRetrieverRevisionError,
    retrieverRevisionKey,
    sameRetrieverRevision,
    type RetrieverRevision,
} from '@/lib/ai/embeddings/revision';

const cosine = (a: readonly number[], b: readonly number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

describe('the stub embedding is deterministic and carries a lexical signal', () => {
    it('the same text yields the same unit vector every time', async () => {
        const p = new StubEmbeddingProvider(32);
        const first = await p.embed(['Access reviews are quarterly'], { inputType: 'passage' });
        const again = await p.embed(['Access reviews are quarterly'], { inputType: 'query' });
        expect(first.ok && again.ok && first.vectors[0]).toEqual(again.ok && again.vectors[0]);
        expect(first.ok && first.vectors[0].length).toBe(32);
        expect(first.ok && cosine(first.vectors[0], first.vectors[0])).toBeCloseTo(1, 10);
    });

    it('texts sharing words are closer than texts sharing none', () => {
        const q = stubVector('access review frequency', 256);
        const near = stubVector('the access review runs quarterly', 256);
        const far = stubVector('backup encryption keys rotate', 256);
        expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
    });

    it('a text with no words is the zero vector, not NaN', () => {
        expect(stubVector('  ...  ', 8)).toEqual(new Array(8).fill(0));
    });

    it('the stub honours the same bounds as the real provider', async () => {
        const p = new StubEmbeddingProvider();
        expect(await p.embed([], { inputType: 'query' })).toEqual({ ok: false, reason: 'EMPTY_INPUT' });
        expect(await p.embed(Array.from({ length: 65 }, () => 'x'), { inputType: 'query' })).toEqual({
            ok: false,
            reason: 'BATCH_TOO_LARGE',
        });
    });

    it('is addressed as the stub, never as the local provider', () => {
        expect(new StubEmbeddingProvider().providerId).toBe('inflect-stub');
        expect(new StubRerankProvider().providerId).toBe('inflect-stub');
    });
});

describe('the stub reranker orders by word overlap', () => {
    it('the passage holding more of the query ranks first', async () => {
        const out = await new StubRerankProvider().rerank(
            'how often are access reviews run',
            ['backups nightly', 'access reviews are run quarterly', 'reviews of vendors'],
            { topN: 2 },
        );
        expect(out.ok && out.hits.map((h) => h.index)).toEqual([1, 2]);
    });
});

describe('the retriever revision key', () => {
    const base: RetrieverRevision = {
        embeddingModel: 'embed-m',
        rerankModel: null,
        chunker: 'markdown-heading@1',
        k: 10,
        alpha: 0.5,
    };

    it('adding a reranker is a new revision', () => {
        expect(sameRetrieverRevision(base, { ...base, rerankModel: 'rerank-m' })).toBe(false);
    });

    it.each([
        ['embeddingModel', { embeddingModel: 'embed-n' }],
        ['rerankModel', { rerankModel: 'rerank-n' }],
        ['chunker', { chunker: 'markdown-heading@2' }],
        ['k', { k: 11 }],
        ['alpha', { alpha: 0.6 }],
    ])('a change to %s is a new revision', (_field, change) => {
        const withRerank = { ...base, rerankModel: 'rerank-m' };
        expect(sameRetrieverRevision(withRerank, { ...withRerank, ...change })).toBe(false);
    });

    it('is independent of property order', () => {
        const reordered: RetrieverRevision = {
            alpha: 0.5,
            k: 10,
            chunker: 'markdown-heading@1',
            rerankModel: null,
            embeddingModel: 'embed-m',
        };
        expect(retrieverRevisionKey(reordered)).toBe(retrieverRevisionKey(base));
    });

    it('a separator inside a name cannot forge another revision', () => {
        const a = { ...base, embeddingModel: 'a","b', chunker: 'c' };
        const b = { ...base, embeddingModel: 'a', chunker: 'b","c' };
        expect(sameRetrieverRevision(a, b)).toBe(false);
    });

    it('names models, not where they run: the CPU and GPU arms share one revision', () => {
        const cpu = { ...base, embeddingModel: modelOf('inflect-local/embed-m') };
        const gpu = { ...base, embeddingModel: modelOf('inflect-local-gpu/embed-m') };
        expect(retrieverRevisionKey(cpu)).toBe(retrieverRevisionKey(gpu));
    });

    it.each([
        ['embeddingModel', { embeddingModel: '' }],
        ['embeddingModel', { embeddingModel: ' embed-m' }],
        ['rerankModel', { rerankModel: '' }],
        ['chunker', { chunker: '  ' }],
        ['k', { k: 0 }],
        ['k', { k: 2.5 }],
        ['k', { k: 51 }],
        ['alpha', { alpha: -0.1 }],
        ['alpha', { alpha: 1.01 }],
        ['alpha', { alpha: Number.NaN }],
    ])('an ambiguous %s is refused', (field, change) => {
        let thrown: unknown;
        try {
            retrieverRevisionKey({ ...base, ...change });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(InvalidRetrieverRevisionError);
        expect((thrown as InvalidRetrieverRevisionError).field).toBe(field);
    });
});
