/**
 * `knowledge-index` — index one source row into the knowledge store (vector
 * store Phase 2.1, `docs/ai-architecture/weaviate.md`; G8: worker only,
 * `runJob`, resumable).
 *
 * On demand, never scheduled: the unit is one source row whose text changed,
 * enqueued by `enqueueKnowledgeIndex` (`./knowledge-index-enqueue.ts`) after
 * the write that changed it commits. The body is
 * `indexKnowledgeSourceObserved` (`services/knowledge-index.ts`), which says
 * what a run does and why each outcome is what it is.
 *
 * Dormant by default (G9): with `VECTOR_STORE_BACKEND` unset, or no
 * `AI_EMBED_LOCAL_*`, nothing enqueues the job, and a run that reaches the
 * worker anyway reads and writes nothing and reports `VECTOR_STORE_DISABLED`
 * or `EMBEDDING_NOT_CONFIGURED` — a failure, named, never a success.
 *
 * @module app-layer/jobs/knowledge-index
 */
import { runJob } from '@/lib/observability/job-runner';
import {
    indexKnowledgeSourceObserved,
    type KnowledgeIndexDeps,
    type KnowledgeIndexResult,
} from '../services/knowledge-index';
import type { KnowledgeIndexPayload } from './types';

export async function runKnowledgeIndexJob(
    payload: KnowledgeIndexPayload,
    deps: KnowledgeIndexDeps = {},
): Promise<KnowledgeIndexResult> {
    return runJob(
        'knowledge-index',
        () =>
            indexKnowledgeSourceObserved(
                { tenantId: payload.tenantId, sourceModel: payload.sourceModel, sourceId: payload.sourceId },
                deps,
            ),
        { tenantId: payload.tenantId },
    );
}
