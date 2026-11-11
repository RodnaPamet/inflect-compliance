/**
 * The pgvector backend: vectors in a Postgres table, inside RLS.
 *
 * ── It is not reachable today, on purpose ───────────────────────────
 *
 * Every Postgres this repository runs — CI's service containers, the dev and
 * staging Compose files and production (`deploy/docker-compose.prod.yml`) — is
 * the official `postgres:16-alpine`, which does not ship the `vector`
 * extension. A migration running `CREATE EXTENSION vector` would fail on every
 * one of them. So no migration creates the table this file reads, and
 * `getVectorRepository()` constructs this backend only when the operator sets
 * `VECTOR_STORE_BACKEND=pgvector` — which is to be done only after the image
 * change and the follow-up migration in
 * `docs/implementation-notes/2026-11-11-vector-store-seam.md`.
 *
 * Even then it fails closed: before its first statement it probes for the
 * extension AND the table, and refuses `PGVECTOR_NOT_INSTALLED` when either is
 * missing. A positive probe is remembered for the process; a negative one is
 * asked again next call, so installing the extension needs no restart.
 *
 * ── Isolation ───────────────────────────────────────────────────────
 *
 * Every statement runs inside `runInTenantContext(ctx, …)`, so it executes as
 * `app_user` with the tenant GUC bound and the table's `tenant_isolation`
 * policy applies; and every statement ALSO names `"tenantId" = ctx.tenantId`
 * (the application-layer filter, defence in depth). The tenant id comes from
 * `ctx` and from nowhere else.
 *
 * ── SQL shape ───────────────────────────────────────────────────────
 *
 * Tagged `Prisma.sql` only — every value is a bind parameter. The two things
 * that are not are the table name (a constant) and a vector's dimension count,
 * which is interpolated with `Prisma.raw` because a type modifier cannot be a
 * parameter; it is an integer the repository has already bounded to
 * `1..MAX_DIMENSIONS`, and `dimensionSql` re-checks it before it is spliced.
 *
 * The `embedding` column is the untyped `vector`, so one table holds every
 * revision; a search casts to `vector(<dimensions>)`, which is the expression
 * the follow-up migration's partial HNSW index per revision is built on.
 */

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import type { PrismaTx } from '@/lib/db-context';
import {
    MAX_DIMENSIONS,
    VectorStoreError,
    keyOf,
    type RebuildOutcome,
    type StoredVectorKey,
    type UpsertOutcome,
    type VectorMatch,
    type VectorRecord,
    type VectorStoreBackend,
} from './types';

/** The table the follow-up migration creates. Named here and nowhere else in `src/`. */
const TABLE = Prisma.raw('"KnowledgeVector"');

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

export function createPgvectorStore(): VectorStoreBackend {
    let installed = false;

    async function assertInstalled(tx: PrismaTx): Promise<void> {
        if (installed) return;
        const rows = await tx.$queryRaw<Array<{ ext: boolean; tbl: boolean }>>(Prisma.sql`
            SELECT
                EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ext,
                to_regclass('public."KnowledgeVector"') IS NOT NULL AS tbl`);
        const probe = rows[0];
        if (!probe?.ext || !probe?.tbl) {
            throw new VectorStoreError(
                'PGVECTOR_NOT_INSTALLED',
                !probe?.ext
                    ? 'the vector extension is not installed in this database'
                    : 'the KnowledgeVector table does not exist; its migration has not run',
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

    /** The dimension count the tenant's rows of a revision hold, or null when it has none. */
    async function revisionDimensions(
        tx: PrismaTx,
        ctx: RequestContext,
        embeddingRevision: string,
    ): Promise<number | null> {
        const rows = await tx.$queryRaw<Array<{ dimensions: number }>>(Prisma.sql`
            SELECT DISTINCT "dimensions" FROM ${TABLE}
            WHERE "tenantId" = ${ctx.tenantId} AND "embeddingRevision" = ${embeddingRevision}
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
        const stored = await revisionDimensions(tx, ctx, embeddingRevision);
        if (stored !== null && stored !== embedding.length) {
            throw new VectorStoreError(
                'REVISION_DIMENSION_MISMATCH',
                `revision ${embeddingRevision} holds ${stored}-dimensional vectors`,
            );
        }

        const sourceIds = [...new Set(records.map((r) => r.sourceId))];
        const existing = await tx.$queryRaw<
            Array<{ sourceModel: string; sourceId: string; chunkIndex: number; embeddingRevision: string; contentHash: string }>
        >(Prisma.sql`
            SELECT "sourceModel", "sourceId", "chunkIndex", "embeddingRevision", "contentHash"
            FROM ${TABLE}
            WHERE "tenantId" = ${ctx.tenantId}
              AND "embeddingRevision" = ${embeddingRevision}
              AND "sourceId" = ANY(${sourceIds}::text[])`);
        const hashes = new Map(existing.map((e) => [keyOf({ ...e, chunkIndex: Number(e.chunkIndex) }), e.contentHash]));
        for (const r of records) {
            const prior = hashes.get(keyOf(r));
            if (prior === undefined) outcome.inserted++;
            else if (prior === r.contentHash) outcome.unchanged++;
            else outcome.updated++;
        }

        const values = records.map(
            (r) => Prisma.sql`(
                ${randomUUID()}, ${ctx.tenantId}, ${r.sourceModel}, ${r.sourceId}, ${r.chunkIndex},
                ${r.embeddingRevision}, ${r.contentHash}, ${r.embedding.length},
                ${vectorLiteral(r.embedding)}::vector, ${generation}, now())`,
        );
        await tx.$executeRaw(Prisma.sql`
            INSERT INTO ${TABLE} (
                "id", "tenantId", "sourceModel", "sourceId", "chunkIndex",
                "embeddingRevision", "contentHash", "dimensions",
                "embedding", "rebuildGeneration", "updatedAt")
            VALUES ${Prisma.join(values)}
            ON CONFLICT ("tenantId", "embeddingRevision", "sourceModel", "sourceId", "chunkIndex")
            DO UPDATE SET
                "embedding" = CASE WHEN ${TABLE}."contentHash" = EXCLUDED."contentHash"
                                   THEN ${TABLE}."embedding" ELSE EXCLUDED."embedding" END,
                "dimensions" = EXCLUDED."dimensions",
                "contentHash" = EXCLUDED."contentHash",
                "rebuildGeneration" = EXCLUDED."rebuildGeneration",
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
                const d = dimensionSql(stored);
                const q = vectorLiteral(query.embedding);
                const models = query.sourceModels
                    ? Prisma.sql`AND "sourceModel" = ANY(${[...query.sourceModels]}::text[])`
                    : Prisma.empty;
                const rows = await tx.$queryRaw<
                    Array<{ sourceModel: string; sourceId: string; chunkIndex: number; contentHash: string; score: number }>
                >(Prisma.sql`
                    SELECT "sourceModel", "sourceId", "chunkIndex", "contentHash",
                           1 - (("embedding"::vector(${d})) <=> (${q}::vector(${d}))) AS score
                    FROM ${TABLE}
                    WHERE "tenantId" = ${ctx.tenantId}
                      AND "embeddingRevision" = ${query.embeddingRevision}
                      ${models}
                    ORDER BY ("embedding"::vector(${d})) <=> (${q}::vector(${d})),
                             "sourceModel", "sourceId", "chunkIndex"
                    LIMIT ${query.k}`);
                return rows.map((r) => ({
                    sourceModel: r.sourceModel,
                    sourceId: r.sourceId,
                    chunkIndex: Number(r.chunkIndex),
                    contentHash: r.contentHash,
                    score: Number(r.score),
                }));
            });
        },

        async listKeys(ctx, embeddingRevision, limit): Promise<StoredVectorKey[]> {
            return withTenant(ctx, async (tx) => {
                const rows = await tx.$queryRaw<
                    Array<{ sourceModel: string; sourceId: string; chunkIndex: number; contentHash: string; dimensions: number }>
                >(Prisma.sql`
                    SELECT "sourceModel", "sourceId", "chunkIndex", "contentHash", "dimensions"
                    FROM ${TABLE}
                    WHERE "tenantId" = ${ctx.tenantId} AND "embeddingRevision" = ${embeddingRevision}
                    ORDER BY "sourceModel", "sourceId", "chunkIndex"
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

        async deleteSource(ctx, sourceModel, sourceId) {
            return withTenant(ctx, (tx) =>
                tx.$executeRaw(Prisma.sql`
                    DELETE FROM ${TABLE}
                    WHERE "tenantId" = ${ctx.tenantId}
                      AND "sourceModel" = ${sourceModel} AND "sourceId" = ${sourceId}`),
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
            // generation; only after the LAST batch are the revision's rows
            // with any other generation deleted. A source that throws first
            // leaves a superset, which the query path's hydration under RLS
            // already tolerates (a stale reference hydrates to nothing).
            const generation = randomUUID();
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
                      AND "embeddingRevision" = ${embeddingRevision}
                      AND "rebuildGeneration" IS DISTINCT FROM ${generation}`),
            );
            return { ...outcome, seen };
        },
    };
}
