/**
 * #5317 — prepare an AGENT access review's reviewer packs off the request.
 *
 * A campaign's packs are prepared by one workflow run per page of
 * `PACK_PAGE_SIZE` agents, every run before the one write, so a large campaign
 * held its request for minutes. `requestAgentReviewPacks` prepares a campaign
 * of up to `SYNC_PACK_RUN_LIMIT` runs inside the request and hands a larger
 * one to this job, which runs the same `prepareAgentReviewPacks` and reports
 * its progress to the page through BullMQ (`readAgentPackPreparation`).
 *
 * The job runs AS THE PERSON WHO ASKED, re-read when it runs
 * (`resolveInitiatorContext`: their membership now, custom role included, and
 * a refusal for a soft-deleted workspace) — never a system context with
 * borrowed authority. Every refusal the request asked is asked again here, by
 * the same code: the requester must still be an ACTIVE member holding
 * `access_reviews.create` and the admin tier, be a person, and the campaign
 * and both preparers must still qualify. A refusal FAILS the job with its
 * sentence, which the page shows, and writes nothing.
 *
 * @module app-layer/jobs/agent-recert-pack-preparation
 */
import { runJob } from '@/lib/observability/job-runner';
import { resolveInitiatorContext } from '@/app-layer/context-system';
import {
    AGENT_RECERT_PACKS_JOB,
    prepareAgentReviewPacksForRequester,
    type PackPreparationProgress,
    type PreparePacksResult,
} from '@/app-layer/usecases/access-review-agent';
import type { AgentRecertPacksPreparePayload } from './types';

export async function runAgentRecertPackPreparation(
    payload: AgentRecertPacksPreparePayload,
    onProgress?: (progress: PackPreparationProgress) => Promise<void> | void,
): Promise<PreparePacksResult> {
    return runJob(AGENT_RECERT_PACKS_JOB, async () => {
        const ctx = await resolveInitiatorContext({
            tenantId: payload.tenantId,
            userId: payload.requestedByUserId,
            requestId: payload.requestId ?? `agent-recert-packs-${payload.accessReviewId}`,
        });
        return prepareAgentReviewPacksForRequester(ctx, payload.accessReviewId, { onProgress });
    }, { tenantId: payload.tenantId });
}
