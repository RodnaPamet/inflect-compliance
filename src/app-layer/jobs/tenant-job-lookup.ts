/**
 * Look up a queued job for a tenant's status route.
 *
 * Every job type shares one BullMQ queue, and a job enqueued without an
 * explicit id gets the next integer. A status route that answered for any
 * id would therefore answer for any job on the queue. This returns the job
 * only when it is the route's own kind (`name`) AND its payload names the
 * caller's tenant. A job with no tenant in its payload (a platform-wide
 * sweep) is never a tenant's. Anything else is reported as absent, the same
 * answer as an id that does not exist, so a caller cannot tell them apart.
 *
 * @module app-layer/jobs/tenant-job-lookup
 */
import type { Job } from 'bullmq';
import { getQueue } from './queue';
import type { JobName } from './types';

export async function findTenantJob(
    jobId: string,
    tenantId: string,
    name: JobName,
): Promise<Job | null> {
    const job = await getQueue().getJob(jobId);
    if (!job || job.name !== name) return null;
    const payload = job.data as { tenantId?: unknown } | null | undefined;
    if (typeof payload?.tenantId !== 'string' || payload.tenantId !== tenantId) return null;
    return job;
}
