/**
 * What a hard delete takes with it from the knowledge store (vector store
 * Phase 2.2, `docs/ai-architecture/weaviate.md`).
 *
 * A chunk names its source POLYMORPHICALLY (`sourceModel`, `sourceId`), so no
 * foreign key removes it when the source row goes. The two paths that
 * hard-delete a source call this first: the `data-lifecycle` purge of
 * soft-deleted rows past their grace period, and the admin's manual purge
 * (`purgeEntity`). A chunk's vectors leave with it by `ON DELETE CASCADE`.
 *
 * Called BEFORE the source's own DELETE, and harmlessly so when that DELETE is
 * then refused (a RESTRICT child holds the row): only soft-deleted rows are
 * purged, and a soft-deleted row is not indexable anyway — the index job
 * removes the same chunks for `PARENT_DELETED`. Deleting first is what lets a
 * row whose children cascade away (a policy's versions) be found at all: after
 * its DELETE there is nothing left to name them by.
 *
 * Tenant tables, the tenant purge's business: it removes `KnowledgeChunk` and
 * `KnowledgeChunkEmbedding` with everything else tenant-scoped, so a tenant's
 * purge needs nothing from here.
 *
 * Raw, parameterised SQL through `$executeRawUnsafe`, because both callers
 * already delete that way (to step around the soft-delete extension) and the
 * purge is handed an injectable client that carries only that method. The SQL
 * names the chunk table, never the embedding table (ESLint
 * `local/vector-store-single-seam`).
 *
 * @module app-layer/services/knowledge-purge
 */

/** The one method both purge paths' clients carry. */
export interface RawExecutor {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * For each model a hard delete can remove, the chunk rows it takes with it:
 * a SQL predicate over `"KnowledgeChunk"` with `$1` the tenant and `$2` the
 * deleted row's id. A model absent here has no chunks and costs no statement.
 */
const CHUNKS_OF_DELETED: Readonly<Record<string, string>> = {
    // A policy's versions cascade away with it; each approved one may hold chunks.
    Policy: `"sourceModel" = 'PolicyVersion' AND "sourceId" IN (
        SELECT "id" FROM "PolicyVersion" WHERE "tenantId" = $1 AND "policyId" = $2)`,
    PolicyVersion: `"sourceModel" = 'PolicyVersion' AND "sourceId" = $2`,
};

/** True when a hard delete of `model` can leave chunks behind unless this is called. */
export function purgeTakesKnowledge(model: string): boolean {
    return Object.prototype.hasOwnProperty.call(CHUNKS_OF_DELETED, model);
}

/**
 * Delete the knowledge chunks a hard delete of `(model, id)` in `tenantId`
 * would orphan. Returns the rows deleted; 0, with no statement sent, for a
 * model that holds none.
 */
export async function deleteKnowledgeOfPurgedRow(
    db: RawExecutor,
    model: string,
    tenantId: string | null,
    id: string,
): Promise<number> {
    if (!purgeTakesKnowledge(model) || !tenantId) return 0;
    return db.$executeRawUnsafe(
        `DELETE FROM "KnowledgeChunk" WHERE "tenantId" = $1 AND ${CHUNKS_OF_DELETED[model]}`,
        tenantId,
        id,
    );
}
