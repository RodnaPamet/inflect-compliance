/**
 * The `knowledge-index` job's body (vector store Phase 2.1), driven over an
 * in-memory stand-in for the tenant transaction and the in-process vector
 * backend, so every path is reachable without a database:
 *
 *   - BATCHING: 17 chunks reach the embedder as 3 calls of at most 8
 *     (`INDEX_EMBED_BATCH`, owner decision 2026-11-15).
 *   - IDEMPOTENCE: a second run over an unchanged source makes no embedding
 *     call and writes nothing (`UNCHANGED`).
 *   - FOLLOWS THE SOURCE: an edit re-embeds only the chunks whose text moved,
 *     a shorter source loses its tail, an unapproved or deleted one loses all.
 *   - FAILS CLOSED, NAMED: a store that is off, an embedding route that is not
 *     configured, a failing embedder — each a named outcome, none a success,
 *     and the first two read and write nothing.
 *
 * The real tables, RLS and the encryption extension are the integration
 * suite's (tests/integration/knowledge-index-job.test.ts).
 */

jest.mock('@/env', () => ({ env: {} }));

interface ChunkRow {
    id: string;
    tenantId: string;
    sourceModel: string;
    sourceId: string;
    chunkIndex: number;
    text: string;
    contentHash: string;
    chunkerRevision: string;
}

interface VersionRow {
    id: string;
    tenantId: string;
    contentType: 'MARKDOWN' | 'HTML' | 'EXTERNAL_LINK';
    contentText: string | null;
    approved: boolean;
    policyDeleted: boolean;
}

const db = {
    chunks: [] as ChunkRow[],
    versions: new Map<string, VersionRow>(),
    writes: 0,
    seq: 0,
};

function matches(row: ChunkRow, where: Record<string, unknown>): boolean {
    for (const [k, v] of Object.entries(where)) {
        if (v && typeof v === 'object' && 'in' in (v as object)) {
            if (!(v as { in: unknown[] }).in.includes((row as unknown as Record<string, unknown>)[k])) return false;
        } else if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
    }
    return true;
}

const tx = {
    $executeRaw: jest.fn(async () => 0),
    tenantSecuritySettings: { findUnique: jest.fn(async () => ({ aiResidency: 'EXTERNAL' })) },
    policyVersion: {
        findFirst: jest.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
            const v = db.versions.get(where.id);
            if (!v || v.tenantId !== where.tenantId) return null;
            return {
                contentType: v.contentType,
                contentText: v.contentText,
                policy: { deletedAt: v.policyDeleted ? new Date() : null },
                approvals: v.approved ? [{ id: 'appr' }] : [],
            };
        }),
    },
    knowledgeChunk: {
        findMany: jest.fn(async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
            db.chunks
                .filter((r) => matches(r, where))
                .sort((a, b) => a.chunkIndex - b.chunkIndex)
                .slice(0, take)
                .map(({ id, chunkIndex, text, contentHash, chunkerRevision }) => ({
                    id, chunkIndex, text, contentHash, chunkerRevision,
                })),
        ),
        deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
            const before = db.chunks.length;
            db.chunks = db.chunks.filter((r) => !matches(r, where));
            const count = before - db.chunks.length;
            db.writes += count;
            return { count };
        }),
        createMany: jest.fn(async ({ data }: { data: Omit<ChunkRow, 'id'>[] }) => {
            for (const d of data) db.chunks.push({ ...d, id: `chunk-${++db.seq}` });
            db.writes += data.length;
            return { count: data.length };
        }),
    },
};

jest.mock('@/lib/db/rls-middleware', () => ({
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (t: typeof tx) => unknown) => fn(tx)),
}));

import { createVectorRepository } from '@/app-layer/repositories/VectorRepository';
import { createInProcessVectorStore } from '@/app-layer/repositories/vector/in-process-store';
import { indexKnowledgeSource, MAX_CHUNKS_PER_SOURCE } from '@/app-layer/services/knowledge-index';
import {
    INDEX_EMBED_BATCH,
    StubEmbeddingProvider,
    type EmbedOptions,
    type EmbeddingResult,
} from '@/lib/ai/embeddings';
import { MAX_CHUNK_CHARS } from '@/lib/knowledge/paragraph-chunker';
import { isKnowledgeIndexSuccess } from '@/lib/knowledge/index-outcome';

const TENANT = 'tenant-knowledge-unit';

/** The stub, counting each call's batch size and input type. */
class CountingEmbedder extends StubEmbeddingProvider {
    readonly calls: Array<{ size: number; inputType: string }> = [];
    failWith: EmbeddingResult | null = null;
    async embed(texts: readonly string[], opts: EmbedOptions): Promise<EmbeddingResult> {
        this.calls.push({ size: texts.length, inputType: opts.inputType });
        if (this.failWith) return this.failWith;
        return super.embed(texts, opts);
    }
}

/** `n` paragraphs, each too long to pack with the next, so `n` chunks. */
function paragraphs(n: number, tag = 'p'): string {
    return Array.from({ length: n }, (_, i) => `${tag}${i} `.repeat(Math.floor(700 / `${tag}${i} `.length)).trim()).join('\n\n');
}

function version(id: string, text: string | null, over: Partial<VersionRow> = {}): void {
    db.versions.set(id, {
        id, tenantId: TENANT, contentType: 'MARKDOWN', contentText: text, approved: true, policyDeleted: false, ...over,
    });
}

let vectors = createVectorRepository(createInProcessVectorStore());
let embedder = new CountingEmbedder();
const deps = () => ({ vectors, embedder: () => ({ ok: true as const, provider: embedder }) });
const run = (sourceId: string, sourceModel = 'PolicyVersion') =>
    indexKnowledgeSource({ tenantId: TENANT, sourceModel, sourceId }, deps());
const ctx = { tenantId: TENANT } as Parameters<typeof vectors.listSourceKeys>[0];

beforeEach(() => {
    db.chunks = [];
    db.versions.clear();
    db.writes = 0;
    vectors = createVectorRepository(createInProcessVectorStore());
    embedder = new CountingEmbedder();
    jest.clearAllMocks();
});

describe('batching (INDEX_EMBED_BATCH = 8, owner decision 2026-11-15)', () => {
    it('the batch the index sends is 8', () => {
        expect(INDEX_EMBED_BATCH).toBe(8);
    });

    it('17 chunks become 3 embed calls of at most 8, every one a passage', async () => {
        version('pv-17', paragraphs(17));
        const r = await run('pv-17');
        expect(r.outcome).toBe('INDEXED');
        expect(r.chunks).toBe(17);
        expect(embedder.calls.map((c) => c.size)).toEqual([8, 8, 1]);
        expect(embedder.calls.every((c) => c.inputType === 'passage')).toBe(true);
        expect(r).toMatchObject({ embedded: 17, embedCalls: 3, chunksWritten: 17 });
        expect(await vectors.listSourceKeys(ctx, embedder.model, 'PolicyVersion', 'pv-17')).toHaveLength(17);
    });
});

describe('idempotence', () => {
    it('a second run over an unchanged source embeds nothing and writes nothing', async () => {
        version('pv-1', paragraphs(5));
        expect((await run('pv-1')).outcome).toBe('INDEXED');
        const callsAfterFirst = embedder.calls.length;
        const writesAfterFirst = db.writes;
        const keysAfterFirst = await vectors.listSourceKeys(ctx, embedder.model, 'PolicyVersion', 'pv-1');

        const second = await run('pv-1');
        expect(second).toMatchObject({ outcome: 'UNCHANGED', chunks: 5, chunksWritten: 0, chunksDeleted: 0, embedded: 0, embedCalls: 0 });
        expect(embedder.calls.length).toBe(callsAfterFirst);
        expect(db.writes).toBe(writesAfterFirst);
        expect(await vectors.listSourceKeys(ctx, embedder.model, 'PolicyVersion', 'pv-1')).toEqual(keysAfterFirst);
    });

    it('a run interrupted mid-way is finished by the next, which embeds only what is missing', async () => {
        version('pv-int', paragraphs(12));
        embedder.failWith = null;
        let n = 0;
        const realEmbed = embedder.embed.bind(embedder);
        embedder.embed = async (texts, opts) => (++n === 2 ? { ok: false, reason: 'TIMEOUT' } : realEmbed(texts, opts));
        const first = await run('pv-int');
        expect(first).toMatchObject({ outcome: 'EMBED_FAILED', embedFailure: 'TIMEOUT', transient: true, embedded: 8 });

        embedder = new CountingEmbedder();
        const second = await run('pv-int');
        expect(second).toMatchObject({ outcome: 'INDEXED', embedded: 4, chunksWritten: 0 });
        expect(embedder.calls.map((c) => c.size)).toEqual([4]);
    });
});

describe('the index follows the source', () => {
    it('an edit re-embeds only the chunks whose text moved, and a shorter source loses its tail', async () => {
        version('pv-e', paragraphs(6, 'a'));
        await run('pv-e');
        const parts = paragraphs(6, 'a').split('\n\n');
        parts[2] = parts[2].replace('a2', 'CHANGED');
        version('pv-e', parts.slice(0, 4).join('\n\n'));
        embedder = new CountingEmbedder();

        const r = await run('pv-e');
        expect(r).toMatchObject({ outcome: 'INDEXED', chunks: 4, chunksWritten: 1, chunksDeleted: 3, embedded: 1 });
        expect(embedder.calls.map((c) => c.size)).toEqual([1]);
        const rows = db.chunks.filter((c) => c.sourceId === 'pv-e').sort((a, b) => a.chunkIndex - b.chunkIndex);
        expect(rows.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3]);
        expect(rows[2].text).toContain('CHANGED');
        expect(rows.every((c) => c.chunkerRevision === 'paragraph@1')).toBe(true);
    });

    it.each([
        ['an unapproved version', { approved: false }, 'NOT_APPROVED'],
        ['a version of a soft-deleted policy', { policyDeleted: true }, 'PARENT_DELETED'],
        ['an external link', { contentType: 'EXTERNAL_LINK' as const }, 'NO_INLINE_TEXT'],
    ])('%s loses every chunk it had, and nothing is embedded', async (_label, over, reason) => {
        version('pv-x', paragraphs(3));
        await run('pv-x');
        expect(db.chunks).toHaveLength(3);
        version('pv-x', paragraphs(3), over);
        embedder = new CountingEmbedder();
        const r = await run('pv-x');
        expect(r).toMatchObject({ outcome: 'SOURCE_NOT_INDEXABLE', notIndexable: reason, chunksDeleted: 3 });
        expect(db.chunks).toHaveLength(0);
        expect(embedder.calls).toHaveLength(0);
    });

    it('a row that is gone is not indexable, and a source with no words yields no chunk', async () => {
        expect(await run('pv-missing')).toMatchObject({ outcome: 'SOURCE_NOT_INDEXABLE', notIndexable: 'GONE' });
        version('pv-blank', '---\n\n***');
        expect(await run('pv-blank')).toMatchObject({ outcome: 'SOURCE_NOT_INDEXABLE', notIndexable: 'NO_WORDS' });
        expect(embedder.calls).toHaveLength(0);
    });

    it('HTML is flattened to text, block ends becoming paragraph breaks', async () => {
        version('pv-h', `<h1>Access</h1><p>${'Reviews happen quarterly. '.repeat(40)}</p><p>${'Keys rotate yearly. '.repeat(40)}</p>`, {
            contentType: 'HTML',
        });
        const r = await run('pv-h');
        expect(r.outcome).toBe('INDEXED');
        for (const c of db.chunks) {
            expect(c.text).not.toMatch(/[<>]/);
            expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
        }
    });

    it('a source cutting into more than MAX_CHUNKS_PER_SOURCE chunks is refused whole, its old chunks removed', async () => {
        version('pv-big', paragraphs(2));
        await run('pv-big');
        version('pv-big', paragraphs(MAX_CHUNKS_PER_SOURCE + 1, 'z'));
        embedder = new CountingEmbedder();
        const r = await run('pv-big');
        expect(r).toMatchObject({ outcome: 'SOURCE_TOO_LARGE', chunks: MAX_CHUNKS_PER_SOURCE + 1 });
        expect(isKnowledgeIndexSuccess(r.outcome)).toBe(false);
        expect(db.chunks).toHaveLength(0);
        expect(embedder.calls).toHaveLength(0);
    });
});

describe('fails closed, and says why', () => {
    it('the store off: VECTOR_STORE_DISABLED, nothing read, nothing written', async () => {
        version('pv-off', paragraphs(2));
        const r = await indexKnowledgeSource(
            { tenantId: TENANT, sourceModel: 'PolicyVersion', sourceId: 'pv-off' },
            { vectors: null, embedder: () => ({ ok: true, provider: embedder }) },
        );
        expect(r.outcome).toBe('VECTOR_STORE_DISABLED');
        expect(isKnowledgeIndexSuccess(r.outcome)).toBe(false);
        expect(tx.policyVersion.findFirst).not.toHaveBeenCalled();
        expect(tx.tenantSecuritySettings.findUnique).not.toHaveBeenCalled();
        expect(db.writes).toBe(0);
    });

    it('the deployment store is off unless VECTOR_STORE_BACKEND=pgvector (the default here)', async () => {
        const r = await indexKnowledgeSource(
            { tenantId: TENANT, sourceModel: 'PolicyVersion', sourceId: 'pv-default' },
            { embedder: () => ({ ok: true, provider: embedder }) },
        );
        expect(r.outcome).toBe('VECTOR_STORE_DISABLED');
    });

    it('no embedding route: EMBEDDING_NOT_CONFIGURED with the route’s reason, the source never read', async () => {
        version('pv-noemb', paragraphs(2));
        const r = await indexKnowledgeSource(
            { tenantId: TENANT, sourceModel: 'PolicyVersion', sourceId: 'pv-noemb' },
            { vectors, embedder: () => ({ ok: false, reason: 'EMBED_ROUTE_NOT_CONFIGURED' }) },
        );
        expect(r).toMatchObject({ outcome: 'EMBEDDING_NOT_CONFIGURED', embedFailure: 'EMBED_ROUTE_NOT_CONFIGURED' });
        expect(tx.policyVersion.findFirst).not.toHaveBeenCalled();
        expect(db.writes).toBe(0);
    });

    it('the deployment route is unconfigured by default, and the residency is what it is asked with', async () => {
        version('pv-route', paragraphs(1));
        const r = await indexKnowledgeSource({ tenantId: TENANT, sourceModel: 'PolicyVersion', sourceId: 'pv-route' }, { vectors });
        expect(r).toMatchObject({ outcome: 'EMBEDDING_NOT_CONFIGURED', embedFailure: 'EMBED_ROUTE_NOT_CONFIGURED' });
        tx.tenantSecuritySettings.findUnique.mockResolvedValueOnce({ aiResidency: 'LOCAL_ONLY' });
        const local = await indexKnowledgeSource({ tenantId: TENANT, sourceModel: 'PolicyVersion', sourceId: 'pv-route' }, { vectors });
        expect(local.embedFailure).toBe('LOCAL_EMBED_ROUTE_NOT_CONFIGURED');
    });

    it('an unknown source model is refused by name', async () => {
        const r = await run('x', 'Risk');
        expect(r.outcome).toBe('UNKNOWN_SOURCE_MODEL');
        expect(isKnowledgeIndexSuccess(r.outcome)).toBe(false);
    });

    it('a non-transient embedding failure is EMBED_FAILED, not retryable, and the chunks stay for the next run', async () => {
        version('pv-fail', paragraphs(3));
        embedder.failWith = { ok: false, reason: 'SERVED_MODEL_MISMATCH' };
        const r = await run('pv-fail');
        expect(r).toMatchObject({ outcome: 'EMBED_FAILED', embedFailure: 'SERVED_MODEL_MISMATCH', transient: false, embedded: 0 });
        expect(db.chunks).toHaveLength(3);
    });

    it('vectors that answer for a different model than the provider declares are refused', async () => {
        version('pv-model', paragraphs(1));
        const realEmbed = embedder.embed.bind(embedder);
        embedder.embed = async (texts, opts) => {
            const res = await realEmbed(texts, opts);
            return res.ok ? { ...res, model: 'some-other-model' } : res;
        };
        const r = await run('pv-model');
        expect(r).toMatchObject({ outcome: 'EMBED_FAILED', embedFailure: 'SERVED_MODEL_MISMATCH' });
        expect(await vectors.listSourceKeys(ctx, embedder.model, 'PolicyVersion', 'pv-model')).toEqual([]);
    });
});
