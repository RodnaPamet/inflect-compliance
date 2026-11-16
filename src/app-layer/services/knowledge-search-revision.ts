/**
 * THE RETRIEVER REVISION `search_knowledge` RUNS — what its evaluation record
 * must be keyed by (vector store Phase 3.5, `docs/ai-architecture/weaviate.md`;
 * the record format is `src/lib/ai/evals/rag-record.ts`, Ragas Phase 0.6).
 *
 * Pure: every term is a constant of this build or an argument. The two
 * deployment terms — which embedding model, at how many dimensions — come from
 * the embedding route the operator configured (`AI_EMBED_LOCAL_MODEL`,
 * `AI_EMBED_LOCAL_DIMENSIONS`), passed in by the caller, so the mount gate, the
 * query path and the Ragas harness all derive the SAME revision from the same
 * function rather than each spelling it.
 *
 *   embeddingModel  the route's model id (never the provider id: where a model
 *                   runs is not part of what it is)
 *   dimensions      the route's dimension count
 *   rerankModel     null — the query path has no reranker yet
 *                   (`nemotron-retriever.md` Phase 2 changes this, and with it
 *                   the key, which forces a new record)
 *   chunker         `paragraph@1`, the index job's chunker
 *   k               `KNOWLEDGE_RETRIEVAL_K`: every search retrieves this many
 *                   and returns the first `k` the caller asked for, so any
 *                   smaller `k` is a prefix of exactly what the record measured
 *   indexParams     the HNSW index as the store searches it: cosine, the build
 *                   parameters of the migration, and the per-transaction search
 *                   settings (`HNSW_SEARCH`)
 *
 * The store's EXACT path for a tenant at or below `EXACT_SCAN_MAX_ROWS` is not
 * in the key: it changes recall only upwards (to 1), and the record's
 * `indexParams` names one method. The floor probe pins `strategy: 'index'` so
 * what the record measures is the index, not the exact scan a seed-sized
 * tenant would otherwise get.
 *
 * @module app-layer/services/knowledge-search-revision
 */
import { HNSW_BUILD, HNSW_SEARCH } from '@/app-layer/repositories/vector-search-params';
import type { RetrieverRevision } from '@/lib/ai/embeddings/revision';
import { PARAGRAPH_CHUNKER_REVISION } from '@/lib/knowledge/paragraph-chunker';

/** The most hits `search_knowledge` returns in one call, and the bound on its `k` argument. */
export const KNOWLEDGE_SEARCH_MAX_K = 20;

/** `k` when the caller names none. */
export const KNOWLEDGE_SEARCH_DEFAULT_K = 5;

/**
 * How many hits every search retrieves before the caller's `k` is applied —
 * the revision's `k`. Equal to the maximum, so a call at any `k` reads a
 * prefix of the same ranking the record evaluated.
 */
export const KNOWLEDGE_RETRIEVAL_K = KNOWLEDGE_SEARCH_MAX_K;

/** The embedding route's two facts the revision names. */
export interface EmbeddingRouteFacts {
    readonly model: string;
    readonly dimensions: number;
}

export function knowledgeRetrieverRevision(route: EmbeddingRouteFacts): RetrieverRevision {
    return {
        embeddingModel: route.model,
        dimensions: route.dimensions,
        rerankModel: null,
        chunker: PARAGRAPH_CHUNKER_REVISION,
        k: KNOWLEDGE_RETRIEVAL_K,
        indexParams: {
            method: 'hnsw',
            distance: 'cosine',
            m: HNSW_BUILD.m,
            efConstruction: HNSW_BUILD.efConstruction,
            // The store sets ef_search to at least k (`pgvector-store.ts`).
            efSearch: Math.max(HNSW_SEARCH.efSearch, KNOWLEDGE_RETRIEVAL_K),
            iterativeScan: HNSW_SEARCH.iterativeScan,
            maxScanTuples: HNSW_SEARCH.maxScanTuples,
        },
    };
}
