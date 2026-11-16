/**
 * The pgvector backend, held to the two properties that do not need the
 * extension to prove: it refuses before any statement when the extension or
 * its table is absent, and every statement it sends runs inside the caller's
 * tenant transaction AND binds that tenant's id as a parameter.
 *
 * Here the transaction is a recorder, so these run without a database. The
 * behavioural half — two tenants against the real tables under RLS, with the
 * extension loaded — is tests/integration/vector-tenant-isolation.test.ts.
 */

import type { Prisma } from '@prisma/client';

type Statement = { sql: string; values: unknown[]; txn: number };
const statements: Statement[] = [];
const tenantsBound: string[] = [];
let probe: { ver: string | null; tbl: boolean } = { ver: '0.8.0', tbl: true };
/** The chunks the resolution query finds: by default, RECORD's. */
let chunks: Array<Record<string, unknown>> = [];
const START_SEQ = BigInt(41);

jest.mock('@/lib/db/rls-middleware', () => ({
    runInTenantContext: jest.fn(async (ctx: { tenantId: string }, fn: (tx: unknown) => Promise<unknown>) => {
        tenantsBound.push(ctx.tenantId);
        const txn = tenantsBound.length;
        const record = (q: Prisma.Sql) => {
            statements.push({ sql: q.sql, values: q.values, txn });
            return q.sql;
        };
        const tx = {
            $queryRaw: jest.fn(async (q: Prisma.Sql) => {
                const sql = record(q);
                if (sql.includes('pg_extension')) return [probe];
                if (sql.includes('nextval')) return [{ seq: START_SEQ }];
                if (sql.includes('LEFT JOIN')) return chunks;
                return [];
            }),
            $executeRaw: jest.fn(async (q: Prisma.Sql) => {
                record(q);
                return 0;
            }),
        };
        return fn(tx);
    }),
}));

import { createHash } from 'node:crypto';
import { createPgvectorStore } from '@/app-layer/repositories/vector/pgvector-store';
import { VectorStoreError, type VectorRecord } from '@/app-layer/repositories/vector/types';
import { makeRequestContext } from '../helpers/make-context';

const CTX = makeRequestContext('ADMIN', { tenantId: 'tenant-under-test' });
const RECORD: VectorRecord = {
    sourceModel: 'PolicyVersion',
    sourceId: 'pv1',
    chunkIndex: 0,
    embeddingRevision: 'test-embed@3',
    contentHash: createHash('sha256').update('x').digest('hex'),
    embedding: [1, 0, 0],
};

beforeEach(() => {
    statements.length = 0;
    tenantsBound.length = 0;
    probe = { ver: '0.8.0', tbl: true };
    chunks = [
        {
            chunkId: 'chunk-1',
            sourceModel: 'PolicyVersion',
            sourceId: 'pv1',
            chunkIndex: 0,
            chunkHash: RECORD.contentHash,
            prior: null,
        },
    ];
});

describe('the pgvector backend fails closed until the extension and its table exist', () => {
    it.each([
        ['the extension is absent', { ver: null, tbl: false }],
        ['the extension predates iterative index scans (0.7.4)', { ver: '0.7.4', tbl: true }],
        ['the table is absent', { ver: '0.8.1', tbl: false }],
    ])('refuses PGVECTOR_NOT_INSTALLED when %s, and sends nothing after the probe', async (_label, state) => {
        probe = state;
        const store = createPgvectorStore();
        const err = await store.upsert(CTX, [RECORD]).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(VectorStoreError);
        expect((err as VectorStoreError).reason).toBe('PGVECTOR_NOT_INSTALLED');
        expect(statements).toHaveLength(1);
        expect(statements[0].sql).toContain('pg_extension');
    });

    it('asks again after a negative probe, so installing the extension needs no restart', async () => {
        probe = { ver: null, tbl: false };
        const store = createPgvectorStore();
        await store.listKeys(CTX, 'test-embed@3', 10).catch(() => undefined);
        probe = { ver: '0.10.2', tbl: true };
        await expect(store.listKeys(CTX, 'test-embed@3', 10)).resolves.toEqual([]);
    });
});

describe('every pgvector statement is the caller’s tenant’s', () => {
    it('runs each operation inside runInTenantContext for ctx, and binds ctx.tenantId in every statement on the table', async () => {
        const store = createPgvectorStore();
        await store.upsert(CTX, [RECORD]);
        await store.search(CTX, { embeddingRevision: 'test-embed@3', embedding: [1, 0, 0], k: 5 });
        await store.listKeys(CTX, 'test-embed@3', 10);
        await store.listSourceKeys(CTX, 'test-embed@3', 'PolicyVersion', 'pv1', 10);
        await store.deleteSource(CTX, 'PolicyVersion', 'pv1');
        await store.deleteTenant(CTX);
        await store.rebuildRevision(
            CTX,
            'test-embed@3',
            (async function* () {
                yield [RECORD];
            })(),
        );

        expect(new Set(tenantsBound)).toEqual(new Set([CTX.tenantId]));
        const onTable = statements.filter((s) => s.sql.includes('"KnowledgeChunkEmbedding"') && !s.sql.includes('to_regclass'));
        expect(onTable.length).toBeGreaterThanOrEqual(9);
        for (const s of onTable) {
            expect([s.sql.includes('"tenantId"'), s.values.includes(CTX.tenantId)]).toEqual([true, true]);
        }
    });

    it('never interpolates a value into SQL text: the tenant id and the vector are parameters', async () => {
        const store = createPgvectorStore();
        await store.upsert(CTX, [RECORD]);
        for (const s of statements) {
            expect(s.sql).not.toContain(CTX.tenantId);
            expect(s.sql).not.toContain('[1,0,0]');
        }
    });

    it('a rebuild deletes the rows it did not see only after its last batch', async () => {
        const store = createPgvectorStore();
        async function* failing() {
            yield [RECORD];
            throw new Error('source read failed');
        }
        await expect(store.rebuildRevision(CTX, 'test-embed@3', failing())).rejects.toThrow('source read failed');
        expect(statements.some((s) => /^\s*DELETE/m.test(s.sql))).toBe(false);
    });
});

describe('a filtered search over the shared per-revision index still finds the tenant’s rows', () => {
    it('turns on strict-order iterative index scans in the search’s own transaction, before the ORDER BY', async () => {
        // A search returns nothing until a revision has rows; give it one.
        const store = createPgvectorStore();
        const original = jest.requireMock('@/lib/db/rls-middleware').runInTenantContext;
        original.mockImplementationOnce(async (ctx: { tenantId: string }, fn: (tx: unknown) => Promise<unknown>) => {
            tenantsBound.push(ctx.tenantId);
            const txn = tenantsBound.length;
            const tx = {
                $queryRaw: jest.fn(async (q: Prisma.Sql) => {
                    statements.push({ sql: q.sql, values: q.values, txn });
                    if (q.sql.includes('pg_extension')) return [probe];
                    if (q.sql.includes('DISTINCT "dimensions"')) return [{ dimensions: 3 }];
                    return [];
                }),
                $executeRaw: jest.fn(async () => 0),
            };
            return fn(tx);
        });
        await store.search(CTX, { embeddingRevision: 'test-embed@3', embedding: [1, 0, 0], k: 50 });
        const setIdx = statements.findIndex((s) => s.sql.includes("set_config('hnsw.iterative_scan', 'strict_order', true)"));
        const searchIdx = statements.findIndex((s) => s.sql.includes('ORDER BY'));
        expect([setIdx >= 0, searchIdx > setIdx]).toEqual([true, true]);
        expect(statements[setIdx].txn).toBe(statements[searchIdx].txn);
        expect(statements[setIdx].values).toContain('50');
    });
});

describe('a rebuild never erases a write that landed while it ran', () => {
    it('every write takes the shared (tenant, revision) lock before it touches the table', async () => {
        const store = createPgvectorStore();
        await store.upsert(CTX, [RECORD]);
        const lockIdx = statements.findIndex((s) => s.sql.includes('pg_advisory_xact_lock_shared('));
        const firstOnTable = statements.findIndex((s) => s.sql.includes('FROM "KnowledgeChunkEmbedding"') || s.sql.includes('INTO "KnowledgeChunkEmbedding"') || s.sql.includes('FROM "KnowledgeChunk"'));
        expect([lockIdx >= 0, lockIdx < firstOnTable]).toEqual([true, true]);
        expect(statements[lockIdx].values).toEqual([`knowledge-vector:${CTX.tenantId}`, 'test-embed@3']);
    });

    it('draws its start sequence under the exclusive lock before the first batch, and deletes only rows written before it', async () => {
        const store = createPgvectorStore();
        await store.rebuildRevision(
            CTX,
            'test-embed@3',
            (async function* () {
                yield [RECORD];
            })(),
        );
        const exclusive = statements.findIndex((s) => /pg_advisory_xact_lock\(/.test(s.sql));
        const nextval = statements.findIndex((s) => s.sql.includes('nextval'));
        const firstInsert = statements.findIndex((s) => s.sql.includes('INSERT INTO'));
        expect([exclusive >= 0, exclusive < nextval, nextval < firstInsert]).toEqual([true, true, true]);
        expect(statements[exclusive].txn).toBe(statements[nextval].txn);

        const del = statements.find((s) => /^\s*DELETE/m.test(s.sql));
        expect(del?.sql).toMatch(/"writeSeq" < \?/);
        expect(del?.values).toContain(START_SEQ);
    });

    it('a plain upsert keeps the generation a rebuild stamped rather than resetting it', async () => {
        const store = createPgvectorStore();
        await store.upsert(CTX, [RECORD]);
        const insert = statements.find((s) => s.sql.includes('INSERT INTO'));
        expect(insert?.sql).toMatch(/"rebuildGeneration" = COALESCE\(EXCLUDED\."rebuildGeneration", "KnowledgeChunkEmbedding"\."rebuildGeneration"\)/);
        expect(insert?.sql).toMatch(/"writeSeq" = EXCLUDED\."writeSeq"/);
    });
});

describe('a vector belongs to a chunk of the caller’s tenant, and the backend never reads chunk text', () => {
    it('refuses CHUNK_NOT_FOUND, and writes nothing, when a record names a chunk the tenant does not hold', async () => {
        chunks = [];
        const store = createPgvectorStore();
        const err = await store.upsert(CTX, [RECORD]).catch((e: unknown) => e);
        expect((err as VectorStoreError).reason).toBe('CHUNK_NOT_FOUND');
        expect(statements.some((s) => s.sql.includes('INSERT INTO'))).toBe(false);
        // The message names the model and position, never an id or text.
        expect((err as Error).message).not.toContain('pv1');
    });

    it('resolves the chunk in the caller’s tenant and inserts that chunk’s id, conflicting on (tenant, chunk, model)', async () => {
        const store = createPgvectorStore();
        await expect(store.upsert(CTX, [RECORD])).resolves.toEqual({ inserted: 1, updated: 0, unchanged: 0 });
        const resolve = statements.find((s) => s.sql.includes('LEFT JOIN'));
        expect(resolve?.sql).toMatch(/WHERE c\."tenantId" = \?/);
        expect(resolve?.values[resolve.values.length - 3]).toBe(CTX.tenantId);
        const insert = statements.find((s) => s.sql.includes('INSERT INTO'));
        expect(insert?.values).toContain('chunk-1');
        expect(insert?.sql).toMatch(/ON CONFLICT \("tenantId", "chunkId", "embeddingModel"\)/);
    });

    it('refuses CONTENT_HASH_MISMATCH, and writes nothing, when a vector was computed from text its chunk no longer holds', async () => {
        chunks = [{ ...chunks[0], chunkHash: 'e'.repeat(64) }];
        const store = createPgvectorStore();
        const err = await store.upsert(CTX, [RECORD]).catch((e: unknown) => e);
        expect((err as VectorStoreError).reason).toBe('CONTENT_HASH_MISMATCH');
        expect(statements.some((s) => s.sql.includes('INSERT INTO'))).toBe(false);
        expect((err as Error).message).not.toContain('pv1');
        // The chunk's hash is read beside its id, in the same resolve.
        const resolve = statements.find((s) => s.sql.includes('LEFT JOIN'));
        expect(resolve?.sql).toMatch(/c\."contentHash" AS "chunkHash"/);
    });

    it('counts a re-upsert of the same hash as unchanged and a moved hash as updated', async () => {
        chunks = [
            { chunkId: 'chunk-1', sourceModel: 'PolicyVersion', sourceId: 'pv1', chunkIndex: 0, chunkHash: RECORD.contentHash, prior: RECORD.contentHash },
            { chunkId: 'chunk-2', sourceModel: 'PolicyVersion', sourceId: 'pv1', chunkIndex: 1, chunkHash: RECORD.contentHash, prior: 'f'.repeat(64) },
        ];
        const store = createPgvectorStore();
        await expect(store.upsert(CTX, [RECORD, { ...RECORD, chunkIndex: 1 }])).resolves.toEqual({
            inserted: 0,
            updated: 1,
            unchanged: 1,
        });
    });

    it('no statement it sends reads or writes a text column', async () => {
        const store = createPgvectorStore();
        await store.upsert(CTX, [RECORD]);
        await store.search(CTX, { embeddingRevision: 'test-embed@3', embedding: [1, 0, 0], k: 5 });
        await store.listKeys(CTX, 'test-embed@3', 10);
        await store.listSourceKeys(CTX, 'test-embed@3', 'PolicyVersion', 'pv1', 10);
        await store.deleteSource(CTX, 'PolicyVersion', 'pv1');
        for (const s of statements) expect(s.sql).not.toMatch(/"text"/);
    });
});
