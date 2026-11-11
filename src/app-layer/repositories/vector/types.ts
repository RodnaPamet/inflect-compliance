/**
 * The vector store's record shapes and its backend contract.
 *
 * Nothing outside `src/app-layer/repositories/VectorRepository.ts` and this
 * directory may import from here (ESLint `local/vector-store-single-seam`).
 * Callers go through the repository, which validates every record and every
 * query before a backend sees it.
 *
 * ── The vectors-only rule (D-L4-2) ────────────────────────────────────
 *
 * A row in the vector store is a KEY and a VECTOR, never text. The key is
 * `(tenantId, sourceModel, sourceId, chunkIndex, embeddingRevision)`; beside
 * it sit the `contentHash` of the chunk the vector was computed from and the
 * vector's `dimensions`. The chunk's text lives in Postgres under the
 * encryption manifest (the `KnowledgeChunk` row of the Weaviate/pgvector
 * roadmap's Phase 2) and is hydrated at query time through the ordinary
 * repositories, under RLS. So every field here is derived from a source row
 * plus an embedding call: losing the store loses nothing, and
 * `rebuildRevision` restores it from the system of record.
 *
 * `VectorRecord` has no text member, and the repository REFUSES a record
 * carrying any key it does not name, so a caller that spreads a chunk object
 * (`{ ...chunk, embedding }`) into a write is refused rather than having its
 * text silently dropped or, in a later backend, silently stored.
 */

import type { RequestContext } from '@/app-layer/types';

/** The identity of one chunk's vector inside a tenant, minus the tenant. */
export interface VectorKey {
    /** The Prisma model the chunk was cut from, e.g. `PolicyVersion`. */
    sourceModel: string;
    /** That row's id. */
    sourceId: string;
    /** The chunk's position within its source, from 0. */
    chunkIndex: number;
    /**
     * Which embedding produced the vector: model and anything else that
     * changes the vector space (dimensions, normalisation, prompt prefix).
     * Vectors of two revisions are never compared with each other.
     */
    embeddingRevision: string;
}

/** One vector, ready to store. Deliberately carries no text. */
export interface VectorRecord extends VectorKey {
    /** Hex SHA-256 of the chunk text the vector was computed from. */
    contentHash: string;
    /** The vector itself; its length is `dimensions`. */
    embedding: readonly number[];
}

/** What a stored row looks like when listed: the key and the hash, no vector. */
export interface StoredVectorKey extends VectorKey {
    contentHash: string;
    dimensions: number;
}

export interface VectorSearchQuery {
    embeddingRevision: string;
    embedding: readonly number[];
    /** At most `MAX_SEARCH_K`. */
    k: number;
    /** Restrict the search to these source models; absent = every model. */
    sourceModels?: readonly string[];
}

/** A search hit: a reference to hydrate under RLS, and a cosine similarity. */
export interface VectorMatch {
    sourceModel: string;
    sourceId: string;
    chunkIndex: number;
    contentHash: string;
    /** Cosine similarity in [-1, 1]; higher is closer. */
    score: number;
}

export interface UpsertOutcome {
    inserted: number;
    /** The chunk's content hash moved, so its vector was replaced. */
    updated: number;
    /** Same key, same content hash: nothing written. */
    unchanged: number;
}

export interface RebuildOutcome extends UpsertOutcome {
    /** Rows of the revision that the source no longer produces. */
    deleted: number;
}

/**
 * A backend. Every method takes the request context and derives the tenant
 * from `ctx.tenantId` alone: there is no method that takes a tenant id as a
 * plain argument, so no caller can name another tenant's rows.
 *
 * Backends receive input the repository has already validated.
 */
export interface VectorStoreBackend {
    readonly kind: 'in-process' | 'pgvector';
    upsert(ctx: RequestContext, records: readonly VectorRecord[]): Promise<UpsertOutcome>;
    search(ctx: RequestContext, query: VectorSearchQuery): Promise<VectorMatch[]>;
    /** Keys of the tenant's rows for one revision, ordered, at most `limit`. */
    listKeys(
        ctx: RequestContext,
        embeddingRevision: string,
        limit: number,
    ): Promise<StoredVectorKey[]>;
    deleteSource(ctx: RequestContext, sourceModel: string, sourceId: string): Promise<number>;
    deleteTenant(ctx: RequestContext): Promise<number>;
    /**
     * Make the tenant's rows for `embeddingRevision` exactly the records the
     * batches yield. Rows the batches do not yield are deleted only after the
     * LAST batch was written: a source that throws part-way leaves a superset
     * and deletes nothing.
     */
    rebuildRevision(
        ctx: RequestContext,
        embeddingRevision: string,
        batches: AsyncIterable<readonly VectorRecord[]>,
    ): Promise<RebuildOutcome & { seen: number }>;
}

/** Refusal reasons, each named so a caller and a log line can tell them apart. */
export type VectorStoreRefusal =
    | 'VECTOR_STORE_DISABLED'
    | 'PGVECTOR_NOT_INSTALLED'
    | 'INVALID_RECORD'
    | 'UNKNOWN_RECORD_FIELD'
    | 'DIMENSION_MISMATCH'
    | 'REVISION_DIMENSION_MISMATCH'
    | 'DUPLICATE_KEY_IN_BATCH'
    | 'BATCH_TOO_LARGE'
    | 'INVALID_QUERY'
    | 'MIXED_REVISIONS'
    | 'EMPTY_REBUILD_SOURCE';

export class VectorStoreError extends Error {
    constructor(
        readonly reason: VectorStoreRefusal,
        message: string,
    ) {
        super(`${reason}: ${message}`);
        this.name = 'VectorStoreError';
    }
}

/** Bounds, in one place. */
export const MAX_SEARCH_K = 50;
export const MAX_UPSERT_BATCH = 500;
export const MAX_LIST_KEYS = 5000;
export const MAX_DIMENSIONS = 4096;
export const MAX_CHUNK_INDEX = 100_000;

/** The map key of one row inside a tenant. */
export function keyOf(k: VectorKey): string {
    return `${k.embeddingRevision}\u0000${k.sourceModel}\u0000${k.sourceId}\u0000${k.chunkIndex}`;
}

/** Deterministic order: model, id, chunk. Used by every backend's listing. */
export function compareKeys(
    a: Pick<VectorKey, 'sourceModel' | 'sourceId' | 'chunkIndex'>,
    b: Pick<VectorKey, 'sourceModel' | 'sourceId' | 'chunkIndex'>,
): number {
    if (a.sourceModel !== b.sourceModel) return a.sourceModel < b.sourceModel ? -1 : 1;
    if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
    return a.chunkIndex - b.chunkIndex;
}

/** Cosine similarity of two equal-length, non-zero vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
