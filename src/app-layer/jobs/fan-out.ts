/**
 * Fan-out: enqueue one job per connection, idempotently and without letting one
 * bad enqueue cancel the rest.
 *
 * ## Two defects, and they compound
 *
 * Every dispatcher looked like this:
 *
 *     for (const conn of page) {
 *         await enqueue(job, { tenantId: conn.tenantId, connectionId: conn.id });
 *     }
 *
 * **No `jobId`.** BullMQ therefore treats every enqueue as new work, so any
 * re-run of the dispatcher — a retry, a redeploy replaying a schedule, an
 * operator kicking it manually — queues a second full sync for every
 * connection.
 *
 * **No failure isolation.** A single `enqueue` throw (Redis blip, connection
 * refused) aborts the whole loop. Every connection after it is silently never
 * dispatched, and the completion log still reads like a clean run because the
 * counters only count what got as far as being enqueued.
 *
 * Together they are worse than apart: the aborted dispatcher throws, BullMQ
 * retries it, and the retry re-enqueues everything that already succeeded —
 * duplicating the first half of the fan-out in order to reach the second.
 *
 * ## The bucket is the sharp edge
 *
 * A deterministic id is only safe if it CHANGES each scheduling period. BullMQ
 * dedupes against jobs still held in the completed/failed sets, so an id that
 * outlives its schedule interval does not merely dedupe a duplicate — it makes
 * the next legitimate run a silent no-op. A sync that stops running looks
 * exactly like a sync with nothing to do.
 *
 * So the id carries a time bucket, and the bucket MUST match the dispatcher's
 * cron period: daily jobs get a 24 h bucket, the 4-hourly SharePoint dispatcher
 * gets a 4 h one. `tests/guards/fan-out-bucket-matches-schedule.test.ts` derives
 * the period from `SCHEDULED_JOBS` and fails if the two drift apart — a cadence
 * change without a bucket change is precisely the edit that would break this
 * quietly.
 *
 * Erring the other way is safe: a bucket SHORTER than the cadence just means
 * fewer duplicates are caught, which is where we started.
 *
 * @see tests/unit/jobs-fan-out.test.ts
 */
import { logger } from '@/lib/observability/logger';
import { recordDispatchEnqueueFailed } from '@/lib/observability/integration-metrics';

/** One minute, in ms. Used by manual-trigger routes to collapse double-clicks. */
export const MINUTE_MS = 60_000;

/** One hour, in ms. Bucket sizes are expressed against this for readability. */
export const HOUR_MS = 3_600_000;

/** Daily dispatchers — identity-sync, hris-sync, cloud-posture, posture summary. */
export const DAILY_BUCKET_MS = 24 * HOUR_MS;

/** The 4-hourly SharePoint delta dispatcher. */
export const FOUR_HOURLY_BUCKET_MS = 4 * HOUR_MS;

/**
 * A stable job id for one (job, key) within one scheduling window.
 *
 * Flooring epoch-ms by the bucket aligns to UTC boundaries, which is what the
 * cron patterns use — a 24 h bucket rolls at 00:00 UTC, a 4 h bucket at
 * 00:00/04:00/08:00/… — so the bucket boundary and the schedule agree.
 *
 * The bucket is emitted as the raw floored epoch rather than a formatted date:
 * it is an opaque discriminator, and formatting invites someone to "improve" it
 * to a local-time string, which would shift the boundary by the server's offset.
 */
export function dispatchJobId(
    jobName: string,
    key: string,
    bucketMs: number,
    now: number = Date.now(),
): string {
    if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
        throw new Error(`dispatchJobId: bucketMs must be a positive number, got ${bucketMs}`);
    }
    // THE KEY MUST NOT CONTAIN A COLON, and this is not a style rule.
    //
    // BullMQ accepts a custom job id containing ':' ONLY when it splits into
    // exactly three parts — a back-compat carve-out for old repeatable ids:
    //
    //     if (jobId.includes(':') && jobId.split(':').length !== 3) throw
    //
    // This template contributes exactly two colons, so a caller passing a
    // composite key such as `${tenantId}:${provider}` produces four segments
    // and every enqueue throws `Custom Id cannot contain :`.
    //
    // That is not hypothetical. The leaver dispatch passed that exact key, so
    // from the day it was wired it reported `dispatched: 0, failed: 1` every
    // night and the scheduled leaver path never ran once. It looked healthy
    // from the outside: the schedule was registered, the worker was up, and a
    // MANUAL trigger — which passes no jobId — worked perfectly, which is what
    // the field walkthrough exercised.
    //
    // Normalised rather than rejected, deliberately. Throwing here converts a
    // silent nightly no-op into a loud nightly crash, which is better but still
    // broken; substituting a separator keeps the id stable, deterministic and
    // dedupe-correct, which is what the caller actually wanted.
    const safeKey = key.replace(/:/g, '_');
    return `${jobName}:${safeKey}:${Math.floor(now / bucketMs)}`;
}

export interface FanOutResult {
    /** Enqueued without throwing. Includes ones BullMQ deduped as already queued. */
    dispatched: number;
    /** Enqueues that threw. The fan-out continued past each of these. */
    failed: number;
}

/**
 * Enqueue one job per item, isolating failures.
 *
 * A throw from `enqueueOne` is logged and counted, and the loop continues — one
 * unreachable Redis moment or one malformed row must not silently drop every
 * connection behind it in the list.
 *
 * The caller decides what a partial failure means. `failed > 0 && dispatched
 * === 0` is the case worth failing the job over: nothing was dispatched, so
 * treating it as success would report a clean run that did nothing at all.
 */
export async function fanOut<T>(
    items: readonly T[],
    component: string,
    describe: (item: T) => Record<string, unknown>,
    enqueueOne: (item: T) => Promise<unknown>,
): Promise<FanOutResult> {
    let dispatched = 0;
    let failed = 0;

    for (const item of items) {
        try {
            await enqueueOne(item);
            dispatched++;
        } catch (err) {
            failed++;
            // Continuing past the failure is right, but it makes the loss
            // silent unless it is counted. A non-zero rate here means
            // connections that did not get a sync this cycle.
            recordDispatchEnqueueFailed({ component });
            logger.error('fan-out enqueue failed — continuing with the rest', {
                component,
                ...describe(item),
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    return { dispatched, failed };
}
