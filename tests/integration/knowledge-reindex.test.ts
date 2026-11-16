/**
 * The knowledge index is rebuildable from Postgres (vector store Phase 2.3).
 *
 * A tenant's approved policy is indexed by the job with the deterministic stub
 * embedder, and the stored vectors are read back as text. Then the tenant's
 * vectors are deleted outright — the store lost — and
 * `reindexTenantKnowledge` (the body of `scripts/knowledge-reindex.ts`)
 * rebuilds them from `KnowledgeChunk` alone. The test proves:
 *
 *   1. the rebuild reproduces the same (chunk, contentHash) set, exactly;
 *   2. under the same model revision every vector is within
 *      RECOMPUTE_COSINE_TOLERANCE of the one it replaces (the stub is exact;
 *      the module header says what the tolerance means for a real model);
 *   3. a rebuild over a healthy index changes no row: every vector is kept;
 *   4. a rebuild that fails part-way deletes nothing, and the next one
 *      finishes it;
 *   5. the rebuild touches only its own tenant.
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { createVectorRepository } from '@/app-layer/repositories/VectorRepository';
import { createPgvectorStore } from '@/app-layer/repositories/vector/pgvector-store';
import { runKnowledgeIndexJob } from '@/app-layer/jobs/knowledge-index';
import { RECOMPUTE_COSINE_TOLERANCE, reindexTenantKnowledge } from '@/app-layer/services/knowledge-reindex';
import { createPolicy, decidePolicyApproval, requestPolicyApproval } from '@/app-layer/usecases/policy';
import { purgeSoftDeletedTenants } from '@/app-layer/usecases/tenant-purge';
import { StubEmbeddingProvider, type EmbedOptions, type EmbeddingResult } from '@/lib/ai/embeddings';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { prisma as appPrisma } from '@/lib/prisma';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `krdx-${randomUUID().slice(0, 8)}`;
const A = `ta-${SUITE}`;
const B = `tb-${SUITE}`;
const TENANTS = [A, B];
const DIMS = 384;
const MODEL = 'stub-feature-hash@1';

const vectors = createVectorRepository(createPgvectorStore());
const deps = { vectors, embedder: () => ({ ok: true as const, provider: new StubEmbeddingProvider(DIMS) }) };
const userIds: string[] = [];
const ctxOf: Record<string, ReturnType<typeof makeRequestContext>> = {};
const versionOf: Record<string, string> = {};

interface StoredVector {
    chunkId: string;
    hash: string;
    vec: number[];
    seq: bigint;
}

/** Every stored vector of the stub model for a tenant, keyed by chunk, read back as numbers. */
async function stored(tenantId: string): Promise<Map<string, StoredVector>> {
    const rows = await prisma.$queryRaw<Array<{ chunkId: string; hash: string; vec: string; seq: bigint }>>`
        SELECT "chunkId", "contentHash" AS hash, "embedding"::text AS vec, "writeSeq" AS seq
        FROM "KnowledgeChunkEmbedding" WHERE "tenantId" = ${tenantId} AND "embeddingModel" = ${MODEL}`;
    return new Map(rows.map((r) => [r.chunkId, { chunkId: r.chunkId, hash: r.hash, vec: JSON.parse(r.vec) as number[], seq: r.seq }]));
}

function cosine(a: readonly number[], b: readonly number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return dot / Math.sqrt(na * nb);
}

async function makeUser(tenantId: string, role: Role): Promise<string> {
    const email = `${role.toLowerCase()}-${tenantId}@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: u.id, role, status: MembershipStatus.ACTIVE } });
    userIds.push(u.id);
    return u.id;
}

async function indexApprovedPolicy(tenantId: string): Promise<void> {
    const owner = makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: await makeUser(tenantId, Role.OWNER) });
    const editor = makeRequestContext('EDITOR', { tenantId, tenantSlug: tenantId, userId: await makeUser(tenantId, Role.EDITOR) });
    const content = Array.from({ length: 11 }, (_, i) =>
        `Clause ${i} of ${tenantId}: ${'keys are rotated, access is reviewed and logs are kept. '.repeat(14)}`,
    ).join('\n\n');
    const policy = await createPolicy(editor, { title: `Security ${tenantId}`, content });
    const { currentVersionId } = await prisma.policy.findUniqueOrThrow({ where: { id: policy.id }, select: { currentVersionId: true } });
    const approval = await requestPolicyApproval(editor, policy.id, currentVersionId!);
    await decidePolicyApproval(owner, policy.id, approval.id, { decision: 'APPROVED' });
    const r = await runKnowledgeIndexJob({ tenantId, sourceModel: 'PolicyVersion', sourceId: currentVersionId! }, deps);
    expect(r.outcome).toBe('INDEXED');
    ctxOf[tenantId] = owner;
    versionOf[tenantId] = currentVersionId!;
}

async function cleanup(): Promise<void> {
    const existing = await prisma.tenant.findMany({ where: { id: { in: TENANTS } }, select: { id: true } });
    for (const { id } of existing) {
        await prisma.tenant.update({ where: { id }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
        await purgeSoftDeletedTenants({ tenantId: id });
    }
    await deleteAuditRowsForTenants(prisma, TENANTS).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

describeFn('the knowledge index is rebuildable from KnowledgeChunk (pgvector, RLS live)', () => {
    let original: Map<string, StoredVector>;

    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        for (const t of TENANTS) await createTenantWithDek({ id: t, name: t, slug: t });
        await indexApprovedPolicy(A);
        await indexApprovedPolicy(B);
        original = await stored(A);
    });

    afterAll(async () => {
        await cleanup();
        await appPrisma.$disconnect();
        await prisma.$disconnect();
    });

    it('the fixture is what it claims: A holds more than one batch of vectors', () => {
        expect(original.size).toBeGreaterThan(8);
    });

    it('after the store is lost, the rebuild reproduces the same contentHash set and the same vectors', async () => {
        const bBefore = await stored(B);
        await vectors.deleteTenant(ctxOf[A]);
        expect((await stored(A)).size).toBe(0);

        const r = await reindexTenantKnowledge({ tenantId: A }, deps);
        expect(r).toMatchObject({ outcome: 'REBUILT', embeddingModel: MODEL, chunks: original.size, inserted: original.size, deleted: 0 });
        expect(r.embedCalls).toBe(Math.ceil(original.size / 8));

        const rebuilt = await stored(A);
        expect(new Map([...rebuilt].map(([k, v]) => [k, v.hash]))).toEqual(new Map([...original].map(([k, v]) => [k, v.hash])));
        for (const [chunkId, before] of original) {
            const after = rebuilt.get(chunkId)!;
            expect(after.vec).toHaveLength(DIMS);
            expect(1 - cosine(before.vec, after.vec)).toBeLessThanOrEqual(RECOMPUTE_COSINE_TOLERANCE);
        }
        // The other tenant's rows were not read, rewritten or deleted.
        expect(await stored(B)).toEqual(bBefore);
    });

    it('a rebuild over a healthy index keeps every vector', async () => {
        const before = await stored(A);
        const r = await reindexTenantKnowledge({ tenantId: A }, deps);
        expect(r).toMatchObject({ outcome: 'REBUILT', inserted: 0, updated: 0, unchanged: before.size, deleted: 0 });
        const after = await stored(A);
        for (const [chunkId, v] of before) expect(after.get(chunkId)!.vec).toEqual(v.vec);
    });

    it('a rebuild that fails part-way deletes nothing', async () => {
        const before = await stored(A);
        await vectors.deleteTenant(ctxOf[A]);
        class Failing extends StubEmbeddingProvider {
            calls = 0;
            async embed(texts: readonly string[], opts: EmbedOptions): Promise<EmbeddingResult> {
                return ++this.calls === 2 ? { ok: false, reason: 'TIMEOUT' } : super.embed(texts, opts);
            }
        }
        const failing = await reindexTenantKnowledge(
            { tenantId: A },
            { vectors, embedder: () => ({ ok: true, provider: new Failing(DIMS) }) },
        );
        expect(failing).toMatchObject({ outcome: 'EMBED_FAILED', embedFailure: 'TIMEOUT', chunks: 8, deleted: 0 });
        // The first batch landed and stays; nothing was erased for the batch that failed.
        expect((await stored(A)).size).toBe(8);
        // And the next rebuild completes it.
        const r = await reindexTenantKnowledge({ tenantId: A }, deps);
        expect(r).toMatchObject({ outcome: 'REBUILT', inserted: before.size - 8, unchanged: 8, deleted: 0 });
        expect((await stored(A)).size).toBe(before.size);
    });

    it('with the store or the embedding route off, nothing is read or written', async () => {
        const before = await stored(A);
        expect(await reindexTenantKnowledge({ tenantId: A }, { vectors: null })).toMatchObject({ outcome: 'VECTOR_STORE_DISABLED' });
        expect(
            await reindexTenantKnowledge({ tenantId: A }, { vectors, embedder: () => ({ ok: false, reason: 'EMBED_ROUTE_NOT_CONFIGURED' }) }),
        ).toMatchObject({ outcome: 'EMBEDDING_NOT_CONFIGURED' });
        expect(await stored(A)).toEqual(before);
    });
});
