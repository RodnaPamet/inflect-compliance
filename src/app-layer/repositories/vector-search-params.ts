/**
 * The vector store's search and index-build parameters (vector store Phase
 * 3.2, `docs/ai-architecture/weaviate.md`), in a LEAF module with no imports.
 *
 * They are what the pgvector backend searches with AND part of the retriever
 * revision an evaluation record is keyed by (`services/knowledge-search-revision.ts`),
 * so the revision and the mount gate read them from here rather than loading
 * the backend to learn three numbers. The backend's contract re-exports them
 * (`vector/types.ts`), and `VectorRepository` re-exports them again.
 */

/**
 * At or below this many vectors of a revision, a tenant's search is an EXACT
 * scan of its own rows rather than the shared HNSW index (Phase 3.2).
 *
 * The index is shared by every tenant holding the model, and pgvector filters
 * the tenant AFTER the approximate scan, so a small tenant beside a large one
 * is the case an index serves worst. Its own rows are also the case an exact
 * scan serves best: 2,000 vectors of 384 dimensions is about three MB of
 * floats, read from the tenant-leading btree in one bitmap scan. Exact recall
 * is 1 by construction. Above the threshold the index serves, with the
 * iterative scan below, and the fallback in `auto` covers a starved scan.
 */
export const EXACT_SCAN_MAX_ROWS = 2_000;

/**
 * The HNSW search parameters every indexed search runs with, set per
 * transaction (pgvector 0.8). `relaxed_order` keeps reading the index until
 * `k` rows survive the tenant filter, possibly slightly out of distance order,
 * which the outer query's sort puts right; `MAX_SCAN_TUPLES` bounds how far it
 * reads (pgvector's own default, stated rather than inherited, because it is
 * part of the retriever revision an evaluation record is keyed by); and
 * `EF_SEARCH` is the candidate list per step, at least `k`.
 */
export const HNSW_SEARCH = {
    iterativeScan: 'relaxed_order',
    maxScanTuples: 20_000,
    efSearch: 40,
} as const;

/**
 * The HNSW build parameters of the partial indexes the migrations create
 * (`20261115190000_knowledge_vector_store`: no `WITH (...)`, so pgvector's
 * defaults). Stated here because they are part of the retriever revision;
 * a migration that rebuilds an index with others changes this in the same diff.
 */
export const HNSW_BUILD = { m: 16, efConstruction: 64 } as const;
