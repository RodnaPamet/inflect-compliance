/**
 * The in-process vector backend: a reference implementation, held in memory.
 *
 * It is what the tests run the repository's behaviour against, and the
 * statement of what the pgvector backend must do. It is NEVER selected by
 * `getVectorRepository()` — production either has pgvector or has no vector
 * store at all — so nothing a tenant writes ever lands in a process's heap
 * and disappears on restart while looking stored.
 *
 * Isolation here is by construction: rows are filed under `ctx.tenantId`,
 * and every method reads only that tenant's map. There is no method that
 * accepts a tenant id, so there is no argument to get wrong.
 *
 * Every write stamps the row with the next value of a store-wide write
 * sequence (the pgvector backend's `writeSeq`). A rebuild notes the sequence
 * when it starts and, at the end, deletes only rows it did not stamp that
 * were last written BEFORE it started — so an upsert or another rebuild
 * landing between its batches is never erased by it.
 */

import type { RequestContext } from '@/app-layer/types';
import {
    compareKeys,
    cosineSimilarity,
    keyOf,
    VectorStoreError,
    type RebuildOutcome,
    type StoredVectorKey,
    type UpsertOutcome,
    type VectorMatch,
    type VectorRecord,
    type VectorSearchQuery,
    type VectorStoreBackend,
} from './types';

interface Row {
    sourceModel: string;
    sourceId: string;
    chunkIndex: number;
    embeddingRevision: string;
    contentHash: string;
    embedding: readonly number[];
    /** The rebuild that last wrote or confirmed the row; 0 for a plain upsert's new row. */
    generation: number;
    /** When the row was last written or confirmed, on the store's write sequence. */
    writeSeq: number;
}

export function createInProcessVectorStore(): VectorStoreBackend {
    const tenants = new Map<string, Map<string, Row>>();
    let generationCounter = 0;
    let writeSeq = 0;

    function rowsOf(ctx: RequestContext): Map<string, Row> {
        let rows = tenants.get(ctx.tenantId);
        if (!rows) {
            rows = new Map();
            tenants.set(ctx.tenantId, rows);
        }
        return rows;
    }

    function assertRevisionDimensions(rows: Map<string, Row>, record: VectorRecord): void {
        for (const row of rows.values()) {
            if (
                row.embeddingRevision === record.embeddingRevision &&
                row.embedding.length !== record.embedding.length
            ) {
                throw new VectorStoreError(
                    'REVISION_DIMENSION_MISMATCH',
                    `revision ${record.embeddingRevision} holds ${row.embedding.length}-dimensional vectors`,
                );
            }
        }
    }

    function write(
        rows: Map<string, Row>,
        records: readonly VectorRecord[],
        generation: number | null,
        outcome: UpsertOutcome,
    ): void {
        for (const record of records) assertRevisionDimensions(rows, record);
        for (const record of records) {
            const key = keyOf(record);
            const existing = rows.get(key);
            if (existing && existing.contentHash === record.contentHash) {
                if (generation !== null) existing.generation = generation;
                existing.writeSeq = ++writeSeq;
                outcome.unchanged++;
                continue;
            }
            rows.set(key, {
                sourceModel: record.sourceModel,
                sourceId: record.sourceId,
                chunkIndex: record.chunkIndex,
                embeddingRevision: record.embeddingRevision,
                contentHash: record.contentHash,
                embedding: [...record.embedding],
                generation: generation ?? existing?.generation ?? 0,
                writeSeq: ++writeSeq,
            });
            if (existing) outcome.updated++;
            else outcome.inserted++;
        }
    }

    return {
        kind: 'in-process',

        async upsert(ctx, records) {
            const outcome: UpsertOutcome = { inserted: 0, updated: 0, unchanged: 0 };
            write(rowsOf(ctx), records, null, outcome);
            return outcome;
        },

        async search(ctx, query: VectorSearchQuery): Promise<VectorMatch[]> {
            const rows = tenants.get(ctx.tenantId);
            if (!rows) return [];
            const models = query.sourceModels ? new Set(query.sourceModels) : null;
            const hits: VectorMatch[] = [];
            for (const row of rows.values()) {
                if (row.embeddingRevision !== query.embeddingRevision) continue;
                if (models && !models.has(row.sourceModel)) continue;
                if (row.embedding.length !== query.embedding.length) {
                    throw new VectorStoreError(
                        'DIMENSION_MISMATCH',
                        `revision ${query.embeddingRevision} holds ${row.embedding.length}-dimensional vectors`,
                    );
                }
                hits.push({
                    sourceModel: row.sourceModel,
                    sourceId: row.sourceId,
                    chunkIndex: row.chunkIndex,
                    contentHash: row.contentHash,
                    score: cosineSimilarity(row.embedding, query.embedding),
                });
            }
            hits.sort((a, b) => b.score - a.score || compareKeys(a, b));
            return hits.slice(0, query.k);
        },

        async listKeys(ctx, embeddingRevision, limit): Promise<StoredVectorKey[]> {
            const rows = tenants.get(ctx.tenantId);
            if (!rows) return [];
            return [...rows.values()]
                .filter((r) => r.embeddingRevision === embeddingRevision)
                .sort(compareKeys)
                .slice(0, limit)
                .map((r) => ({
                    sourceModel: r.sourceModel,
                    sourceId: r.sourceId,
                    chunkIndex: r.chunkIndex,
                    embeddingRevision: r.embeddingRevision,
                    contentHash: r.contentHash,
                    dimensions: r.embedding.length,
                }));
        },

        async deleteSource(ctx, sourceModel, sourceId) {
            const rows = tenants.get(ctx.tenantId);
            if (!rows) return 0;
            let deleted = 0;
            for (const [key, row] of rows) {
                if (row.sourceModel === sourceModel && row.sourceId === sourceId) {
                    rows.delete(key);
                    deleted++;
                }
            }
            return deleted;
        },

        async deleteTenant(ctx) {
            const rows = tenants.get(ctx.tenantId);
            const deleted = rows?.size ?? 0;
            tenants.delete(ctx.tenantId);
            return deleted;
        },

        async rebuildRevision(ctx, embeddingRevision, batches): Promise<RebuildOutcome & { seen: number }> {
            const generation = ++generationCounter;
            const startSeq = writeSeq;
            const rows = rowsOf(ctx);
            const outcome: RebuildOutcome = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
            let seen = 0;
            for await (const batch of batches) {
                write(rows, batch, generation, outcome);
                seen += batch.length;
            }
            for (const [key, row] of rows) {
                if (
                    row.embeddingRevision === embeddingRevision &&
                    row.generation !== generation &&
                    row.writeSeq <= startSeq
                ) {
                    rows.delete(key);
                    outcome.deleted++;
                }
            }
            return { ...outcome, seen };
        },
    };
}
