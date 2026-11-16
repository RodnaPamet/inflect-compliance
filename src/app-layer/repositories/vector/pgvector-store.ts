/**
 * The pgvector backend: vectors in Postgres, inside RLS.
 *
 * ── The tables ──────────────────────────────────────────────────────
 *
 * Migration `20261115190000_knowledge_vector_store` (vector store Phase 1,
 * docs/ai-architecture/weaviate.md) creates the extension and two tables:
 * `KnowledgeChunk` (the chunk's key and its ENCRYPTED text, written by the
 * index pipeline) and `KnowledgeChunkEmbedding` (one embedding model's vector
 * of one chunk: a key, a content hash and the vector, never text). This file
 * is the only one under `src/` that names the embedding table, and it never
 * reads `KnowledgeChunk.text`: it joins the chunk only for its key.
 *
 * A record's key `(sourceModel, sourceId, chunkIndex)` names a chunk; its
 * `embeddingRevision` is stored as `embeddingModel`. A write whose chunk does
 * not exist (in this tenant) is refused `CHUNK_NOT_FOUND`: a vector of no
 * chunk is a vector of no text, and the composite foreign key would refuse
 * it anyway. A write whose `contentHash` is not its chunk's is refused
 * `CONTENT_HASH_MISMATCH`: the chunk was re-cut after the vector was computed
 * (two index runs of one source overlapping), and the older run's vector
 * must not land on the newer text.
 *
 * It fails closed: before its first statement it probes for the extension
 * (0.8.0 or later) AND the table, and refuses `PGVECTOR_NOT_INSTALLED` when
 * either is missing. A positive probe is remembered for the process; a
 * negative one is asked again next call, so installing needs no restart.
 * `getVectorRepository()` constructs it only when the operator sets
 * `VECTOR_STORE_BACKEND=pgvector`.
 *
 * ── Isolation ───────────────────────────────────────────────────────
 *
 * Every statement runs inside `runInTenantContext(ctx, …)`, so it executes as
 * `app_user` with the tenant GUC bound and both tables' `tenant_isolation`
 * policies apply; and every statement ALSO names `"tenantId" = ctx.tenantId`
 * on each table it reads (the application-layer filter, defence in depth).
 * The tenant id comes from `ctx` and from nowhere else.
 *
 * ── SQL shape ───────────────────────────────────────────────────────
 *
 * Tagged `Prisma.sql` only — every value is a bind parameter. The two things
 * that are not are the table names (constants) and a vector's dimension
 * count, which is interpolated with `Prisma.raw` because a type modifier
 * cannot be a parameter; it is an integer the repository has already bounded
 * to `1..MAX_DIMENSIONS`, and `dimensionSql` re-checks it before it is spliced.
 *
 * The `embedding` column is the untyped `vector`, so one table holds every
 * model; a search casts to `vector(<dimensions>)`, which is the expression
 * each model's partial HNSW index is built on
 * (`… USING hnsw (("embedding"::vector(384)) vector_cosine_ops) WHERE
 * "embeddingModel" = 'intfloat/multilingual-e5-small'`). The model is a bind
 * parameter: the adapter sends unnamed statements, which Postgres plans with
 * the parameter values, so the partial index's predicate is provable
 * (tests/integration/vector-tenant-isolation.test.ts reads the plan).
 *
 * ── Filtered search over a shared index ────────────────────────────
 *
 * That index is shared by every tenant holding the model, and pgvector
 * applies a WHERE clause AFTER the approximate scan: with the defaults it
 * returns `hnsw.ef_search` (40) candidates across ALL tenants and then
 * filters, so a tenant holding 2% of a model's rows would get about one hit.
 * Three measures, in the order a search meets them (vector store Phase 3.2):
 *
 *   1. A tenant holding at most `EXACT_SCAN_MAX_ROWS` vectors of the revision
 *      is searched EXACTLY — a sequential read of its own rows through the
 *      `(tenantId, embeddingModel)` btree, ordered by an expression the HNSW
 *      index does not match (`buildSearchQuery(…, 'exact')`). Recall is 1.
 *   2. Above it, the index, with iterative scans on for the transaction
 *      (`hnsw.iterative_scan = relaxed_order`, pgvector 0.8.0+), which keeps
 *      reading until `k` rows survive the tenant filter or the bounded
 *      `hnsw.max_scan_tuples` is reached; the probe refuses an older
 *      extension. Relaxed order may hand rows back slightly out of distance
 *      order; the outer query sorts the `k` it kept.
 *   3. If the index still returned fewer than `k` rows of a tenant holding
 *      more (it hit `max_scan_tuples` first), the search is repeated exactly,
 *      for a tenant of at most `EXACT_FALLBACK_MAX_ROWS` rows; a larger tenant
 *      keeps what the index found, and the shortfall is logged.
 *
 * A caller may pin the path (`strategy: 'index' | 'exact'`); the floor probe
 * does, to measure the index against exact search on the same rows.
 *
 * ── A rebuild never erases a concurrent write ──────────────────────
 *
 * A rebuild runs over many transactions and ends by deleting the model's
 * rows it did not stamp. Every write stamps `writeSeq` from the table's
 * sequence after taking a SHARED advisory lock on (tenant, model); the
 * rebuild draws its own `startSeq` under the EXCLUSIVE lock, which waits for
 * every write in flight to commit. So `writeSeq > startSeq` means "written
 * after the rebuild began", and the final DELETE spares those rows.
 */

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import type { PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability';
import {
    EXACT_SCAN_MAX_ROWS,
    HNSW_SEARCH,
    MAX_DIMENSIONS,
    VectorStoreError,
    keyOf,
    type RebuildOutcome,
    type StoredVectorKey,
    type UpsertOutcome,
    type VectorMatch,
    type VectorRecord,
    type VectorSearchQuery,
    type VectorStoreBackend,
} from './types';

/** The embedding table. Named here and nowhere else in `src/` (ESLint local/vector-store-single-seam). */
const TABLE = Prisma.raw('"KnowledgeChunkEmbedding"');
/** The chunk table, joined for a chunk's key only; its `text` is never read here. */
const CHUNKS = Prisma.raw('"KnowledgeChunk"');
/** The sequence behind `"writeSeq"` (a `BIGSERIAL`). */
const WRITE_SEQ = Prisma.raw(`'"KnowledgeChunkEmbedding_writeSeq_seq"'`);

/** Iterative index scans arrived in pgvector 0.8.0; without them a filtered search starves. */
export const MIN_PGVECTOR_VERSION: readonly [number, number, number] = [0, 8, 0];

function versionAtLeast(version: string, min: readonly [number, number, number]): boolean {
    const parts = version.split('.').map((p) => Number.parseInt(p, 10));
    for (let i = 0; i < 3; i++) {
        const v = Number.isFinite(parts[i]) ? parts[i] : 0;
        if (v !== min[i]) return v > min[i];
    }
    return true;
}

/** The (tenant, model) advisory-lock key pair; its two halves keep it apart from one-key locks. */
function lockKey(ctx: RequestContext, embeddingRevision: string): Prisma.Sql {
    return Prisma.sql`hashtext(${`knowledge-vector:${ctx.tenantId}`}), hashtext(${embeddingRevision})`;
}

function dimensionSql(dimensions: number): Prisma.Sql {
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS) {
        throw new VectorStoreError('INVALID_QUERY', 'dimension count out of range');
    }
    return Prisma.raw(String(dimensions));
}

/** pgvector's text input form, `[1,2,3]`. The numbers are validated finite upstream. */
function vectorLiteral(embedding: readonly number[]): string {
    return `[${embedding.join(',')}]`;
}

/**
 * The nearest-neighbour query, exported so the integration suite can read its
 * plan (`EXPLAIN` of exactly these bytes) and prove the partial HNSW index is
 * usable for it.
 *
 * SHAPED FOR THE INDEX. The inner query orders by the distance expression
 * alone, over the embedding table alone, with every filter evaluated inside
 * it: an HNSW index scan can only supply `ORDER BY <distance> LIMIT k`, and
 * the first draft (one join, ordered by distance and then the chunk key)
 * planned as a sequential scan and a full sort of the tenant's rows. The
 * chunk join that turns a hit into a reference, and the key tie-break, run on
 * the k rows the index returned. A `sourceModels` filter is a correlated
 * `EXISTS` inside the scan, which plans as a nested loop under the index scan,
 * so the iterative scan keeps reading until k rows pass it.
 */
export function buildSearchQuery(
    ctx: RequestContext,
    query: VectorSearchQuery,
    dimensions: number,
    path: 'index' | 'exact' = 'index',
): Prisma.Sql {
    const d = dimensionSql(dimensions);
    const q = vectorLiteral(query.embedding);
    // The index is built on `"embedding"::vector(<d>)`. The exact path orders by
    // the UNCAST column instead, an expression no index matches, so the planner
    // cannot choose the approximate scan whatever its cost estimates say. Every
    // row it compares is of this revision, which holds one dimension count
    // (`revisionDimensions`), so the uncast distance is well defined.
    const distance =
        path === 'exact'
            ? Prisma.sql`(e."embedding" <=> (${q}::vector(${d})))`
            : Prisma.sql`((e."embedding"::vector(${d})) <=> (${q}::vector(${d})))`;
    const models = query.sourceModels
        ? Prisma.sql`AND EXISTS (
              SELECT 1 FROM ${CHUNKS} m
              WHERE m."tenantId" = e."tenantId" AND m."id" = e."chunkId"
                AND m."sourceModel" = ANY(${[...query.sourceModels]}::text[]))`
        : Prisma.empty;
    return Prisma.sql`
        SELECT c."sourceModel", c."sourceId", c."chunkIndex", h."contentHash", 1 - h.distance AS score
        FROM (
            SELECT e."chunkId", e."contentHash", ${distance} AS distance
            FROM ${TABLE} e
            WHERE e."tenantId" = ${ctx.tenantId}
              AND e."embeddingModel" = ${query.embeddingRevision}
              ${models}
            ORDER BY ${distance}
            LIMIT ${query.k}
        ) h
        JOIN ${CHUNKS} c ON c."tenantId" = ${ctx.tenantId} AND c."id" = h."chunkId"
        ORDER BY h.distance, c."sourceModel", c."sourceId", c."chunkIndex"`;
}

/**
 * Past this many vectors of a revision, a tenant whose indexed search came back
 * short is NOT searched exactly: the index's answer stands and the shortfall is
 * logged. Bounds the fallback's cost by the tenant's own size, so one search
 * can never become a full read of a very large tenant.
 */
export const EXACT_FALLBACK_MAX_ROWS = 50_000;

type SearchRow = { sourceModel: string; sourceId: string; chunkIndex: number; contentHash: string; score: number };

/** A chunk's key, without the model. */
function chunkKeyOf(k: Pick<VectorRecord, 'sourceModel' | 'sourceId' | 'chunkIndex'>): string {
    return `${k.sourceModel}\u0000${k.sourceId}\u0000${k.chunkIndex}`;
}

function toMatches(rows: readonly SearchRow[]): VectorMatch[] {
    return rows.map((r) => ({
        sourceModel: r.sourceModel,
        sourceId: r.sourceId,
        chunkIndex: Number(r.chunkIndex),
        contentHash: r.contentHash,
        score: Number(r.score),
    }));
}

export function createPgvectorStore(): VectorStoreBackend {
    let installed = false;

    async function assertInstalled(tx: PrismaTx): Promise<void> {
        if (installed) return;
        const rows = await tx.$queryRaw<Array<{ ver: string | null; tbl: boolean }>>(Prisma.sql`
            SELECT
                (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS ver,
                to_regclass('public."KnowledgeChunkEmbedding"') IS NOT NULL AS tbl`);
        const probe = rows[0];
        if (!probe?.ver) {
            throw new VectorStoreError('PGVECTOR_NOT_INSTALLED', 'the vector extension is not installed in this database');
        }
        if (!versionAtLeast(probe.ver, MIN_PGVECTOR_VERSION)) {
            throw new VectorStoreError(
                'PGVECTOR_NOT_INSTALLED',
                `the vector extension is ${probe.ver}; filtered search needs ${MIN_PGVECTOR_VERSION.join('.')}+ (iterative index scans)`,
            );
        }
        if (!probe.tbl) {
            throw new VectorStoreError(
                'PGVECTOR_NOT_INSTALLED',
                'the embedding table does not exist; its migration has not run',
            );
        }
        installed = true;
    }

    function withTenant<T>(ctx: RequestContext, fn: (tx: PrismaTx) => Promise<T>): Promise<T> {
        return runInTenantContext(ctx, async (tx) => {
            await assertInstalled(tx);
            return fn(tx);
        });
    }

    /** The dimension count the tenant's rows of a model hold, or null when it has none. */
    async function revisionDimensions(
        tx: PrismaTx,
        ctx: RequestContext,
        embeddingRevision: string,
    ): Promise<number | null> {
        const rows = await tx.$queryRaw<Array<{ dimensions: number }>>(Prisma.sql`
            SELECT DISTINCT "dimensions" FROM ${TABLE}
            WHERE "tenantId" = ${ctx.tenantId} AND "embeddingModel" = ${embeddingRevision}
            LIMIT 2`);
        if (rows.length > 1) {
            throw new VectorStoreError(
                'REVISION_DIMENSION_MISMATCH',
                `revision ${embeddingRevision} holds vectors of more than one dimension count`,
            );
        }
        return rows.length === 0 ? null : Number(rows[0].dimensions);
    }

    async function writeBatch(
        tx: PrismaTx,
        ctx: RequestContext,
        records: readonly VectorRecord[],
        generation: string | null,
        outcome: UpsertOutcome,
    ): Promise<void> {
        if (records.length === 0) return;
        // The repository admits one revision and one dimension count per call.
        const { embeddingRevision, embedding } = records[0];
        // Shared with every other write; a rebuild's start takes it exclusively,
        // so no write's writeSeq can fall below a startSeq drawn while it is in flight.
        // `void` cannot be deserialised by $queryRaw, hence $executeRaw.
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock_shared(${lockKey(ctx, embeddingRevision)})`);
        const stored = await revisionDimensions(tx, ctx, embeddingRevision);
        if (stored !== null && stored !== embedding.length) {
            throw new VectorStoreError(
                'REVISION_DIMENSION_MISMATCH',
                `revision ${embeddingRevision} holds ${stored}-dimensional vectors`,
            );
        }

        // Each record's chunk, in this tenant, with the hash of the vector it
        // already has for this model (if any). Narrowed by source id and model
        // first; the exact key is matched in memory.
        const sourceIds = [...new Set(records.map((r) => r.sourceId))];
        const sourceModels = [...new Set(records.map((r) => r.sourceModel))];
        const chunks = await tx.$queryRaw<
            Array<{
                chunkId: string;
                sourceModel: string;
                sourceId: string;
                chunkIndex: number;
                chunkHash: string;
                prior: string | null;
            }>
        >(Prisma.sql`
            SELECT c."id" AS "chunkId", c."sourceModel", c."sourceId", c."chunkIndex",
                   c."contentHash" AS "chunkHash", e."contentHash" AS prior
            FROM ${CHUNKS} c
            LEFT JOIN ${TABLE} e
              ON e."tenantId" = c."tenantId" AND e."chunkId" = c."id" AND e."embeddingModel" = ${embeddingRevision}
            WHERE c."tenantId" = ${ctx.tenantId}
              AND c."sourceId" = ANY(${sourceIds}::text[])
              AND c."sourceModel" = ANY(${sourceModels}::text[])`);
        const byKey = new Map(chunks.map((c) => [chunkKeyOf({ ...c, chunkIndex: Number(c.chunkIndex) }), c]));
        const resolved = records.map((r) => {
            const chunk = byKey.get(chunkKeyOf(r));
            if (!chunk) {
                // Names the model and position only: ids are tenant data, but
                // neither is text and both are already in the caller's hands.
                throw new VectorStoreError(
                    'CHUNK_NOT_FOUND',
                    `no ${r.sourceModel} chunk ${r.chunkIndex} for that source in this tenant`,
                );
            }
            if (chunk.chunkHash !== r.contentHash) {
                // The chunk's text moved after this vector was computed: a
                // newer index run re-cut the source. Refused whole, before
                // anything is written, so no vector is ever filed against text
                // it was not computed from.
                throw new VectorStoreError(
                    'CONTENT_HASH_MISMATCH',
                    `${r.sourceModel} chunk ${r.chunkIndex} no longer holds the text this vector was computed from`,
                );
            }
            if (chunk.prior === null) outcome.inserted++;
            else if (chunk.prior === r.contentHash) outcome.unchanged++;
            else outcome.updated++;
            return { record: r, chunkId: chunk.chunkId };
        });

        const values = resolved.map(
            ({ record: r, chunkId }) => Prisma.sql`(
                ${randomUUID()}, ${ctx.tenantId}, ${chunkId}, ${r.embeddingRevision}, ${r.contentHash},
                ${r.embedding.length}, ${vectorLiteral(r.embedding)}::vector, ${generation}, now())`,
        );
        await tx.$executeRaw(Prisma.sql`
            INSERT INTO ${TABLE} (
                "id", "tenantId", "chunkId", "embeddingModel", "contentHash", "dimensions",
                "embedding", "rebuildGeneration", "updatedAt")
            VALUES ${Prisma.join(values)}
            ON CONFLICT ("tenantId", "chunkId", "embeddingModel")
            DO UPDATE SET
                "embedding" = CASE WHEN ${TABLE}."contentHash" = EXCLUDED."contentHash"
                                   THEN ${TABLE}."embedding" ELSE EXCLUDED."embedding" END,
                "dimensions" = EXCLUDED."dimensions",
                "contentHash" = EXCLUDED."contentHash",
                "rebuildGeneration" = COALESCE(EXCLUDED."rebuildGeneration", ${TABLE}."rebuildGeneration"),
                "writeSeq" = EXCLUDED."writeSeq",
                "updatedAt" = CASE WHEN ${TABLE}."contentHash" = EXCLUDED."contentHash"
                                   THEN ${TABLE}."updatedAt" ELSE now() END`);
    }

    return {
        kind: 'pgvector',

        async upsert(ctx, records) {
            const outcome: UpsertOutcome = { inserted: 0, updated: 0, unchanged: 0 };
            await withTenant(ctx, (tx) => writeBatch(tx, ctx, records, null, outcome));
            return outcome;
        },

        async search(ctx, query): Promise<VectorMatch[]> {
            return withTenant(ctx, async (tx) => {
                const stored = await revisionDimensions(tx, ctx, query.embeddingRevision);
                if (stored === null) return [];
                if (stored !== query.embedding.length) {
                    throw new VectorStoreError(
                        'DIMENSION_MISMATCH',
                        `revision ${query.embeddingRevision} holds ${stored}-dimensional vectors`,
                    );
                }
                const strategy = query.strategy ?? 'auto';
                const exact = () => tx.$queryRaw<SearchRow[]>(buildSearchQuery(ctx, query, stored, 'exact'));
                if (strategy === 'exact') return toMatches(await exact());

                // How many vectors of this revision the tenant holds, counted no
                // further than the fallback's ceiling (the btree answers it).
                const tenantRows =
                    strategy === 'auto'
                        ? Number(
                              (
                                  await tx.$queryRaw<Array<{ n: number | bigint }>>(Prisma.sql`
                                      SELECT count(*)::int AS n FROM (
                                          SELECT 1 FROM ${TABLE}
                                          WHERE "tenantId" = ${ctx.tenantId} AND "embeddingModel" = ${query.embeddingRevision}
                                          LIMIT ${EXACT_FALLBACK_MAX_ROWS + 1}) s`)
                              )[0]?.n ?? 0,
                          )
                        : null;
                if (tenantRows !== null && tenantRows <= EXACT_SCAN_MAX_ROWS) return toMatches(await exact());

                // Transaction-local: keep reading the shared index until k of
                // THIS tenant's rows survive the filter, within a bounded number
                // of tuples (see the header).
                await tx.$queryRaw(Prisma.sql`
                    SELECT set_config('hnsw.iterative_scan', ${HNSW_SEARCH.iterativeScan}, true),
                           set_config('hnsw.max_scan_tuples', ${String(HNSW_SEARCH.maxScanTuples)}, true),
                           set_config('hnsw.ef_search', ${String(Math.max(HNSW_SEARCH.efSearch, query.k))}, true)`);
                const indexed = await tx.$queryRaw<SearchRow[]>(buildSearchQuery(ctx, query, stored, 'index'));
                if (tenantRows === null || indexed.length >= query.k) return toMatches(indexed);
                if (tenantRows <= EXACT_FALLBACK_MAX_ROWS) return toMatches(await exact());
                logger.warn('vector_index.search_short', {
                    component: 'vector-index',
                    tenantId: ctx.tenantId,
                    k: query.k,
                    returned: indexed.length,
                });
                return toMatches(indexed);
            });
        },


        async listKeys(ctx, embeddingRevision, limit): Promise<StoredVectorKey[]> {
            return withTenant(ctx, async (tx) => {
                const rows = await tx.$queryRaw<
                    Array<{ sourceModel: string; sourceId: string; chunkIndex: number; contentHash: string; dimensions: number }>
                >(Prisma.sql`
                    SELECT c."sourceModel", c."sourceId", c."chunkIndex", e."contentHash", e."dimensions"
                    FROM ${TABLE} e
                    JOIN ${CHUNKS} c ON c."tenantId" = e."tenantId" AND c."id" = e."chunkId"
                    WHERE e."tenantId" = ${ctx.tenantId}
                      AND c."tenantId" = ${ctx.tenantId}
                      AND e."embeddingModel" = ${embeddingRevision}
                    ORDER BY c."sourceModel", c."sourceId", c."chunkIndex"
                    LIMIT ${limit}`);
                return rows.map((r) => ({
                    sourceModel: r.sourceModel,
                    sourceId: r.sourceId,
                    chunkIndex: Number(r.chunkIndex),
                    embeddingRevision,
                    contentHash: r.contentHash,
                    dimensions: Number(r.dimensions),
                }));
            });
        },

        async listSourceKeys(ctx, embeddingRevision, sourceModel, sourceId, limit): Promise<StoredVectorKey[]> {
            return withTenant(ctx, async (tx) => {
                const rows = await tx.$queryRaw<
                    Array<{ chunkIndex: number; contentHash: string; dimensions: number }>
                >(Prisma.sql`
                    SELECT c."chunkIndex", e."contentHash", e."dimensions"
                    FROM ${CHUNKS} c
                    JOIN ${TABLE} e ON e."tenantId" = c."tenantId" AND e."chunkId" = c."id"
                    WHERE c."tenantId" = ${ctx.tenantId}
                      AND e."tenantId" = ${ctx.tenantId}
                      AND c."sourceModel" = ${sourceModel} AND c."sourceId" = ${sourceId}
                      AND e."embeddingModel" = ${embeddingRevision}
                    ORDER BY c."chunkIndex"
                    LIMIT ${limit}`);
                return rows.map((r) => ({
                    sourceModel,
                    sourceId,
                    chunkIndex: Number(r.chunkIndex),
                    embeddingRevision,
                    contentHash: r.contentHash,
                    dimensions: Number(r.dimensions),
                }));
            });
        },

        async deleteSource(ctx, sourceModel, sourceId) {
            // The source's VECTORS, every model. Its chunks are the index
            // pipeline's to delete; deleting them takes the vectors with them.
            return withTenant(ctx, (tx) =>
                tx.$executeRaw(Prisma.sql`
                    DELETE FROM ${TABLE} e
                    USING ${CHUNKS} c
                    WHERE e."tenantId" = ${ctx.tenantId}
                      AND c."tenantId" = ${ctx.tenantId}
                      AND c."id" = e."chunkId"
                      AND c."sourceModel" = ${sourceModel} AND c."sourceId" = ${sourceId}`),
            );
        },

        async deleteTenant(ctx) {
            return withTenant(ctx, (tx) =>
                tx.$executeRaw(Prisma.sql`DELETE FROM ${TABLE} WHERE "tenantId" = ${ctx.tenantId}`),
            );
        },

        async rebuildRevision(ctx, embeddingRevision, batches): Promise<RebuildOutcome & { seen: number }> {
            // One transaction per batch, so a large tenant never holds one
            // long transaction. Rows are stamped with this rebuild's
            // generation; only after the LAST batch are the model's rows with
            // any other generation, written before this rebuild began,
            // deleted. A source that throws first leaves a superset, which the
            // query path's hydration under RLS already tolerates.
            const generation = randomUUID();
            // Drawn under the exclusive lock BEFORE the source is read: every
            // write committed earlier has writeSeq < startSeq, every later one
            // has more, and only the former can be judged by this source.
            const startSeq = await withTenant(ctx, async (tx) => {
                await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${lockKey(ctx, embeddingRevision)})`);
                const rows = await tx.$queryRaw<Array<{ seq: bigint | number | string }>>(
                    Prisma.sql`SELECT nextval(${WRITE_SEQ}::regclass) AS seq`,
                );
                return BigInt(rows[0].seq);
            });
            const outcome: RebuildOutcome = { inserted: 0, updated: 0, unchanged: 0, deleted: 0 };
            let seen = 0;
            for await (const batch of batches) {
                await withTenant(ctx, (tx) => writeBatch(tx, ctx, batch, generation, outcome));
                seen += batch.length;
            }
            outcome.deleted = await withTenant(ctx, (tx) =>
                tx.$executeRaw(Prisma.sql`
                    DELETE FROM ${TABLE}
                    WHERE "tenantId" = ${ctx.tenantId}
                      AND "embeddingModel" = ${embeddingRevision}
                      AND "rebuildGeneration" IS DISTINCT FROM ${generation}
                      AND "writeSeq" < ${startSeq}`),
            );
            return { ...outcome, seen };
        },
    };
}
