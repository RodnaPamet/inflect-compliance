/**
 * GET /api/t/[tenantSlug]/evidence/imports/[jobId] — Epic 43.3
 *
 * Polled by the upload modal so the operator can watch the bulk
 * import progress without waiting for completion. Returns the
 * BullMQ job state + (when running) the live progress counters
 * forwarded by the executor's `updateProgress` callback.
 *
 * Tenant scoping: a job's payload carries `tenantId`, so we refuse
 * to surface a job that belongs to a different tenant — even when
 * the URL otherwise authenticates. Without this check, an
 * adversarial user could probe for sibling-tenant job ids by URL
 * fuzzing.
 */

import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { findTenantJob } from '@/app-layer/jobs/tenant-job-lookup';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; jobId: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        if (!ctx.appPermissions.evidence.upload) {
            return jsonResponse(
                { error: 'evidence.upload permission required' },
                { status: 403 },
            );
        }

        // Only this tenant's own evidence-import job is reported. Another
        // tenant's job, or another kind of job on the shared queue, is the
        // same 404 as an id that does not exist.
        const job = await findTenantJob(params.jobId, ctx.tenantId, 'evidence-import');
        if (!job) {
            return jsonResponse(
                { error: 'Job not found' },
                { status: 404 },
            );
        }

        const state = await job.getState();
        const progress = job.progress;
        const returnvalue = job.returnvalue ?? null;
        const failedReason = job.failedReason ?? null;

        return jsonResponse({
            jobId: job.id,
            state,
            progress,
            // BullMQ's `returnvalue` is the executor's makeResult
            // payload — completed jobs ship the full counters here.
            result: returnvalue,
            failedReason,
        });
    },
);
