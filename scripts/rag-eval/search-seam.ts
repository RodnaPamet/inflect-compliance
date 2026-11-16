/**
 * The ONE place the Ragas retrieval stage meets the search it measures
 * (Ragas Phase 1, `docs/ai-architecture/ragas.md` 1.2; vector store Phase 3,
 * `docs/ai-architecture/weaviate.md` 3.5-3.6).
 *
 * Four facts, each read from the product rather than spelled here:
 *
 *   productQuery       the store query `searchKnowledge` issues for the
 *                      probe's context: `knowledgeVectorQuery`, the product's
 *                      own function — the revision's depth
 *                      (`KNOWLEDGE_RETRIEVAL_K`, 20) over the source models
 *                      the caller may read. The probe times that 20-deep call,
 *                      keeps its first 10 (recall@10, D-L4-9 as amended
 *                      2026-11-16) and compares them with the exact top 10 of
 *                      the same tenant under the same filter.
 *   annQuery           how the probe's ANN arm asks `VectorRepository.search`:
 *                      the product's query with `strategy: 'index'`, the path
 *                      the product takes above the exact-scan threshold. The
 *                      store's default (`auto`) takes
 *                      an EXACT scan for a tenant of at most
 *                      `EXACT_SCAN_MAX_ROWS` vectors and falls back to one when
 *                      the index comes up short, either of which would make
 *                      recall 1 by construction. Pinned to the index, the arm
 *                      measures the index and nothing else.
 *   searchSettings     the per-transaction HNSW settings the store's indexed
 *                      search runs under at depth `k`: `HNSW_SEARCH`
 *                      (`vector-search-params.ts`), with `ef_search` at least
 *                      `k` as the store sets it. The probe applies the same
 *                      ones to read each question's plan, and they are part of
 *                      the revision.
 *   retrieverRevision  what the record is keyed by:
 *                      `knowledgeRetrieverRevision({ model, dimensions })`
 *                      (`services/knowledge-search-revision.ts`), the function
 *                      the `search_knowledge` mount gate keys its records by,
 *                      so a record this stage writes is found by the gate it
 *                      is meant to open. The probe no longer states a `k` of
 *                      its own: the revision's is `KNOWLEDGE_RETRIEVAL_K`.
 *
 * `tests/unit/rag-eval-gate-agreement.test.ts` builds this revision and the
 * gate's for the same route and holds them equal, holds the settings the
 * probe reads its plans under to the ones the revision states, and holds the
 * probe's query to the one `searchKnowledge` actually sends the store. And whatever
 * this file says, `probe.ts` refuses a run whose questions were not planned
 * the way the revision states (`assertPlansMatchRevision`), so a revision that
 * says `hnsw` can never be carried by exact plans.
 */
import { HNSW_SEARCH } from '@/app-layer/repositories/vector-search-params';
import type { VectorSearchQuery } from '@/app-layer/repositories/VectorRepository';
import { knowledgeRetrieverRevision, type EmbeddingRouteFacts } from '@/app-layer/services/knowledge-search-revision';
import type { RequestContext } from '@/app-layer/types';
import { knowledgeVectorQuery } from '@/app-layer/usecases/knowledge-search';
import type { RagEvaluationRecord } from '@/lib/ai/evals/rag-record';

type RetrieverRevision = RagEvaluationRecord['retrieverRevision'];

export interface SearchSettings {
    readonly iterativeScan: 'strict_order' | 'relaxed_order';
    readonly efSearch: number;
    /** null: the store leaves `hnsw.max_scan_tuples` at the server's value, which the probe reads. */
    readonly maxScanTuples: number | null;
}

/** The store query `searchKnowledge` would send for this context, model and question vector. */
export function productQuery(ctx: RequestContext, embeddingRevision: string, embedding: readonly number[]): VectorSearchQuery {
    return knowledgeVectorQuery(ctx, embeddingRevision, embedding);
}

/** The ANN arm's query: the product's, on the index path, never an exact shortcut. */
export function annQuery(q: VectorSearchQuery): VectorSearchQuery {
    return { ...q, strategy: 'index' };
}

/** The settings `VectorRepository.search` applies to an indexed search at depth `k`. */
export function searchSettings(k: number): SearchSettings {
    return {
        iterativeScan: HNSW_SEARCH.iterativeScan,
        efSearch: Math.max(HNSW_SEARCH.efSearch, k),
        maxScanTuples: HNSW_SEARCH.maxScanTuples,
    };
}

/** The revision a record is keyed by: the one the mount gate compares, for the embedding route the probe ran. */
export function retrieverRevision(route: EmbeddingRouteFacts): RetrieverRevision {
    return knowledgeRetrieverRevision(route);
}
