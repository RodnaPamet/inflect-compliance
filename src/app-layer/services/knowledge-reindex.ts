/**
 * Rebuild one tenant's knowledge vectors from `KnowledgeChunk` (vector store
 * Phase 2.3, `docs/ai-architecture/weaviate.md`). `scripts/knowledge-reindex.ts`
 * is the operator's entry point; this is its body, kept under `src/` so it
 * type-checks with the rest and the integration suite can drive it.
 *
 * "Rebuildable from Postgres" means exactly this. The vectors of the
 * configured embedding model are recomputed from the stored chunk text alone —
 * no source row is read and nothing is re-chunked — and
 * `VectorRepository.rebuildRevision` makes the tenant's rows of that model
 * EXACTLY those vectors: one per chunk, carrying the chunk's `contentHash`. A
 * row of the model whose chunk is gone is deleted after the last batch, and a
 * rebuild that fails part-way (an embedding call, the store) deletes nothing,
 * leaving at worst a superset (the repository's contract).
 *
 * It is also the migration path to a new embedding model: with the new model
 * configured, every chunk gains a vector of the new model under its own
 * revision, beside the old model's rows, which this never touches.
 *
 * ── What "the same vectors" means ───────────────────────────────────────
 *
 * The `contentHash` set is reproduced exactly: it is read off the chunks. A
 * recomputed vector equals the stored one only as far as the model is
 * deterministic. The stub embedder is exactly reproducible. A real model
 * served by `tei-embed` on the same revision and hardware is expected to
 * reproduce each vector to floating-point noise, a cosine similarity of at
 * least `1 - RECOMPUTE_COSINE_TOLERANCE` with the original: the batch's padding
 * and the CPU's instruction set move the last bits, nothing more. A larger gap
 * under the "same" model id means it is NOT the same model (another revision
 * behind the id, a changed passage prefix), which is a new retriever revision
 * that needs its own evaluation record (G11), not a quiet rebuild.
 *
 * The backend KEEPS a stored vector whose hash already matches its chunk (an
 * upsert of the same hash rewrites nothing), so a rebuild over a healthy index
 * embeds every chunk, stamps every row and changes no vector; after a loss of
 * the store, the case it exists for, it recomputes every one.
 *
 * @module app-layer/services/knowledge-reindex
 */
import { getVectorRepository, VectorStoreError, type VectorRecord } from '@/app-layer/repositories/VectorRepository';
import { KnowledgeChunkRepository } from '@/app-layer/repositories/KnowledgeChunkRepository';
import { getEmbeddingProvider, INDEX_EMBED_BATCH, type EmbeddingFailure } from '@/lib/ai/embeddings';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { indexContext, readResidency, type KnowledgeIndexDeps } from './knowledge-index';

/** Chunks read per page; the read is decrypted, so a page is held in memory at once. */
export const REINDEX_PAGE_SIZE = 200;

/**
 * How far a recomputed vector may drift from the one it replaces, under the
 * same model revision, as `1 - cosine`. See the module header for what it
 * means for a real model; the stub reproduces exactly.
 */
export const RECOMPUTE_COSINE_TOLERANCE = 1e-6;

export type KnowledgeReindexOutcome =
    | 'REBUILT'
    | 'VECTOR_STORE_DISABLED'
    | 'EMBEDDING_NOT_CONFIGURED'
    | 'EMBED_FAILED'
    | 'STORE_REFUSED';

export interface KnowledgeReindexResult {
    readonly outcome: KnowledgeReindexOutcome;
    readonly embeddingModel?: string;
    /** Chunks read and re-embedded. */
    readonly chunks: number;
    readonly embedCalls: number;
    readonly inserted: number;
    readonly updated: number;
    readonly unchanged: number;
    /** Rows of the model whose chunk is gone, deleted after the last batch. */
    readonly deleted: number;
    readonly embedFailure?: EmbeddingFailure | string;
    readonly storeRefusal?: string;
}

class EmbedStop extends Error {
    constructor(readonly reason: EmbeddingFailure) {
        super(`embedding failed: ${reason}`);
    }
}

function nothing(outcome: KnowledgeReindexOutcome, extra: Partial<KnowledgeReindexResult> = {}): KnowledgeReindexResult {
    return { outcome, chunks: 0, embedCalls: 0, inserted: 0, updated: 0, unchanged: 0, deleted: 0, ...extra };
}

/** Rebuild the tenant's vectors of the configured model from its stored chunks. */
export async function reindexTenantKnowledge(
    input: { tenantId: string },
    deps: KnowledgeIndexDeps = {},
): Promise<KnowledgeReindexResult> {
    const vectors = deps.vectors === undefined ? getVectorRepository() : deps.vectors;
    if (!vectors) return nothing('VECTOR_STORE_DISABLED');
    const ctx = indexContext(input.tenantId);
    const choice = (deps.embedder ?? getEmbeddingProvider)(await readResidency(ctx));
    if (!choice.ok) return nothing('EMBEDDING_NOT_CONFIGURED', { embedFailure: choice.reason });
    const provider = choice.provider;
    const embeddingModel = provider.model;

    const total = await runInTenantContext(ctx, (db) => KnowledgeChunkRepository.countForTenant(db, ctx));
    let chunks = 0;
    let embedCalls = 0;

    async function* recomputed(): AsyncGenerator<readonly VectorRecord[]> {
        let afterId: string | undefined;
        for (;;) {
            const page = await runInTenantContext(ctx, (db) =>
                KnowledgeChunkRepository.listForTenant(db, ctx, { afterId, take: REINDEX_PAGE_SIZE }),
            );
            for (let start = 0; start < page.length; start += INDEX_EMBED_BATCH) {
                const batch = page.slice(start, start + INDEX_EMBED_BATCH);
                embedCalls += 1;
                const result = await provider.embed(batch.map((c) => c.text), { inputType: 'passage' });
                if (!result.ok) throw new EmbedStop(result.reason);
                if (result.model !== provider.model) throw new EmbedStop('SERVED_MODEL_MISMATCH');
                if (result.vectors.length !== batch.length) throw new EmbedStop('COUNT_MISMATCH');
                chunks += batch.length;
                yield batch.map((c, i) => ({
                    sourceModel: c.sourceModel,
                    sourceId: c.sourceId,
                    chunkIndex: c.chunkIndex,
                    embeddingRevision: embeddingModel,
                    contentHash: c.contentHash,
                    embedding: result.vectors[i],
                }));
            }
            if (page.length < REINDEX_PAGE_SIZE) return;
            afterId = page[page.length - 1].id;
        }
    }

    try {
        // An empty source is allowed only when the tenant holds no chunk: the
        // repository refuses an empty rebuild otherwise, because "nothing was
        // read" and "the read is broken" look alike and only one should erase.
        const r = await vectors.rebuildRevision(ctx, embeddingModel, recomputed(), { allowEmpty: total === 0 });
        return {
            outcome: 'REBUILT',
            embeddingModel,
            chunks,
            embedCalls,
            inserted: r.inserted,
            updated: r.updated,
            unchanged: r.unchanged,
            deleted: r.deleted,
        };
    } catch (err) {
        if (err instanceof EmbedStop) {
            return nothing('EMBED_FAILED', { embeddingModel, chunks, embedCalls, embedFailure: err.reason });
        }
        if (err instanceof VectorStoreError) {
            return nothing('STORE_REFUSED', { embeddingModel, chunks, embedCalls, storeRefusal: err.reason });
        }
        throw err;
    }
}
