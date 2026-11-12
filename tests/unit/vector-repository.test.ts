/**
 * The vector store's seam, held to its behaviour over the in-process backend.
 *
 * Every assertion goes through `createVectorRepository` — the seam callers
 * use — so a guarantee the repository makes (tenant from context, vectors
 * only, one space per revision, rebuildable, bounded) is proved where it is
 * made, not inside a backend that could be swapped.
 *
 * The isolation cases are the two-tenant behavioural test the
 * new-subsystem checklist asks for: tenant B writes, reads, lists, deletes
 * and rebuilds, and tenant A's rows are untouched by every one of them.
 */

jest.mock('@/env', () => ({ env: {} }));

import { createHash } from 'node:crypto';
import { env } from '@/env';
import {
    createVectorRepository,
    getVectorRepository,
    MAX_SEARCH_K,
    VectorStoreError,
    type VectorRecord,
    type VectorRepository,
} from '@/app-layer/repositories/VectorRepository';
// The backend is imported directly here only to construct the reference
// store; the ESLint seam rule covers src/, and this is the test that proves it.
import { createInProcessVectorStore } from '@/app-layer/repositories/vector/in-process-store';
import { makeRequestContext } from '../helpers/make-context';

const A = makeRequestContext('ADMIN', { tenantId: 'tenant-a', userId: 'user-a' });
const B = makeRequestContext('ADMIN', { tenantId: 'tenant-b', userId: 'user-b' });
const REV = 'test-embed@4';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

function rec(sourceId: string, chunkIndex: number, embedding: number[], text = `${sourceId}#${chunkIndex}`): VectorRecord {
    return {
        sourceModel: 'PolicyVersion',
        sourceId,
        chunkIndex,
        embeddingRevision: REV,
        contentHash: hash(text),
        embedding,
    };
}

const DOC1 = [rec('pv1', 0, [1, 0, 0, 0]), rec('pv1', 1, [0.9, 0.1, 0, 0])];
const DOC2 = [rec('pv2', 0, [0, 1, 0, 0])];

async function refusal(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (e) {
        if (e instanceof VectorStoreError) return e.reason;
        throw e;
    }
    throw new Error('expected a refusal');
}

async function* batchesOf(...batches: VectorRecord[][]): AsyncGenerator<VectorRecord[]> {
    for (const b of batches) yield b;
}

let repo: VectorRepository;
beforeEach(() => {
    repo = createVectorRepository(createInProcessVectorStore());
});

describe('a tenant never reaches another tenant’s vectors', () => {
    beforeEach(async () => {
        await repo.upsert(A, [...DOC1, ...DOC2]);
    });

    it('B searching with A’s exact vector finds nothing', async () => {
        expect(await repo.search(B, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 10 })).toEqual([]);
        expect((await repo.search(A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 10 }))[0]).toMatchObject({
            sourceId: 'pv1',
            chunkIndex: 0,
        });
    });

    it('B listing A’s revision sees no keys', async () => {
        expect(await repo.listKeys(B, REV)).toEqual([]);
        expect(await repo.listKeys(A, REV)).toHaveLength(3);
    });

    it('B deleting A’s source id, or deleting its own tenant, removes nothing of A’s', async () => {
        expect(await repo.deleteSource(B, 'PolicyVersion', 'pv1')).toBe(0);
        expect(await repo.deleteTenant(B)).toBe(0);
        expect(await repo.listKeys(A, REV)).toHaveLength(3);
    });

    it('B writing the same key keeps a row of its own and leaves A’s hash alone', async () => {
        await repo.upsert(B, [rec('pv1', 0, [0, 0, 0, 1], 'b text')]);
        const aRow = (await repo.listKeys(A, REV)).find((k) => k.sourceId === 'pv1' && k.chunkIndex === 0);
        expect(aRow?.contentHash).toBe(hash('pv1#0'));
        const bHits = await repo.search(B, { embeddingRevision: REV, embedding: [0, 0, 0, 1], k: 10 });
        expect(bHits.map((h) => h.contentHash)).toEqual([hash('b text')]);
    });

    it('B rebuilding the revision deletes nothing of A’s', async () => {
        await repo.rebuildRevision(B, REV, batchesOf([rec('other', 0, [0, 0, 1, 0])]));
        expect(await repo.listKeys(A, REV)).toHaveLength(3);
    });
});

describe('vectors only: a record carries a key, a content hash and a vector, never text', () => {
    it('refuses a record carrying text, and writes nothing from that call', async () => {
        const withText = { ...rec('pv1', 0, [1, 0, 0, 0]), text: 'the chunk itself' } as VectorRecord;
        expect(await refusal(repo.upsert(A, [rec('pv9', 0, [1, 1, 0, 0]), withText]))).toBe('UNKNOWN_RECORD_FIELD');
        expect(await repo.listKeys(A, REV)).toEqual([]);
    });

    it('returns references and scores from a search, never a vector or text', async () => {
        await repo.upsert(A, DOC1);
        const [hit] = await repo.search(A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 1 });
        expect(Object.keys(hit).sort()).toEqual(['chunkIndex', 'contentHash', 'score', 'sourceId', 'sourceModel']);
    });

    it('refuses a content hash that is not a SHA-256 — a place text could hide', async () => {
        expect(await refusal(repo.upsert(A, [{ ...rec('pv1', 0, [1, 0, 0, 0]), contentHash: 'plain words' }]))).toBe(
            'INVALID_RECORD',
        );
    });
});

describe('one vector space per embedding revision', () => {
    it('never compares a query with vectors of another revision', async () => {
        await repo.upsert(A, DOC1);
        await repo.upsert(A, [{ ...rec('pv1', 0, [1, 0, 0, 0]), embeddingRevision: 'other@4' }]);
        const hits = await repo.search(A, { embeddingRevision: 'other@4', embedding: [1, 0, 0, 0], k: 10 });
        expect(hits).toHaveLength(1);
    });

    it('refuses a write whose dimensions disagree with the revision’s stored vectors', async () => {
        await repo.upsert(A, DOC1);
        expect(await refusal(repo.upsert(A, [rec('pv3', 0, [1, 0, 0])]))).toBe('REVISION_DIMENSION_MISMATCH');
    });

    it('refuses a query of the wrong dimension rather than comparing it', async () => {
        await repo.upsert(A, DOC1);
        expect(await refusal(repo.search(A, { embeddingRevision: REV, embedding: [1, 0], k: 5 }))).toBe(
            'DIMENSION_MISMATCH',
        );
    });

    it('refuses one call mixing revisions, and a zero vector', async () => {
        expect(await refusal(repo.upsert(A, [DOC1[0], { ...DOC2[0], embeddingRevision: 'other@4' }]))).toBe(
            'MIXED_REVISIONS',
        );
        expect(await refusal(repo.upsert(A, [rec('pv1', 0, [0, 0, 0, 0])]))).toBe('INVALID_RECORD');
    });
});

describe('every read and write is bounded', () => {
    it(`refuses k above ${MAX_SEARCH_K} and returns at most k`, async () => {
        await repo.upsert(A, [...DOC1, ...DOC2]);
        expect(await refusal(repo.search(A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: MAX_SEARCH_K + 1 }))).toBe(
            'INVALID_QUERY',
        );
        expect(await repo.search(A, { embeddingRevision: REV, embedding: [1, 0, 0, 0], k: 2 })).toHaveLength(2);
    });

    it('refuses a key repeated in one call', async () => {
        expect(await refusal(repo.upsert(A, [DOC1[0], DOC1[0]]))).toBe('DUPLICATE_KEY_IN_BATCH');
    });
});

describe('the store is rebuildable from Postgres', () => {
    it('a rebuild into an empty store reproduces exactly the keys and hashes incremental writes produced', async () => {
        await repo.upsert(A, DOC1);
        await repo.upsert(A, DOC2);
        await repo.upsert(A, [rec('pv1', 1, [0.8, 0.2, 0, 0], 'edited')]);
        const incremental = await repo.listKeys(A, REV);

        const fresh = createVectorRepository(createInProcessVectorStore());
        // The "system of record": what Postgres would yield after the same edits.
        const source = [DOC1[0], rec('pv1', 1, [0.8, 0.2, 0, 0], 'edited'), DOC2[0]];
        const outcome = await fresh.rebuildRevision(A, REV, batchesOf(source.slice(0, 2), source.slice(2)));
        expect(outcome).toMatchObject({ inserted: 3, deleted: 0, seen: 3 });
        expect(await fresh.listKeys(A, REV)).toEqual(incremental);
    });

    it('re-running a rebuild is a no-op', async () => {
        await repo.rebuildRevision(A, REV, [[...DOC1, ...DOC2]]);
        expect(await repo.rebuildRevision(A, REV, [[...DOC1, ...DOC2]])).toEqual({
            inserted: 0,
            updated: 0,
            unchanged: 3,
            deleted: 0,
            seen: 3,
        });
    });

    it('deletes the rows the source no longer yields, and only that revision’s', async () => {
        await repo.upsert(A, [...DOC1, ...DOC2]);
        await repo.upsert(A, [{ ...DOC2[0], embeddingRevision: 'other@4' }]);
        const outcome = await repo.rebuildRevision(A, REV, [DOC1]);
        expect(outcome.deleted).toBe(1);
        expect((await repo.listKeys(A, REV)).map((k) => k.sourceId)).toEqual(['pv1', 'pv1']);
        expect(await repo.listKeys(A, 'other@4')).toHaveLength(1);
    });

    it('a source that fails part-way deletes nothing', async () => {
        await repo.upsert(A, [...DOC1, ...DOC2]);
        async function* failing(): AsyncGenerator<VectorRecord[]> {
            yield [DOC1[0]];
            throw new Error('source read failed');
        }
        await expect(repo.rebuildRevision(A, REV, failing())).rejects.toThrow('source read failed');
        expect(await repo.listKeys(A, REV)).toHaveLength(3);
    });

    it('an empty source is refused and erases nothing, unless the caller says the tenant has no chunks', async () => {
        await repo.upsert(A, DOC1);
        expect(await refusal(repo.rebuildRevision(A, REV, []))).toBe('EMPTY_REBUILD_SOURCE');
        expect(await repo.listKeys(A, REV)).toHaveLength(2);
        expect((await repo.rebuildRevision(A, REV, [], { allowEmpty: true })).deleted).toBe(2);
        expect(await repo.listKeys(A, REV)).toEqual([]);
    });

    it('refuses a rebuild batch of another revision', async () => {
        expect(await refusal(repo.rebuildRevision(A, 'other@4', [DOC1]))).toBe('MIXED_REVISIONS');
    });
});

describe('a rebuild never erases a write that landed while it ran', () => {
    it('a chunk ingested between two of its batches survives the final delete', async () => {
        const ingested = rec('pv-new', 0, [0, 0, 1, 0]);
        async function* source(): AsyncGenerator<VectorRecord[]> {
            yield [DOC1[0]];
            // A user saves a new document while the rebuild is paging.
            await repo.upsert(A, [ingested]);
            yield [DOC1[1]];
        }
        const outcome = await repo.rebuildRevision(A, REV, source());
        expect(outcome.deleted).toBe(0);
        expect((await repo.listKeys(A, REV)).map((k) => k.sourceId)).toEqual(['pv-new', 'pv1', 'pv1']);
    });

    it('re-upserting a row the rebuild already stamped does not hand it to the delete', async () => {
        async function* source(): AsyncGenerator<VectorRecord[]> {
            yield [DOC1[0]];
            await repo.upsert(A, [DOC1[0]]);
            yield [DOC1[1]];
        }
        await repo.rebuildRevision(A, REV, source());
        expect(await repo.listKeys(A, REV)).toHaveLength(2);
    });

    it('two overlapping rebuilds of one tenant and revision do not erase each other’s rows', async () => {
        const later = rec('pv-later', 0, [0, 0, 0, 1]);
        async function* outer(): AsyncGenerator<VectorRecord[]> {
            yield [DOC1[0]];
            // A second rebuild, from a newer read of the source, runs to completion.
            await repo.rebuildRevision(A, REV, [[DOC1[0], later]]);
            yield [DOC1[1]];
        }
        await repo.rebuildRevision(A, REV, outer());
        expect((await repo.listKeys(A, REV)).map((k) => k.sourceId)).toEqual(['pv-later', 'pv1', 'pv1']);
    });

    it('a row written before the rebuild began and absent from its source is still deleted', async () => {
        await repo.upsert(A, [...DOC1, ...DOC2]);
        async function* source(): AsyncGenerator<VectorRecord[]> {
            yield [DOC1[0]];
            await repo.upsert(A, [rec('pv-new', 0, [0, 0, 1, 0])]);
            yield [DOC1[1]];
        }
        const outcome = await repo.rebuildRevision(A, REV, source());
        expect(outcome.deleted).toBe(1);
        expect((await repo.listKeys(A, REV)).map((k) => k.sourceId)).not.toContain('pv2');
    });
});

describe('the deployment’s vector store is off unless the operator names pgvector', () => {
    const mutableEnv = env as { VECTOR_STORE_BACKEND?: string };

    it.each([undefined, '', 'PGVECTOR', 'pgvector ', 'weaviate', '1'])('VECTOR_STORE_BACKEND=%p constructs nothing', (value) => {
        jest.isolateModules(() => {
            mutableEnv.VECTOR_STORE_BACKEND = value;
            const { getVectorRepository: fresh } = require('@/app-layer/repositories/VectorRepository');
            expect(fresh()).toBeNull();
        });
    });

    it('VECTOR_STORE_BACKEND=pgvector constructs the pgvector backend', () => {
        jest.isolateModules(() => {
            mutableEnv.VECTOR_STORE_BACKEND = 'pgvector';
            const { getVectorRepository: fresh } = require('@/app-layer/repositories/VectorRepository');
            expect(fresh()?.backend).toBe('pgvector');
        });
        mutableEnv.VECTOR_STORE_BACKEND = undefined;
    });

    it('the module-level getter is off in this test environment', () => {
        expect(getVectorRepository()).toBeNull();
    });
});
