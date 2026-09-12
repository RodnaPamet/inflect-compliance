/**
 * Notification outbox flush — the outbox's own scheduled drain.
 *
 * ## Why this job exists
 *
 * `processOutbox` is the last step of every notification path in the product:
 * a digest, a task-due reminder, an access-review nudge, and — since
 * 2026-09-12 — the mail that tells a manager a leaver's directory account has
 * been disabled. Enqueuing a row is cheap and happens with the event that
 * caused it; DELIVERING it happens only when something calls this drain.
 *
 * Until this job, the only SCHEDULED caller was the tail of
 * `daily-evidence-expiry` at 06:00 UTC, after three evidence sweeps. Two
 * consequences followed, and neither was visible from the outbox itself:
 *
 *   1. Anything enqueued outside that one minute waited for it. The leaver
 *      pass runs at 05:00, so its mail sat for an hour on a good day.
 *   2. A throw in any of the three sweeps skipped the flush entirely — the
 *      awaits were unguarded — so the 05:00 mail then waited for TOMORROW's
 *      06:00 tick. Roughly 25 hours, decided by an evidence job that has
 *      nothing to do with notifications.
 *
 * A manual per-tenant drain has always existed (the "Process Outbox" button on
 * the notification-settings page), so this was a scheduling gap rather than a
 * total absence. But it is a gap an operator can only close by already knowing
 * the mail is stuck, which is the thing the mail was supposed to tell them.
 *
 * ## Why a short cadence is safe
 *
 * The outbox is durably idempotent per recipient: `NotificationOutbox` carries
 * a unique `dedupeKey`, and `processOutbox` CLAIMS each row with a conditional
 * `updateMany` predicated on `(status PENDING, attempts unchanged)` before it
 * sends. Two overlapping passes therefore cannot both send the same row — the
 * loser's claim matches zero rows and it moves on. So a ten-minute cadence
 * costs one indexed query per tick when there is nothing to do, and duplicates
 * nothing when there is.
 *
 * ## What this job deliberately does NOT do
 *
 * It does not enqueue anything. Every row it sends was written by whatever
 * subsystem decided a human needed telling. If this job finds an empty queue
 * that is a fact about the enqueuers, not a failure here — which is why an
 * empty pass returns zeros and succeeds rather than reporting a problem.
 *
 * @module app-layer/jobs/notification-outbox-flush
 */

import { processOutbox, type ProcessOutboxResult } from '../notifications/processOutbox';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';

/**
 * Rows drained per pass when the caller names no limit.
 *
 * Bounded on purpose: one pass must not become an unbounded loop over a
 * backlog, because each row is an SMTP round trip and the worker's other jobs
 * queue behind it. At a ten-minute cadence this ceiling is 200 messages every
 * ten minutes — far above any volume this product generates, while still
 * capping the worst single pass. A backlog deeper than the ceiling drains
 * across consecutive ticks rather than in one long-running job.
 *
 * Matches the limit `daily-evidence-expiry` has always passed, so moving the
 * drain onto its own schedule changes the cadence and nothing else.
 */
export const OUTBOX_FLUSH_LIMIT = 200;

export interface NotificationOutboxFlushOptions {
    /**
     * Restrict the drain to one tenant.
     *
     * Absent — which is what the schedule passes — drains every tenant, and
     * that is correct for a platform-level job. Any caller acting on behalf of
     * ONE tenant must pass it: `processOutbox` without a tenant sends every
     * other tenant's queued mail.
     */
    tenantId?: string;
    /** Override {@link OUTBOX_FLUSH_LIMIT} for an operator-driven catch-up run. */
    limit?: number;
}

/**
 * Drain the notification outbox once.
 *
 * Wrapped in `runJob` for the same reason every other job is: it is what puts
 * a jobRunId on the log lines, opens the trace span, and reports a failure to
 * Sentry. Without it a stuck outbox is invisible in exactly the way this job
 * exists to fix.
 */
export async function runNotificationOutboxFlush(
    options: NotificationOutboxFlushOptions = {},
): Promise<ProcessOutboxResult> {
    return runJob('notification-outbox-flush', async () => {
        const result = await processOutbox({
            limit: options.limit ?? OUTBOX_FLUSH_LIMIT,
            tenantId: options.tenantId,
        });

        logger.info('outbox flushed', {
            component: 'job',
            sent: result.sent,
            failed: result.failed,
            skipped: result.skipped,
            tenantId: options.tenantId,
        });

        return result;
    }, { tenantId: options.tenantId });
}
