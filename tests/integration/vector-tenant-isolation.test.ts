/**
 * The vector store keeps two tenants apart in a real Postgres with pgvector
 * loaded and RLS live (vector store Phase 1.7, the new-subsystem checklist's
 * two-tenant behavioural test).
 *
 * Every write and read goes through the seam callers use
 * (`createVectorRepository(createPgvectorStore())`), which runs each statement
 * as `app_user` inside `runInTenantContext`. Chunks are written the way the
 * index pipeline will write them: through the app's Prisma client in the
 * tenant's context, so `text` passes the encryption extension.
 *
 *   1. A inserts chunks and embeddings; B's nearest-neighbour query returns
 *      nothing, and A's returns A's rows.
 *   2. B asking for A's chunk id returns nothing — the chunk, its embeddings,
 *      a write naming A's source, a delete of A's source.
 *   3. The composite foreign key refuses an embedding pointing at another
 *      tenant's chunk even for a superuser, and RLS refuses one filed under
 *      another tenant.
 *   4. The text is ciphertext at rest; the embedding row has no text column.
 *   5. The migration's partial HNSW index exists, the backend's own search
 *      query is planned through it, and a wrong-sized vector cannot enter it.
 *   6. Purging tenant A leaves no row of either table, and B's are untouched.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createHash, randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { createVectorRepository, type VectorRecord } from '@/app-layer/repositories/VectorRepository';
// Constructed directly, as getVectorRepository() would with VECTOR_STORE_BACKEND=pgvector;
// the ESLint seam rule governs src/, not the suite that proves the seam.
import { buildSearchQuery, createPgvectorStore } from '@/app-layer/repositories/vector/pgvector-store';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { purgeSoftDeletedTenants } from '@/app-layer/usecases/tenant-purge';
import { prisma as appPrisma } from '@/lib/prisma';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `vec-${randomUUID().slice(0, 8)}`;
const A = `ta-${SUITE}`;
const B = `tb-${SUITE}`;
const TENANTS = [A, B];
/** D-L4-3's model, which the migration's HNSW index names, at its 384 dimensions. */
const MODEL = 'intfloat/multilingual-e5-small';
const DIMS = 384;

const ctxA = makeRequestContext('ADMIN', { tenantId: A, tenantSlug: A, userId: `${A}-user` });
const ctxB = makeRequestContext('ADMIN', { tenantId: B, tenantSlug: B, userId: `${B}-user` });
const repo = createVectorRepository(createPgvectorStore());

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** A 384-dimensional vector pointing mostly along `axis`. */
function along(axis: number, tilt = 0): number[] {
    const v = new Array<number>(DIMS).fill(0);
    v[axis] = 1;
    v[(axis + 1) % DIMS] = tilt;
    return v;
}

const TEXTS: Record<string, string[]> = {
    [A]: ['Tenant A: access reviews run quarterly.', 'Tenant A: backups are tested monthly.'],
    [B]: ['Tenant B: suppliers are assessed yearly.'],
};

/** Writes a policy version's chunks the way the index pipeline will, in the tenant's context. */
async function writeChunks(tenantId: string, sourceId: string): Promise<string[]> {
    const ctx = tenantId === A ? ctxA : ctxB;
    return runInTenantContext(ctx, async (tx) => {
        const ids: string[] = [];
        for (const [chunkIndex, text] of TEXTS[tenantId].entries()) {
            const row = await tx.knowledgeChunk.create({
                data: {
                    tenantId,
                    sourceModel: 'PolicyVersion',
                    sourceId,
                    chunkIndex,
                    text,
                    contentHash: sha(text),
                    chunkerRevision: 'paragraph@1',
                },
            });
            ids.push(row.id);
        }
        return ids;
    });
}

function records(tenantId: string, sourceId: string, axis: number): VectorRecord[] {
    return TEXTS[tenantId].map((text, chunkIndex) => ({
        sourceModel: 'PolicyVersion',
        sourceId,
        chunkIndex,
        embeddingRevision: MODEL,
        contentHash: sha(text),
        embedding: along(axis, chunkIndex * 0.1),
    }));
}

async function rowCounts(tenantId: string): Promise<{ chunks: number; embeddings: number }> {
    const [c] = await prisma.$queryRaw<Array<{ chunks: bigint; embeddings: bigint }>>`
        SELECT (SELECT count(*) FROM "KnowledgeChunk" WHERE "tenantId" = ${tenantId}) AS chunks,
               (SELECT count(*) FROM "KnowledgeChunkEmbedding" WHERE "tenantId" = ${tenantId}) AS embeddings`;
    return { chunks: Number(c.chunks), embeddings: Number(c.embeddings) };
}

async function cleanup(): Promise<void> {
    const existing = await prisma.tenant.findMany({ where: { id: { in: TENANTS } }, select: { id: true } });
    for (const { id } of existing) {
        await prisma.tenant.update({ where: { id }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
        await purgeSoftDeletedTenants({ tenantId: id });
    }
    await deleteAuditRowsForTenants(prisma, TENANTS).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

describeFn('the vector store keeps two tenants apart (pgvector, RLS live)', () => {
    let chunksOfA: string[] = [];

    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        for (const t of TENANTS) await createTenantWithDek({ id: t, name: t, slug: t });
        chunksOfA = await writeChunks(A, 'pv-a');
        await writeChunks(B, 'pv-b');
        await repo.upsert(ctxA, records(A, 'pv-a', 0));
        await repo.upsert(ctxB, records(B, 'pv-b', 7));
    });

    afterAll(async () => {
        await cleanup();
        await appPrisma.$disconnect();
        await prisma.$disconnect();
    });

    it('the fixture is what it claims: the extension is loaded and both tenants hold rows', async () => {
        const [ext] = await prisma.$queryRaw<Array<{ v: string }>>`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`;
        expect(ext?.v).toMatch(/^0\.(8|9|\d{2,})\./);
        expect(await rowCounts(A)).toEqual({ chunks: 2, embeddings: 2 });
        expect(await rowCounts(B)).toEqual({ chunks: 1, embeddings: 1 });
    });

    describe('1. A nearest-neighbour query sees only the caller’s tenant', () => {
        it('A finds its own chunks, nearest first, with references and no text', async () => {
            const hits = await repo.search(ctxA, { embeddingRevision: MODEL, embedding: along(0), k: 10 });
            expect(hits.map((h) => [h.sourceId, h.chunkIndex])).toEqual([['pv-a', 0], ['pv-a', 1]]);
            expect(hits[0].score).toBeCloseTo(1, 5);
            for (const h of hits) expect(Object.keys(h).sort()).toEqual(['chunkIndex', 'contentHash', 'score', 'sourceId', 'sourceModel']);
        });

        it('B, asking with A’s exact vector, gets only its own chunk', async () => {
            const hits = await repo.search(ctxB, { embeddingRevision: MODEL, embedding: along(0), k: 10 });
            expect(hits.map((h) => h.sourceId)).toEqual(['pv-b']);
        });

        it('a tenant with no vectors gets nothing at all', async () => {
            const C = makeRequestContext('ADMIN', { tenantId: `tc-${SUITE}`, userId: 'nobody' });
            await expect(repo.search(C, { embeddingRevision: MODEL, embedding: along(0), k: 10 })).resolves.toEqual([]);
        });

        it('B’s key listing names only B’s chunk', async () => {
            const keys = await repo.listKeys(ctxB, MODEL);
            expect(keys.map((k) => k.sourceId)).toEqual(['pv-b']);
        });
    });

    describe('2. B asking for A’s chunk id gets nothing', () => {
        it('neither the chunk nor its embeddings read under B', async () => {
            const seen = await runInTenantContext(ctxB, async (tx) => ({
                chunk: await tx.knowledgeChunk.findUnique({ where: { id: chunksOfA[0] } }),
                embeddings: await tx.$queryRaw<Array<{ n: bigint }>>`
                    SELECT count(*) AS n FROM "KnowledgeChunkEmbedding" WHERE "chunkId" = ${chunksOfA[0]}`,
            }));
            expect(seen.chunk).toBeNull();
            expect(Number(seen.embeddings[0].n)).toBe(0);
        });

        it('a write under B naming A’s source is refused CHUNK_NOT_FOUND', async () => {
            await expect(repo.upsert(ctxB, records(A, 'pv-a', 3))).rejects.toMatchObject({ reason: 'CHUNK_NOT_FOUND' });
            expect(await rowCounts(A)).toEqual({ chunks: 2, embeddings: 2 });
        });

        it('a delete under B naming A’s source deletes nothing', async () => {
            await expect(repo.deleteSource(ctxB, 'PolicyVersion', 'pv-a')).resolves.toBe(0);
            expect(await rowCounts(A)).toEqual({ chunks: 2, embeddings: 2 });
        });
    });

    describe('3. An embedding can never point across tenants', () => {
        it('the composite foreign key refuses B’s row on A’s chunk, even for a superuser', async () => {
            // Another model, so the e5 index's 384-dimension cast is not what refuses it.
            await expect(prisma.$executeRaw`
                INSERT INTO "KnowledgeChunkEmbedding"
                    ("id", "tenantId", "chunkId", "embeddingModel", "dimensions", "contentHash", "embedding", "updatedAt")
                VALUES (${randomUUID()}, ${B}, ${chunksOfA[0]}, 'another-model', 3, ${sha('x')}, '[1,0,0]'::vector, now())`,
            ).rejects.toThrow(/foreign key/i);
        });

        it('a vector of the wrong size cannot enter the e5 model’s index', async () => {
            // A chunk with no e5 vector yet, so the unique key is not what refuses it.
            const spare = await runInTenantContext(ctxA, (tx) =>
                tx.knowledgeChunk.create({
                    data: { tenantId: A, sourceModel: 'PolicyVersion', sourceId: 'pv-spare', chunkIndex: 0, text: 'spare', contentHash: sha('spare'), chunkerRevision: 'paragraph@1' },
                }),
            );
            try {
                await expect(prisma.$executeRaw`
                    INSERT INTO "KnowledgeChunkEmbedding"
                        ("id", "tenantId", "chunkId", "embeddingModel", "dimensions", "contentHash", "embedding", "updatedAt")
                    VALUES (${randomUUID()}, ${A}, ${spare.id}, ${MODEL}, 3, ${sha('x')}, '[1,0,0]'::vector, now())`,
                ).rejects.toThrow(/expected 384 dimensions/);
            } finally {
                await prisma.$executeRaw`DELETE FROM "KnowledgeChunk" WHERE "id" = ${spare.id}`;
            }
        });

        it('RLS refuses a row filed under A while bound to B', async () => {
            await expect(
                runInTenantContext(ctxB, (tx) => tx.$executeRaw`
                    INSERT INTO "KnowledgeChunkEmbedding"
                        ("id", "tenantId", "chunkId", "embeddingModel", "dimensions", "contentHash", "embedding", "updatedAt")
                    VALUES (${randomUUID()}, ${A}, ${chunksOfA[0]}, ${MODEL}, 3, ${sha('x')}, '[1,0,0]'::vector, now())`),
            ).rejects.toThrow(/row-level security/i);
        });

        it('a dimension count that disagrees with the vector is refused by the CHECK', async () => {
            await expect(prisma.$executeRaw`
                INSERT INTO "KnowledgeChunkEmbedding"
                    ("id", "tenantId", "chunkId", "embeddingModel", "dimensions", "contentHash", "embedding", "updatedAt")
                VALUES (${randomUUID()}, ${A}, ${chunksOfA[0]}, 'another-model', 4, ${sha('x')}, '[1,0,0]'::vector, now())`,
            ).rejects.toThrow(/KnowledgeChunkEmbedding_dims_match/);
        });
    });

    describe('4. Vectors only: the text is ciphertext, and only in KnowledgeChunk', () => {
        it('KnowledgeChunk.text is not stored as plaintext', async () => {
            const rows = await prisma.$queryRaw<Array<{ text: string }>>`
                SELECT "text" FROM "KnowledgeChunk" WHERE "tenantId" = ${A}`;
            expect(rows).toHaveLength(2);
            for (const r of rows) {
                expect(TEXTS[A]).not.toContain(r.text);
                expect(r.text).toMatch(/^v[12]:/);
            }
        });

        it('reads back as plaintext through the app client, in the tenant’s context', async () => {
            const texts = await runInTenantContext(ctxA, (tx) =>
                tx.knowledgeChunk.findMany({ where: { tenantId: A }, orderBy: { chunkIndex: 'asc' }, select: { text: true }, take: 10 }),
            );
            expect(texts.map((t) => t.text)).toEqual(TEXTS[A]);
        });

        it('the embedding table has no text column at all', async () => {
            const cols = await prisma.$queryRaw<Array<{ column_name: string; data_type: string }>>`
                SELECT column_name, data_type FROM information_schema.columns
                WHERE table_name = 'KnowledgeChunkEmbedding' AND column_name NOT IN ('id', 'tenantId', 'chunkId', 'embeddingModel', 'contentHash', 'rebuildGeneration')`;
            expect(cols.filter((c) => c.data_type === 'text')).toEqual([]);
        });
    });

    describe('5. The model’s partial HNSW index exists and the search is planned through it', () => {
        it('is the expression and predicate the backend queries by', async () => {
            const [ix] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
                SELECT indexdef FROM pg_indexes WHERE indexname = 'KnowledgeChunkEmbedding_hnsw_multilingual_e5_small_idx'`;
            expect(ix?.indexdef).toContain('USING hnsw (((embedding)::vector(384)) vector_cosine_ops)');
            expect(ix?.indexdef).toContain(`WHERE ("embeddingModel" = '${MODEL}'::text)`);
        });

        it.each([
            ['every source model', undefined],
            ['a sourceModels filter', ['PolicyVersion']],
        ])('the backend’s own search query, with %s, is planned through it', async (_label, sourceModels) => {
            // EXPLAIN of exactly the bytes the backend sends, model as a bind
            // parameter. Sequential scans are switched off for this transaction
            // only, because on a handful of rows the planner rightly prefers
            // one: the question is whether the index CAN serve the query, which
            // the first draft of the query (a join ordered by distance and key)
            // failed — it planned as a scan and a full sort whatever the size.
            // Explicit sorts are switched off too: once the table has been
            // ANALYZEd (autovacuum, after an earlier suite in the same database
            // wrote and deleted rows) the planner rightly prefers the
            // (tenantId, embeddingModel) btree and a sort of a handful of rows,
            // which says nothing about whether HNSW can serve the ORDER BY.
            const query = { embeddingRevision: MODEL, embedding: along(0), k: 10, sourceModels };
            const plan = await runInTenantContext(ctxA, async (tx) => {
                await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
                await tx.$executeRaw`SET LOCAL enable_sort = off`;
                await tx.$executeRaw`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`;
                return tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(
                    Prisma.sql`EXPLAIN ${buildSearchQuery(ctxA, query, DIMS)}`,
                );
            });
            expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain(
                'Index Scan using "KnowledgeChunkEmbedding_hnsw_multilingual_e5_small_idx"',
            );
        });

        it('the search through it with a sourceModels filter still returns A’s rows', async () => {
            const hits = await repo.search(ctxA, { embeddingRevision: MODEL, embedding: along(0), k: 10, sourceModels: ['PolicyVersion'] });
            expect(hits.map((h) => h.chunkIndex)).toEqual([0, 1]);
            await expect(
                repo.search(ctxA, { embeddingRevision: MODEL, embedding: along(0), k: 10, sourceModels: ['Control'] }),
            ).resolves.toEqual([]);
        });
    });

    describe('6. Rebuild and purge', () => {
        it('a rebuild of A makes A’s rows exactly what the source yields, and leaves B alone', async () => {
            const [first] = records(A, 'pv-a', 0);
            const outcome = await repo.rebuildRevision(ctxA, MODEL, [[first]]);
            expect(outcome).toMatchObject({ unchanged: 1, deleted: 1, seen: 1 });
            expect(await rowCounts(A)).toEqual({ chunks: 2, embeddings: 1 });
            expect(await rowCounts(B)).toEqual({ chunks: 1, embeddings: 1 });
            await repo.upsert(ctxA, records(A, 'pv-a', 0));
        });

        it('purging tenant A leaves no row of either table, and B’s untouched', async () => {
            expect(await rowCounts(A)).toEqual({ chunks: 2, embeddings: 2 });
            await prisma.tenant.update({ where: { id: A }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
            const [result] = await purgeSoftDeletedTenants({ tenantId: A });
            expect(await rowCounts(A)).toEqual({ chunks: 0, embeddings: 0 });
            expect(await rowCounts(B)).toEqual({ chunks: 1, embeddings: 1 });
            expect(result.deleted.KnowledgeChunk).toBe(2);
        });
    });
});
