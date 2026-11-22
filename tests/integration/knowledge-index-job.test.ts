/**
 * The `knowledge-index` job against the real tables, with pgvector loaded and
 * RLS live (vector store Phase 2.1; the new-subsystem checklist's two-tenant
 * test, at the job layer).
 *
 * Each tenant's policy is approved through the product's own usecases (an
 * editor writes and requests, an owner decides), so "approved" means what
 * `decidePolicyApproval` records. The job runs exactly as the worker runs it
 * (`runKnowledgeIndexJob`), with two seams supplied: the deterministic stub
 * embedder (the deployment has no embedding route here, which is the point of
 * the stub) and the pgvector backend (`VECTOR_STORE_BACKEND` is unset here).
 *
 *   1. Indexing A's approved policy writes A's chunks, encrypted, and one
 *      vector per chunk, and nothing under B.
 *   2. Nothing of A's is reachable from B: B's nearest-neighbour query with A's
 *      own vector, B's key listing for A's source, and a run of the job under
 *      B naming A's version, which finds no row and touches none of A's.
 *   3. A second run is a no-op: no embedding call, the same rows.
 *   4. A version nobody approved indexes nothing.
 *   5. A vector computed from text its chunk no longer holds is refused.
 *   6. Purging tenant A leaves no row of either table.
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { createVectorRepository, VectorStoreError } from '@/app-layer/repositories/VectorRepository';
// Constructed directly, as getVectorRepository() would with VECTOR_STORE_BACKEND=pgvector.
import { createPgvectorStore } from '@/app-layer/repositories/vector/pgvector-store';
import { runKnowledgeIndexJob } from '@/app-layer/jobs/knowledge-index';
import { createPolicy, decidePolicyApproval, requestPolicyApproval, createPolicyVersion } from '@/app-layer/usecases/policy';
import { purgeSoftDeletedTenants } from '@/app-layer/usecases/tenant-purge';
import { StubEmbeddingProvider, stubVector, type EmbedOptions, type EmbeddingResult } from '@/lib/ai/embeddings';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { prisma as appPrisma } from '@/lib/prisma';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `kidx-${randomUUID().slice(0, 8)}`;
const A = `ta-${SUITE}`;
const B = `tb-${SUITE}`;
const TENANTS = [A, B];
const DIMS = 384;

/** The stub at the deployed model's dimension count, counting calls. */
class CountingStub extends StubEmbeddingProvider {
    calls = 0;
    constructor() {
        super(DIMS);
    }
    async embed(texts: readonly string[], opts: EmbedOptions): Promise<EmbeddingResult> {
        this.calls += 1;
        return super.embed(texts, opts);
    }
}

const vectors = createVectorRepository(createPgvectorStore());
let embedder = new CountingStub();
const deps = () => ({ vectors, embedder: () => ({ ok: true as const, provider: embedder }) });

const POLICY_TEXT: Record<string, string> = {
    [A]: Array.from({ length: 5 }, (_, i) =>
        `Section ${i}. Tenant A rotates its signing keys every ninety days and reviews access quarterly. `.repeat(8).trim(),
    ).join('\n\n'),
    [B]: 'Tenant B assesses every supplier yearly against its onboarding questionnaire.',
};

interface Fixture {
    ctxOwner: ReturnType<typeof makeRequestContext>;
    ctxEditor: ReturnType<typeof makeRequestContext>;
    versionId: string;
    policyId: string;
}
const fx: Record<string, Fixture> = {};
const userIds: string[] = [];

async function makeUser(tenantId: string, role: Role): Promise<string> {
    const email = `${role.toLowerCase()}-${tenantId}@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: u.id, role, status: MembershipStatus.ACTIVE } });
    userIds.push(u.id);
    return u.id;
}

/** An editor writes the policy and asks; an owner, who wrote nothing, approves. */
async function approvedPolicy(tenantId: string): Promise<Fixture> {
    const ownerId = await makeUser(tenantId, Role.OWNER);
    const editorId = await makeUser(tenantId, Role.EDITOR);
    const ctxOwner = makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: ownerId });
    const ctxEditor = makeRequestContext('EDITOR', { tenantId, tenantSlug: tenantId, userId: editorId });
    const policy = await createPolicy(ctxEditor, { title: `Key management ${tenantId}`, content: POLICY_TEXT[tenantId] });
    const row = await prisma.policy.findUniqueOrThrow({ where: { id: policy.id }, select: { currentVersionId: true } });
    const versionId = row.currentVersionId!;
    const approval = await requestPolicyApproval(ctxEditor, policy.id, versionId);
    await decidePolicyApproval(ctxOwner, policy.id, approval.id, { decision: 'APPROVED' });
    return { ctxOwner, ctxEditor, versionId, policyId: policy.id };
}

async function rowCounts(tenantId: string): Promise<{ chunks: number; embeddings: number }> {
    const [c] = await prisma.$queryRaw<Array<{ chunks: bigint; embeddings: bigint }>>`
        SELECT (SELECT count(*) FROM "KnowledgeChunk" WHERE "tenantId" = ${tenantId}) AS chunks,
               (SELECT count(*) FROM "KnowledgeChunkEmbedding" WHERE "tenantId" = ${tenantId}) AS embeddings`;
    return { chunks: Number(c.chunks), embeddings: Number(c.embeddings) };
}

/** Every row's identity and write stamp, so "nothing was written" is a comparison, not a count. */
async function snapshot(tenantId: string) {
    return prisma.$queryRaw<Array<{ id: string; hash: string; seq: bigint; eid: string; ehash: string }>>`
        SELECT c."id", c."contentHash" AS hash, e."writeSeq" AS seq, e."id" AS eid, e."contentHash" AS ehash
        FROM "KnowledgeChunk" c JOIN "KnowledgeChunkEmbedding" e ON e."chunkId" = c."id" AND e."tenantId" = c."tenantId"
        WHERE c."tenantId" = ${tenantId} ORDER BY c."chunkIndex"`;
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

describeFn('the knowledge-index job keeps two tenants apart (pgvector, RLS live)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        for (const t of TENANTS) await createTenantWithDek({ id: t, name: t, slug: t });
        fx[A] = await approvedPolicy(A);
        fx[B] = await approvedPolicy(B);
    });

    afterAll(async () => {
        await cleanup();
        await appPrisma.$disconnect();
        await prisma.$disconnect();
    });

    describe('1. indexing A’s approved policy writes under A only', () => {
        it('one run chunks and embeds the policy: one vector per chunk, in batches of at most 8', async () => {
            const r = await runKnowledgeIndexJob({ tenantId: A, sourceModel: 'PolicyVersion', sourceId: fx[A].versionId }, deps());
            expect(r.outcome).toBe('INDEXED');
            expect(r.chunks).toBeGreaterThan(1);
            expect(r.embedded).toBe(r.chunks);
            expect(r.embedCalls).toBe(Math.ceil(r.chunks / 8));
            expect(r.embeddingModel).toBe('stub-feature-hash@1');
            expect(await rowCounts(A)).toEqual({ chunks: r.chunks, embeddings: r.chunks });
            expect(await rowCounts(B)).toEqual({ chunks: 0, embeddings: 0 });
        });

        it('the chunk text is ciphertext at rest, and every chunk names the chunker and the policy version', async () => {
            const rows = await prisma.$queryRaw<Array<{ text: string; sourceModel: string; sourceId: string; rev: string }>>`
                SELECT "text", "sourceModel", "sourceId", "chunkerRevision" AS rev FROM "KnowledgeChunk" WHERE "tenantId" = ${A}`;
            expect(rows.length).toBeGreaterThan(0);
            for (const row of rows) {
                expect(row.text).toMatch(/^v[12]:/);
                expect(row.text).not.toContain('signing keys');
                expect(row).toMatchObject({ sourceModel: 'PolicyVersion', sourceId: fx[A].versionId, rev: 'paragraph@1' });
            }
        });
    });

    describe('2. B can reach nothing A’s run wrote', () => {
        it('B’s nearest-neighbour query with A’s own vector returns nothing; A’s returns A’s chunks', async () => {
            const q = stubVector('Tenant A rotates its signing keys every ninety days', DIMS);
            const query = { embeddingRevision: 'stub-feature-hash@1', embedding: q, k: 10 };
            expect(await vectors.search(fx[B].ctxOwner, query)).toEqual([]);
            const hits = await vectors.search(fx[A].ctxOwner, query);
            expect(hits.length).toBeGreaterThan(0);
            expect(new Set(hits.map((h) => h.sourceId))).toEqual(new Set([fx[A].versionId]));
        });

        it('B’s key listing for A’s policy version is empty', async () => {
            expect(await vectors.listSourceKeys(fx[B].ctxOwner, 'stub-feature-hash@1', 'PolicyVersion', fx[A].versionId)).toEqual([]);
            expect(
                (await vectors.listSourceKeys(fx[A].ctxOwner, 'stub-feature-hash@1', 'PolicyVersion', fx[A].versionId)).length,
            ).toBeGreaterThan(0);
        });

        it('a run under B naming A’s version finds no row, writes nothing and leaves A’s rows alone', async () => {
            const before = await snapshot(A);
            embedder = new CountingStub();
            const r = await runKnowledgeIndexJob({ tenantId: B, sourceModel: 'PolicyVersion', sourceId: fx[A].versionId }, deps());
            expect(r).toMatchObject({ outcome: 'SOURCE_NOT_INDEXABLE', notIndexable: 'GONE', chunksDeleted: 0 });
            expect(embedder.calls).toBe(0);
            expect(await snapshot(A)).toEqual(before);
            expect(await rowCounts(B)).toEqual({ chunks: 0, embeddings: 0 });
        });

        it('B’s own run indexes B’s policy and leaves A’s rows alone', async () => {
            const before = await snapshot(A);
            const r = await runKnowledgeIndexJob({ tenantId: B, sourceModel: 'PolicyVersion', sourceId: fx[B].versionId }, deps());
            expect(r.outcome).toBe('INDEXED');
            expect(await rowCounts(B)).toEqual({ chunks: 1, embeddings: 1 });
            expect(await snapshot(A)).toEqual(before);
        });
    });

    describe('3. a re-run is a no-op', () => {
        it('the second run makes no embedding call and rewrites no row', async () => {
            const before = await snapshot(A);
            embedder = new CountingStub();
            const r = await runKnowledgeIndexJob({ tenantId: A, sourceModel: 'PolicyVersion', sourceId: fx[A].versionId }, deps());
            expect(r).toMatchObject({ outcome: 'UNCHANGED', chunksWritten: 0, chunksDeleted: 0, embedded: 0, embedCalls: 0 });
            expect(embedder.calls).toBe(0);
            expect(await snapshot(A)).toEqual(before);
        });
    });

    describe('4. approved versions only', () => {
        it('a version nobody approved writes no chunk', async () => {
            const draft = await createPolicyVersion(fx[A].ctxEditor, fx[A].policyId, {
                contentType: 'MARKDOWN',
                contentText: 'A draft that was never approved.',
            });
            const r = await runKnowledgeIndexJob({ tenantId: A, sourceModel: 'PolicyVersion', sourceId: draft.id }, deps());
            expect(r).toMatchObject({ outcome: 'SOURCE_NOT_INDEXABLE', notIndexable: 'NOT_APPROVED' });
            const [n] = await prisma.$queryRaw<Array<{ n: bigint }>>`
                SELECT count(*) AS n FROM "KnowledgeChunk" WHERE "tenantId" = ${A} AND "sourceId" = ${draft.id}`;
            expect(Number(n.n)).toBe(0);
        });
    });

    describe('5. a vector lands only on the text it was computed from', () => {
        it('an upsert whose contentHash is not its chunk’s is refused CONTENT_HASH_MISMATCH, and nothing changes', async () => {
            const before = await snapshot(A);
            const err = await vectors
                .upsert(fx[A].ctxOwner, [
                    {
                        sourceModel: 'PolicyVersion',
                        sourceId: fx[A].versionId,
                        chunkIndex: 0,
                        embeddingRevision: 'stub-feature-hash@1',
                        contentHash: 'f'.repeat(64),
                        embedding: stubVector('older text', DIMS),
                    },
                ])
                .catch((e: unknown) => e);
            expect(err).toBeInstanceOf(VectorStoreError);
            expect((err as VectorStoreError).reason).toBe('CONTENT_HASH_MISMATCH');
            expect(await snapshot(A)).toEqual(before);
        });
    });

    describe('6. the tenant purge', () => {
        it('purging tenant A leaves no row of either table, and B’s untouched', async () => {
            const bBefore = await rowCounts(B);
            await prisma.tenant.update({ where: { id: A }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
            await purgeSoftDeletedTenants({ tenantId: A });
            expect(await rowCounts(A)).toEqual({ chunks: 0, embeddings: 0 });
            expect(await rowCounts(B)).toEqual(bBefore);
        });
    });
});
