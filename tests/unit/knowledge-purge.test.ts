/**
 * What a hard delete takes from the knowledge store (vector store Phase 2.2).
 * The SQL each purge path sends, and the paths that must send none — every
 * other soft-delete model, and a row with no tenant. The behaviour against the
 * real tables is tests/integration/knowledge-index-policy-source.test.ts.
 */
import { SOFT_DELETE_MODELS } from '@/lib/soft-delete';
import { deleteKnowledgeOfPurgedRow, purgeTakesKnowledge } from '@/app-layer/services/knowledge-purge';
import { KNOWLEDGE_SOURCE_MODELS } from '@/app-layer/services/knowledge-sources';

function recorder() {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    return {
        calls,
        db: {
            $executeRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
                calls.push({ sql, values });
                return 3;
            }),
        },
    };
}

describe('deleteKnowledgeOfPurgedRow', () => {
    it('a purged policy takes its versions’ chunks, in its own tenant, by bound parameters', async () => {
        const { db, calls } = recorder();
        await expect(deleteKnowledgeOfPurgedRow(db, 'Policy', 'tenant-1', 'pol-1')).resolves.toBe(3);
        expect(calls).toHaveLength(1);
        const [{ sql, values }] = calls;
        expect(values).toEqual(['tenant-1', 'pol-1']);
        expect(sql).toMatch(/^DELETE FROM "KnowledgeChunk" WHERE "tenantId" = \$1 AND "sourceModel" = 'PolicyVersion'/);
        expect(sql).toMatch(/SELECT "id" FROM "PolicyVersion" WHERE "tenantId" = \$1 AND "policyId" = \$2/);
        expect(sql).not.toContain('pol-1');
        expect(sql).not.toContain('KnowledgeChunkEmbedding');
    });

    it('a purged policy version takes its own chunks', async () => {
        const { db, calls } = recorder();
        await deleteKnowledgeOfPurgedRow(db, 'PolicyVersion', 'tenant-1', 'pv-1');
        expect(calls[0].sql).toMatch(/"sourceModel" = 'PolicyVersion' AND "sourceId" = \$2$/);
        expect(calls[0].values).toEqual(['tenant-1', 'pv-1']);
    });

    it('every other soft-delete model, and a row with no tenant, sends no statement', async () => {
        const { db, calls } = recorder();
        for (const model of SOFT_DELETE_MODELS) {
            if (model === 'Policy') continue;
            await expect(deleteKnowledgeOfPurgedRow(db, model, 'tenant-1', 'x')).resolves.toBe(0);
        }
        await expect(deleteKnowledgeOfPurgedRow(db, 'Policy', null, 'x')).resolves.toBe(0);
        expect(calls).toEqual([]);
    });

    it('every knowledge source model is something a purge knows how to remove', () => {
        for (const model of KNOWLEDGE_SOURCE_MODELS) expect(purgeTakesKnowledge(model)).toBe(true);
    });
});
