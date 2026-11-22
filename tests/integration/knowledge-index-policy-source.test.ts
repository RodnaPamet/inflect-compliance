/**
 * The first knowledge source, end to end (vector store Phases 2.2 and 2.5):
 * an approved `PolicyVersion` enters the index through the policy's own write
 * paths, and leaves it through every path that removes it.
 *
 *   1. Approving a version queues one `knowledge-index` job for it, after the
 *      decision commits; running that payload chunks and embeds the policy in
 *      one run. A rejection queues nothing.
 *   2. With the index switched off, an approval queues nothing at all.
 *   3. A soft delete queues the policy's approved versions, whose run removes
 *      their chunks; a restore queues them again, whose run puts them back.
 *   4. The data-lifecycle purge of a soft-deleted policy removes its versions'
 *      chunks and vectors, and leaves another policy's.
 *   5. The admin's manual purge does the same.
 *   6. The tenant purge leaves no row of either table.
 *
 * The queue is the one thing replaced: `enqueue` records its payloads instead
 * of reaching Redis, and the test runs each recorded payload the way the
 * worker would (`runKnowledgeIndexJob`), with the stub embedder.
 */

const queued: Array<{ name: string; payload: Record<string, unknown> }> = [];
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: jest.fn(async (name: string, payload: Record<string, unknown>) => {
        queued.push({ name, payload });
        return { id: `job-${queued.length}` };
    }),
}));

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { createVectorRepository } from '@/app-layer/repositories/VectorRepository';
import { createPgvectorStore } from '@/app-layer/repositories/vector/pgvector-store';
import { runKnowledgeIndexJob } from '@/app-layer/jobs/knowledge-index';
import { purgeSoftDeletedOlderThan } from '@/app-layer/jobs/data-lifecycle';
import {
    createPolicy,
    decidePolicyApproval,
    deletePolicy,
    purgePolicy,
    requestPolicyApproval,
    restorePolicy,
} from '@/app-layer/usecases/policy';
import { purgeSoftDeletedTenants } from '@/app-layer/usecases/tenant-purge';
import { StubEmbeddingProvider } from '@/lib/ai/embeddings';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { prisma as appPrisma } from '@/lib/prisma';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import type { KnowledgeIndexPayload } from '@/app-layer/jobs/types';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `kpol-${randomUUID().slice(0, 8)}`;
const T = `t-${SUITE}`;
const MODEL = 'stub-feature-hash@1';

/** Both switches ON, as the operator would set them; read on first use. */
const SWITCHES = {
    VECTOR_STORE_BACKEND: 'pgvector',
    AI_EMBED_LOCAL_BASE_URL: 'http://127.0.0.1:8089',
    AI_EMBED_LOCAL_MODEL: 'intfloat/multilingual-e5-small',
    AI_EMBED_LOCAL_DIMENSIONS: '384',
} as const;
const saved: Record<string, string | undefined> = {};

const vectors = createVectorRepository(createPgvectorStore());
const deps = { vectors, embedder: () => ({ ok: true as const, provider: new StubEmbeddingProvider(384) }) };

const userIds: string[] = [];
let owner: ReturnType<typeof makeRequestContext>;
let editor: ReturnType<typeof makeRequestContext>;

async function makeUser(role: Role): Promise<string> {
    const email = `${role.toLowerCase()}-${T}@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId: T, userId: u.id, role, status: MembershipStatus.ACTIVE } });
    userIds.push(u.id);
    return u.id;
}

const text = (topic: string) =>
    Array.from({ length: 3 }, (_, i) => `${topic} clause ${i}: ${'the control is reviewed and evidenced. '.repeat(25)}`).join('\n\n');

/** An editor writes and asks; returns the policy, its version and the pending approval. */
async function requested(topic: string) {
    const policy = await createPolicy(editor, { title: `${topic} ${SUITE}`, content: text(topic) });
    const { currentVersionId } = await prisma.policy.findUniqueOrThrow({ where: { id: policy.id }, select: { currentVersionId: true } });
    const approval = await requestPolicyApproval(editor, policy.id, currentVersionId!);
    return { policyId: policy.id, versionId: currentVersionId!, approvalId: approval.id };
}

/** Run every queued knowledge-index payload, as the worker would, and empty the queue. */
async function drain() {
    const jobs = queued.splice(0).filter((q) => q.name === 'knowledge-index');
    const results = [];
    for (const j of jobs) results.push(await runKnowledgeIndexJob(j.payload as unknown as KnowledgeIndexPayload, deps));
    return results;
}

async function counts(versionId: string): Promise<{ chunks: number; embeddings: number }> {
    const [c] = await prisma.$queryRaw<Array<{ chunks: bigint; embeddings: bigint }>>`
        SELECT (SELECT count(*) FROM "KnowledgeChunk" WHERE "tenantId" = ${T} AND "sourceId" = ${versionId}) AS chunks,
               (SELECT count(*) FROM "KnowledgeChunkEmbedding" e JOIN "KnowledgeChunk" c ON c."id" = e."chunkId"
                 WHERE e."tenantId" = ${T} AND c."sourceId" = ${versionId}) AS embeddings`;
    return { chunks: Number(c.chunks), embeddings: Number(c.embeddings) };
}

async function approvedAndIndexed(topic: string) {
    const p = await requested(topic);
    await decidePolicyApproval(owner, p.policyId, p.approvalId, { decision: 'APPROVED' });
    await drain();
    expect((await counts(p.versionId)).chunks).toBeGreaterThan(0);
    return p;
}

async function cleanup(): Promise<void> {
    const existing = await prisma.tenant.findMany({ where: { id: T }, select: { id: true } });
    for (const { id } of existing) {
        await prisma.tenant.update({ where: { id }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
        await purgeSoftDeletedTenants({ tenantId: id });
    }
    await deleteAuditRowsForTenants(prisma, [T]).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: T } });
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

describeFn('approved policy versions are a knowledge source (pgvector, RLS live)', () => {
    beforeAll(async () => {
        for (const [k, v] of Object.entries(SWITCHES)) {
            saved[k] = process.env[k];
            process.env[k] = v;
        }
        await prisma.$connect();
        await cleanup();
        await createTenantWithDek({ id: T, name: T, slug: T });
        owner = makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: await makeUser(Role.OWNER) });
        editor = makeRequestContext('EDITOR', { tenantId: T, tenantSlug: T, userId: await makeUser(Role.EDITOR) });
    });

    beforeEach(() => {
        queued.length = 0;
    });

    afterAll(async () => {
        await cleanup();
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        await appPrisma.$disconnect();
        await prisma.$disconnect();
    });

    describe('1. the approval path', () => {
        it('approving queues one job for that version, after the commit, and its one run indexes the policy', async () => {
            const p = await requested('Access');
            expect(queued).toEqual([]);
            await decidePolicyApproval(owner, p.policyId, p.approvalId, { decision: 'APPROVED' });
            expect(queued).toEqual([
                {
                    name: 'knowledge-index',
                    payload: { tenantId: T, sourceModel: 'PolicyVersion', sourceId: p.versionId, requestId: owner.requestId },
                },
            ]);
            const [r] = await drain();
            expect(r.outcome).toBe('INDEXED');
            expect(await counts(p.versionId)).toEqual({ chunks: r.chunks, embeddings: r.chunks });
            expect(r.chunks).toBeGreaterThan(0);
        });

        it('a rejection queues nothing', async () => {
            const p = await requested('Backup');
            await decidePolicyApproval(owner, p.policyId, p.approvalId, { decision: 'REJECTED', comment: 'no' });
            expect(queued).toEqual([]);
            expect(await counts(p.versionId)).toEqual({ chunks: 0, embeddings: 0 });
        });
    });

    describe('2. switched off', () => {
        it('with the embedding route off, an approval queues nothing and the decision still lands', async () => {
            // The repository is read once per process, so the off switch is
            // the embedding route's: either one off means nothing is queued.
            const base = process.env.AI_EMBED_LOCAL_BASE_URL;
            delete process.env.AI_EMBED_LOCAL_BASE_URL;
            try {
                const p = await requested('Crypto');
                await decidePolicyApproval(owner, p.policyId, p.approvalId, { decision: 'APPROVED' });
                expect(queued).toEqual([]);
                const row = await prisma.policyApproval.findUniqueOrThrow({ where: { id: p.approvalId } });
                expect(row.status).toBe('APPROVED');
            } finally {
                process.env.AI_EMBED_LOCAL_BASE_URL = base;
            }
        });
    });

    describe('3. soft delete and restore', () => {
        it('a soft delete removes the policy’s chunks on the next run; a restore puts them back', async () => {
            const p = await approvedAndIndexed('Vendor');
            const before = await counts(p.versionId);

            await deletePolicy(owner, p.policyId);
            expect(queued.map((q) => q.payload.sourceId)).toEqual([p.versionId]);
            const [removed] = await drain();
            expect(removed).toMatchObject({ outcome: 'SOURCE_NOT_INDEXABLE', notIndexable: 'PARENT_DELETED' });
            expect(await counts(p.versionId)).toEqual({ chunks: 0, embeddings: 0 });

            await restorePolicy(owner, p.policyId);
            expect(queued.map((q) => q.payload.sourceId)).toEqual([p.versionId]);
            const [back] = await drain();
            expect(back.outcome).toBe('INDEXED');
            expect(await counts(p.versionId)).toEqual(before);
        });
    });

    describe('4. the data-lifecycle purge', () => {
        it('purging a soft-deleted policy removes its versions’ chunks and vectors, and leaves another policy’s', async () => {
            const gone = await approvedAndIndexed('Incident');
            const kept = await approvedAndIndexed('Asset');
            const keptBefore = await counts(kept.versionId);
            await deletePolicy(owner, gone.policyId);
            queued.length = 0; // the purge is under test, not the job the delete queued

            await purgeSoftDeletedOlderThan({ tenantId: T, now: new Date(Date.now() + 91 * 86_400_000) });
            expect(await prisma.policyVersion.count({ where: { id: gone.versionId } })).toBe(0);
            expect(await counts(gone.versionId)).toEqual({ chunks: 0, embeddings: 0 });
            expect(await counts(kept.versionId)).toEqual(keptBefore);
        });
    });

    describe('5. the manual purge', () => {
        it('an admin’s purge of a soft-deleted policy removes its versions’ chunks and vectors', async () => {
            const p = await approvedAndIndexed('Physical');
            await deletePolicy(owner, p.policyId);
            queued.length = 0;
            await purgePolicy(owner, p.policyId);
            expect(await prisma.policyVersion.count({ where: { id: p.versionId } })).toBe(0);
            expect(await counts(p.versionId)).toEqual({ chunks: 0, embeddings: 0 });
        });
    });

    describe('6. the tenant purge', () => {
        it('purging the tenant leaves no row of either table', async () => {
            await approvedAndIndexed('Network');
            await prisma.tenant.update({ where: { id: T }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
            await purgeSoftDeletedTenants({ tenantId: T });
            const [c] = await prisma.$queryRaw<Array<{ chunks: bigint; embeddings: bigint }>>`
                SELECT (SELECT count(*) FROM "KnowledgeChunk" WHERE "tenantId" = ${T}) AS chunks,
                       (SELECT count(*) FROM "KnowledgeChunkEmbedding" WHERE "tenantId" = ${T}) AS embeddings`;
            expect({ chunks: Number(c.chunks), embeddings: Number(c.embeddings) }).toEqual({ chunks: 0, embeddings: 0 });
        });
    });
});
