/**
 * Enqueue the `knowledge-index` job for one source row (vector store Phase
 * 2.2, `docs/ai-architecture/weaviate.md`).
 *
 * Called by a source's write path AFTER its transaction commits, so the job
 * reads the committed row; never from inside the transaction, where a job
 * could run before the commit and read the old text, or after a rollback and
 * index text that was never stored.
 *
 * ── Off means nothing is enqueued ───────────────────────────────────────
 *
 * With the vector store off (`VECTOR_STORE_BACKEND` is not `pgvector`) or no
 * embedding route configured (`AI_EMBED_LOCAL_*`), this returns without
 * touching the queue, so a deployment that has not turned the index on pays
 * nothing on the write path and fills no failed set. The job asks the same two
 * questions again, per tenant residency, before it reads anything.
 *
 * ── Never fails the write ───────────────────────────────────────────────
 *
 * The caller's write has committed; an index that could not be queued is a
 * stale index, not a failed write. A queue error is logged and returned, never
 * thrown, and `scripts/knowledge-reindex.ts` rebuilds from the stored chunks.
 *
 * @module app-layer/jobs/knowledge-index-enqueue
 */
import { getVectorRepository } from '@/app-layer/repositories/VectorRepository';
import { resolveEmbeddingRoute } from '@/lib/ai/embeddings';
import { logger } from '@/lib/observability/logger';
import type { KnowledgeSourceModel } from '../services/knowledge-sources';
import { enqueue } from './queue';

export type KnowledgeIndexEnqueueResult =
    | { readonly enqueued: true }
    | {
          readonly enqueued: false;
          readonly reason: 'VECTOR_STORE_DISABLED' | 'EMBEDDING_NOT_CONFIGURED' | 'QUEUE_ERROR';
      };

export async function enqueueKnowledgeIndex(input: {
    tenantId: string;
    sourceModel: KnowledgeSourceModel;
    sourceId: string;
    requestId?: string;
}): Promise<KnowledgeIndexEnqueueResult> {
    if (!getVectorRepository()) return { enqueued: false, reason: 'VECTOR_STORE_DISABLED' };
    if (!resolveEmbeddingRoute().ok) return { enqueued: false, reason: 'EMBEDDING_NOT_CONFIGURED' };
    try {
        await enqueue('knowledge-index', {
            tenantId: input.tenantId,
            sourceModel: input.sourceModel,
            sourceId: input.sourceId,
            requestId: input.requestId,
        });
        return { enqueued: true };
    } catch (err) {
        logger.warn('knowledge_index.enqueue_failed', {
            component: 'knowledge-index',
            tenantId: input.tenantId,
            sourceModel: input.sourceModel,
            sourceId: input.sourceId,
            error: err instanceof Error ? err.message : String(err),
        });
        return { enqueued: false, reason: 'QUEUE_ERROR' };
    }
}
