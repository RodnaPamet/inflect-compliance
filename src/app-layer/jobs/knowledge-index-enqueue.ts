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
import { vectorStoreEnabled } from '@/app-layer/repositories/vector-store-switch';
import type { RequestContext } from '@/app-layer/types';
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

/** Both switches on? The same two questions the job asks first, without a tenant read. */
function indexIsOn(): KnowledgeIndexEnqueueResult | null {
    if (!vectorStoreEnabled()) return { enqueued: false, reason: 'VECTOR_STORE_DISABLED' };
    if (!resolveEmbeddingRoute().ok) return { enqueued: false, reason: 'EMBEDDING_NOT_CONFIGURED' };
    return null;
}

/**
 * The most approved versions one policy-level change re-indexes. A policy
 * gains one approved version per review cycle; past this the change re-indexes
 * the newest and logs that it stopped, and `scripts/knowledge-reindex.ts` is
 * the tool for the rest.
 */
export const MAX_POLICY_VERSIONS_PER_ENQUEUE = 200;

/**
 * Re-index every APPROVED version of these policies — after a change to the
 * policy rather than to one version: a soft delete (the job then removes their
 * chunks, `PARENT_DELETED`) or a restore (the job puts them back). Reads
 * nothing while the index is off.
 */
export async function enqueueKnowledgeIndexForPolicies(
    ctx: RequestContext,
    policyIds: readonly string[],
): Promise<{ enqueued: number; skipped?: KnowledgeIndexEnqueueResult }> {
    const off = indexIsOn();
    if (off) return { enqueued: 0, skipped: off };
    if (policyIds.length === 0) return { enqueued: 0 };
    let rows: Array<{ policyVersionId: string }>;
    try {
        // Loaded only when the index is on: this module sits on usecases'
        // write paths, and the database client is theirs to load, not ours.
        const { runInTenantContext } = await import('@/lib/db/rls-middleware');
        rows = await runInTenantContext(ctx, (db) =>
            db.policyApproval.findMany({
                where: { tenantId: ctx.tenantId, policyId: { in: [...policyIds] }, status: 'APPROVED' },
                select: { policyVersionId: true },
                distinct: ['policyVersionId'],
                orderBy: { policyVersionId: 'asc' },
                take: MAX_POLICY_VERSIONS_PER_ENQUEUE * policyIds.length + 1,
            }),
        );
    } catch (err) {
        // The caller's write has committed: a read that failed here is a stale
        // index, never a failed write (see the module header).
        logger.warn('knowledge_index.enqueue_failed', {
            component: 'knowledge-index',
            tenantId: ctx.tenantId,
            policies: policyIds.length,
            error: err instanceof Error ? err.message : String(err),
        });
        return { enqueued: 0, skipped: { enqueued: false, reason: 'QUEUE_ERROR' } };
    }
    const versionIds = rows.map((r) => r.policyVersionId);
    if (versionIds.length > MAX_POLICY_VERSIONS_PER_ENQUEUE * policyIds.length) {
        logger.warn('knowledge_index.enqueue_truncated', {
            component: 'knowledge-index',
            tenantId: ctx.tenantId,
            policies: policyIds.length,
            cap: MAX_POLICY_VERSIONS_PER_ENQUEUE * policyIds.length,
        });
        versionIds.length = MAX_POLICY_VERSIONS_PER_ENQUEUE * policyIds.length;
    }
    let enqueued = 0;
    for (const sourceId of versionIds) {
        const r = await enqueueKnowledgeIndex({
            tenantId: ctx.tenantId,
            sourceModel: 'PolicyVersion',
            sourceId,
            requestId: ctx.requestId,
        });
        if (r.enqueued) enqueued += 1;
    }
    return { enqueued };
}

export async function enqueueKnowledgeIndex(input: {
    tenantId: string;
    sourceModel: KnowledgeSourceModel;
    sourceId: string;
    requestId?: string;
}): Promise<KnowledgeIndexEnqueueResult> {
    const off = indexIsOn();
    if (off) return off;
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
