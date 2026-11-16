/**
 * The ONE place the Ragas retrieval stage meets the search it measures
 * (Ragas Phase 1; vector store Phase 3.1–3.5 is PR #5751, not on `main` when
 * this was written).
 *
 * Three facts, and what each is today and once #5751 is on `main`:
 *
 *   annQuery           how the probe's ANN arm asks `VectorRepository.search`.
 *                      Today the store has one path (the index statement), so
 *                      the query goes as it is. With #5751 the store's default
 *                      (`auto`) takes an EXACT scan for a tenant of at most
 *                      `EXACT_SCAN_MAX_ROWS` rows, which would make recall 1 by
 *                      construction: the arm then pins `strategy: 'index'`.
 *   searchSettings     the per-transaction HNSW settings the store's indexed
 *                      search runs under — the probe applies the same ones to
 *                      read each question's plan, and they are part of the
 *                      revision. Today `strict_order` and `ef_search = max(40,
 *                      k)` with `max_scan_tuples` left at the server's value
 *                      (`pgvector-store.ts` `search`). With #5751 they are
 *                      `HNSW_SEARCH` (`vector-search-params.ts`).
 *   retrieverRevision  what the record is keyed by. Today it is built from what
 *                      the probe OBSERVED (the plan's HNSW index and its
 *                      definition, or `exact`), at the stage's `--k`. With #5751
 *                      it is `knowledgeRetrieverRevision({ model, dimensions })`
 *                      (`services/knowledge-search-revision.ts`), exactly what
 *                      the `search_knowledge` mount gate compares, and `--k`
 *                      goes (the revision's k is `KNOWLEDGE_RETRIEVAL_K`).
 *
 * Wiring is those three bodies and nothing else. It FAILS CLOSED if it is
 * forgotten: a record keyed by this file's observed revision does not equal
 * `knowledgeRetrieverRevision(route)` (the iterative-scan mode and k differ),
 * so the gate finds no record for its revision and the tool stays absent. And
 * whatever this file says, `probe.ts` refuses a run whose questions were not
 * planned the way the revision states (`assertPlansMatchRevision`), so a
 * revision that says `hnsw` can never be carried by exact plans.
 */
import type { VectorSearchQuery } from '@/app-layer/repositories/VectorRepository';
import type { RagEvaluationRecord } from '@/lib/ai/evals/rag-record';
import { PARAGRAPH_CHUNKER_REVISION } from '@/lib/knowledge/paragraph-chunker';

type RetrieverRevision = RagEvaluationRecord['retrieverRevision'];
type IndexParams = RetrieverRevision['indexParams'];

export interface SearchSettings {
    readonly iterativeScan: 'strict_order' | 'relaxed_order';
    readonly efSearch: number;
    /** null: the store leaves `hnsw.max_scan_tuples` at the server's value, which the probe reads. */
    readonly maxScanTuples: number | null;
}

/** The ANN arm's query: the index path, never an exact shortcut. */
export function annQuery(q: VectorSearchQuery): VectorSearchQuery {
    return q;
}

/** The settings `VectorRepository.search` applies to an indexed search at depth `k`. */
export function searchSettings(k: number): SearchSettings {
    return { iterativeScan: 'strict_order', efSearch: Math.max(40, k), maxScanTuples: null };
}

/** The revision a record is keyed by, from the embedding route and what the probe observed. */
export function retrieverRevision(route: { model: string; dimensions: number }, observed: IndexParams, k: number): RetrieverRevision {
    return { embeddingModel: route.model, rerankModel: null, chunker: PARAGRAPH_CHUNKER_REVISION, k, dimensions: route.dimensions, indexParams: observed };
}
