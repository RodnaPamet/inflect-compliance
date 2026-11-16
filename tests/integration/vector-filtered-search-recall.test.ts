/**
 * A SMALL TENANT BESIDE A LARGE ONE STILL GETS k RESULTS (vector store Phase
 * 3.2, `docs/ai-architecture/weaviate.md`), against the real tables, the real
 * partial HNSW index and RLS live.
 *
 * The failure this exists for is one no two-tenant test of equal-sized tenants
 * can see. The HNSW index is shared by every tenant holding the model, and
 * pgvector filters the tenant AFTER the approximate scan: with iterative scans
 * off it returns `ef_search` (40) candidates across the whole table and then
 * drops the other tenants' rows, so a tenant holding 1% of them gets about
 * nothing. Case 0 shows that happening here, so the cases after it are known
 * to be able to fail.
 *
 *   L  "large": 2,400 vectors, above `EXACT_SCAN_MAX_ROWS`
 *   S  "small": 24 vectors, below it
 *
 * Vectors are pseudo-random (seeded), so the two tenants' rows are interleaved
 * through the whole space and no query is close to one tenant only.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createHash, randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import {
    createVectorRepository,
    EXACT_SCAN_MAX_ROWS,
    HNSW_SEARCH,
    MAX_UPSERT_BATCH,
    type VectorRecord,
} from '@/app-layer/repositories/VectorRepository';
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
jest.setTimeout(300_000);

const SUITE = `vfs-${randomUUID().slice(0, 8)}`;
const L = `tl-${SUITE}`;
const S = `ts-${SUITE}`;
const TENANTS = [L, S];
/** The model the migration's partial HNSW index names, so the index really serves these searches. */
const MODEL = 'intfloat/multilingual-e5-small';
const DIMS = 384;
const LARGE = 2_400;
const SMALL = 24;
const K = 10;

const ctxL = makeRequestContext('ADMIN', { tenantId: L, tenantSlug: L, userId: `${L}-user` });
const ctxS = makeRequestContext('ADMIN', { tenantId: S, tenantSlug: S, userId: `${S}-user` });
const repo = createVectorRepository(createPgvectorStore());

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** mulberry32: a small seeded PRNG, so the space is the same on every run. */
function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = prng(20261116);
const vector = (): number[] => Array.from({ length: DIMS }, () => rand() * 2 - 1);

async function seed(ctx: typeof ctxL, tenantId: string, count: number): Promise<void> {
    const texts = Array.from({ length: count }, (_, i) => `${tenantId} chunk ${i}`);
    await runInTenantContext(ctx, (tx) =>
        tx.knowledgeChunk.createMany({
            data: texts.map((text, chunkIndex) => ({
                tenantId,
                sourceModel: 'PolicyVersion',
                sourceId: `pv-${tenantId}`,
                chunkIndex,
                text,
                contentHash: sha(text),
                chunkerRevision: 'paragraph@1',
            })),
        }),
    );
    const records: VectorRecord[] = texts.map((text, chunkIndex) => ({
        sourceModel: 'PolicyVersion',
        sourceId: `pv-${tenantId}`,
        chunkIndex,
        embeddingRevision: MODEL,
        contentHash: sha(text),
        embedding: vector(),
    }));
    for (let i = 0; i < records.length; i += MAX_UPSERT_BATCH) await repo.upsert(ctx, records.slice(i, i + MAX_UPSERT_BATCH));
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

const QUERIES = Array.from({ length: 5 }, () => vector());

describeFn('a filtered search over the shared index keeps a small tenant’s recall (pgvector, RLS live)', () => {
    beforeAll(async () => {
        expect(LARGE).toBeGreaterThan(EXACT_SCAN_MAX_ROWS);
        expect(SMALL).toBeLessThanOrEqual(EXACT_SCAN_MAX_ROWS);
        await prisma.$connect();
        await cleanup();
        for (const t of TENANTS) await createTenantWithDek({ id: t, name: t, slug: t });
        await seed(ctxL, L, LARGE);
        await seed(ctxS, S, SMALL);
        // Fresh statistics, so the planner sees the table as it is.
        await prisma.$executeRawUnsafe('ANALYZE "KnowledgeChunkEmbedding"');
    });

    afterAll(async () => {
        await cleanup();
        await appPrisma.$disconnect();
        await prisma.$disconnect();
    });

    /**
     * The store's indexed query, run with the index FORCED (sequential scans
     * and explicit sorts off for the transaction), so the HNSW scan is what
     * answers — never the btree-and-sort a 24-row tenant would rightly get
     * from the planner — and with iterative scans set as `mode` says. Returns
     * the rows and the plan, so each case can show which scan it measured.
     */
    async function forcedIndexSearch(
        mode: 'off' | 'relaxed_order',
        q: number[],
    ): Promise<{ rows: Array<{ sourceId: string; score: number }>; plan: string }> {
        return runInTenantContext(ctxS, async (tx) => {
            await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
            await tx.$executeRaw`SET LOCAL enable_sort = off`;
            await tx.$executeRaw`SELECT set_config('hnsw.iterative_scan', ${mode}, true), set_config('hnsw.max_scan_tuples', ${String(HNSW_SEARCH.maxScanTuples)}, true)`;
            const sql = buildSearchQuery(ctxS, { embeddingRevision: MODEL, embedding: q, k: K }, DIMS, 'index');
            const plan = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(Prisma.sql`EXPLAIN ${sql}`);
            const rows = await tx.$queryRaw<Array<{ sourceId: string; score: number }>>(sql);
            return { rows, plan: plan.map((r) => r['QUERY PLAN']).join('\n') };
        });
    }

    it('0. the failure is real here: without iterative scans the index starves the small tenant', async () => {
        let returned = 0;
        for (const q of QUERIES) {
            const { rows, plan } = await forcedIndexSearch('off', q);
            expect(plan).toContain('KnowledgeChunkEmbedding_hnsw_multilingual_e5_small_idx');
            returned += rows.length;
        }
        // About 40 × 24 / 2,424 ≈ 0.4 rows a query; anything near k would mean
        // this case cannot tell the fix from its absence.
        expect(returned).toBeLessThan((QUERIES.length * K) / 2);
    });

    it('1. the small tenant gets k results on the default path (exact below the threshold), equal to exact search', async () => {
        for (const q of QUERIES) {
            const auto = await repo.search(ctxS, { embeddingRevision: MODEL, embedding: q, k: K });
            const exact = await repo.search(ctxS, { embeddingRevision: MODEL, embedding: q, k: K, strategy: 'exact' });
            expect(auto).toHaveLength(K);
            expect(auto).toEqual(exact);
            expect(auto.every((h) => h.sourceId === `pv-${S}`)).toBe(true);
        }
    });

    it('2. the small tenant gets k results through the INDEX too: the relaxed iterative scan reads past the other tenant', async () => {
        for (const q of QUERIES) {
            const { rows, plan } = await forcedIndexSearch(HNSW_SEARCH.iterativeScan, q);
            expect(plan).toContain('KnowledgeChunkEmbedding_hnsw_multilingual_e5_small_idx');
            expect(rows).toHaveLength(K);
            expect(rows.every((h) => h.sourceId === `pv-${S}`)).toBe(true);
            // Sorted by similarity, whatever order the relaxed scan produced them in.
            const scores = rows.map((h) => Number(h.score));
            expect(scores).toEqual([...scores].sort((a, b) => b - a));
        }
        // And through the repository, pinned to the index path: k rows, the tenant's own.
        const hits = await repo.search(ctxS, { embeddingRevision: MODEL, embedding: QUERIES[0], k: K, strategy: 'index' });
        expect([hits.length, hits.every((h) => h.sourceId === `pv-${S}`)]).toEqual([K, true]);
    });

    it('3. the large tenant is searched through the index and gets k results of its own', async () => {
        for (const q of QUERIES) {
            const hits = await repo.search(ctxL, { embeddingRevision: MODEL, embedding: q, k: K });
            expect(hits).toHaveLength(K);
            expect(hits.every((h) => h.sourceId === `pv-${L}`)).toBe(true);
        }
    });

    it('4. the exact path cannot use the HNSW index; the index path can', async () => {
        const explain = (path: 'index' | 'exact') =>
            runInTenantContext(ctxL, async (tx) => {
                // Make the index as attractive as possible: if the exact query
                // could be served by it, this is when the planner would.
                await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
                await tx.$executeRaw`SET LOCAL enable_sort = off`;
                const rows = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(
                    Prisma.sql`EXPLAIN ${buildSearchQuery(ctxL, { embeddingRevision: MODEL, embedding: QUERIES[0], k: K }, DIMS, path)}`,
                );
                return rows.map((r) => r['QUERY PLAN']).join('\n');
            });
        expect(await explain('index')).toContain('KnowledgeChunkEmbedding_hnsw_multilingual_e5_small_idx');
        expect(await explain('exact')).not.toContain('hnsw');
    });
});
