/**
 * KnowledgeChunk rows — the only copy of chunk text (D-L4-2), written by the
 * index pipeline (vector store Phase 2, `docs/ai-architecture/weaviate.md`).
 *
 * Every method takes the caller's transaction (inside `runInTenantContext`, so
 * RLS applies and `text` passes the encryption extension) and the request
 * context, and filters on `ctx.tenantId` as well. No method takes a tenant id.
 *
 * The embeddings are not this module's business: they live behind
 * `VectorRepository`, and a chunk's embeddings leave with it by
 * `ON DELETE CASCADE` (the composite `(chunkId, tenantId)` foreign key).
 *
 * ── A changed chunk is REPLACED, never updated in place ────────────────
 *
 * When the text at a position changes, the old row is deleted and a new one
 * inserted. The cascade then takes every embedding model's vector of the old
 * text with it, so no vector of any model is ever left beside text it was not
 * computed from. Updating the row would keep the other models' vectors, with
 * a `contentHash` that no longer matches, until somebody re-embedded them.
 */
import { Prisma } from '@prisma/client';
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';

/** A chunk as the indexer wants it to be. */
export interface DesiredChunk {
    readonly chunkIndex: number;
    readonly text: string;
    readonly contentHash: string;
}

/** A stored chunk, text decrypted. */
export interface StoredChunk extends DesiredChunk {
    readonly id: string;
    readonly chunkerRevision: string;
}

export interface ChunkReconcileOutcome {
    /** Positions whose text, hash and chunker were already as desired. */
    kept: number;
    /** Rows inserted: new positions, and positions whose text changed. */
    written: number;
    /** Rows deleted: positions the source no longer has, and replaced positions. */
    deleted: number;
}

export class KnowledgeChunkRepository {
    /**
     * Serialise every chunk write for ONE source, for the rest of the caller's
     * transaction. Two index runs of one source (an approval and a retry) then
     * re-cut it one after the other, each from the source as it reads under
     * the lock, so the later read is the one left standing. The key pair is
     * kept apart from the vector store's `knowledge-vector:` locks by its
     * first half.
     */
    static async lockSource(db: PrismaTx, ctx: RequestContext, sourceModel: string, sourceId: string): Promise<void> {
        await db.$executeRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`knowledge-chunk:${ctx.tenantId}`}), hashtext(${`${sourceModel}:${sourceId}`}))`,
        );
    }

    /** One source's chunks in position order, at most `take`. */
    static async listForSource(
        db: PrismaTx,
        ctx: RequestContext,
        sourceModel: string,
        sourceId: string,
        take: number,
    ): Promise<StoredChunk[]> {
        return db.knowledgeChunk.findMany({
            where: { tenantId: ctx.tenantId, sourceModel, sourceId },
            select: { id: true, chunkIndex: true, text: true, contentHash: true, chunkerRevision: true },
            orderBy: { chunkIndex: 'asc' },
            take,
        });
    }

    /**
     * Make one source's stored chunks exactly `desired`, cut by
     * `chunkerRevision`: keep a position whose hash and chunker match, replace
     * one whose do not, insert new positions, delete positions past the end.
     * `existing` is the caller's read of the source's rows in this transaction.
     */
    static async reconcileSource(
        db: PrismaTx,
        ctx: RequestContext,
        sourceModel: string,
        sourceId: string,
        chunkerRevision: string,
        desired: readonly DesiredChunk[],
        existing: readonly StoredChunk[],
    ): Promise<ChunkReconcileOutcome> {
        const want = new Map(desired.map((c) => [c.chunkIndex, c]));
        const stale: string[] = [];
        const keptIndexes = new Set<number>();
        for (const row of existing) {
            const d = want.get(row.chunkIndex);
            if (d && d.contentHash === row.contentHash && row.chunkerRevision === chunkerRevision) {
                keptIndexes.add(row.chunkIndex);
            } else {
                stale.push(row.id);
            }
        }
        if (stale.length > 0) {
            await db.knowledgeChunk.deleteMany({ where: { tenantId: ctx.tenantId, id: { in: stale } } });
        }
        const fresh = desired.filter((c) => !keptIndexes.has(c.chunkIndex));
        if (fresh.length > 0) {
            await db.knowledgeChunk.createMany({
                data: fresh.map((c) => ({
                    tenantId: ctx.tenantId,
                    sourceModel,
                    sourceId,
                    chunkIndex: c.chunkIndex,
                    text: c.text,
                    contentHash: c.contentHash,
                    chunkerRevision,
                })),
            });
        }
        return { kept: keptIndexes.size, written: fresh.length, deleted: stale.length };
    }

    /** Delete one source's chunks (and, by cascade, every vector of them). */
    static async deleteForSource(
        db: PrismaTx,
        ctx: RequestContext,
        sourceModel: string,
        sourceId: string,
    ): Promise<number> {
        const { count } = await db.knowledgeChunk.deleteMany({
            where: { tenantId: ctx.tenantId, sourceModel, sourceId },
        });
        return count;
    }
}
