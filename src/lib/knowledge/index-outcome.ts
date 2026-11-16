/**
 * How one run of the `knowledge-index` job ended (vector store Phase 2.1,
 * `docs/ai-architecture/weaviate.md`). Every run ends in exactly one of
 * these, and each is a label on `knowledge_index.runs`, so "indexed",
 * "nothing to do", "switched off" and "broken" are four different series
 * rather than one success count.
 *
 * @module lib/knowledge/index-outcome
 */

/** The run did its work. A success. */
export const KNOWLEDGE_INDEX_OK_OUTCOMES = [
    /** Chunks were written or removed, or vectors were stored. */
    'INDEXED',
    /** The source's chunks and vectors were already exactly right: a no-op. */
    'UNCHANGED',
    /**
     * The source yields no text now (gone, not approved, an external link, no
     * words), and whatever chunks it had were removed.
     */
    'SOURCE_NOT_INDEXABLE',
    /**
     * A newer run re-cut the source while this one was embedding; its vectors
     * were refused (`CONTENT_HASH_MISMATCH`) rather than filed against the
     * newer text, and the newer run owns the write.
     */
    'SUPERSEDED',
] as const;

/** The run did NOT do its work. A failure, named. */
export const KNOWLEDGE_INDEX_FAILED_OUTCOMES = [
    /** `VECTOR_STORE_BACKEND` is not `pgvector`. Nothing was read or written. */
    'VECTOR_STORE_DISABLED',
    /** No embedding route for the tenant (`AI_EMBED_LOCAL_*`). Nothing was read or written. */
    'EMBEDDING_NOT_CONFIGURED',
    /** The payload names a model the index has no reader for. */
    'UNKNOWN_SOURCE_MODEL',
    /**
     * The source cuts into more chunks than one source may hold. Nothing new
     * was written, and its older chunks were removed.
     */
    'SOURCE_TOO_LARGE',
    /** An embedding call failed; the chunks are stored and the next run embeds them. */
    'EMBED_FAILED',
    /** The vector store refused (not installed, a dimension clash). */
    'STORE_REFUSED',
] as const;

export type KnowledgeIndexOkOutcome = (typeof KNOWLEDGE_INDEX_OK_OUTCOMES)[number];
export type KnowledgeIndexFailedOutcome = (typeof KNOWLEDGE_INDEX_FAILED_OUTCOMES)[number];
export type KnowledgeIndexOutcome = KnowledgeIndexOkOutcome | KnowledgeIndexFailedOutcome;

export function isKnowledgeIndexSuccess(outcome: KnowledgeIndexOutcome): outcome is KnowledgeIndexOkOutcome {
    return (KNOWLEDGE_INDEX_OK_OUTCOMES as readonly string[]).includes(outcome);
}
