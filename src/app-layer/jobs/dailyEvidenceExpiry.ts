/**
 * Daily evidence expiry notification job.
 *
 * Sweeps at three urgency thresholds (30, 7, 1 days) to enqueue
 * emails for expiring evidence. Then flushes the outbox.
 *
 * Usage:
 *   npx tsx scripts/notifications-runner.ts
 *   # or import directly:
 *   import { runDailyEvidenceExpiryNotifications } from '@/app-layer/jobs/dailyEvidenceExpiry';
 *   await runDailyEvidenceExpiryNotifications();
 */

import { runEvidenceRetentionNotifications, type RetentionNotificationResult } from './retention-notifications';
import { processOutbox, type ProcessOutboxResult } from '../notifications/processOutbox';
import { runJob } from '@/lib/observability/job-runner';
import { logger } from '@/lib/observability/logger';

export interface DailyExpiryResult {
    sweeps: {
        days30: RetentionNotificationResult;
        days7: RetentionNotificationResult;
        days1: RetentionNotificationResult;
    };
    outbox: ProcessOutboxResult;
}

/** One urgency threshold's sweep, and the error it threw. */
export interface SweepFailure {
    /** The threshold in days — 30, 7 or 1. */
    days: number;
    /** The thrown error's message, as it will reach the operator. */
    error: string;
}

/**
 * Thrown when at least one evidence sweep failed.
 *
 * The job still FAILS when a sweep throws — that has not changed and must not.
 * What changed is WHEN it fails: the outbox flush now happens first, so the
 * error carries a flush that already ran rather than replacing it. The message
 * says so explicitly, because the question an operator brings to a failed
 * `daily-evidence-expiry` at 06:05 is "did the 05:00 leaver mail go out?", and
 * before this the answer was silently no.
 */
export class EvidenceSweepFailedError extends Error {
    constructor(
        readonly failures: readonly SweepFailure[],
        readonly outbox: ProcessOutboxResult,
        readonly outboxFlushed: boolean,
    ) {
        const detail = failures.map((f) => `${f.days}d: ${f.error}`).join('; ');
        const flush = outboxFlushed
            ? `outbox still flushed (${outbox.sent} sent, ${outbox.failed} failed, ${outbox.skipped} skipped)`
            : 'outbox flush was skipped by the caller';
        super(`${failures.length} of 3 evidence sweeps failed — ${detail}. The ${flush}.`);
        this.name = 'EvidenceSweepFailedError';
    }
}

/**
 * The placeholder a caught sweep yields so the remaining sweeps can carry on.
 *
 * AND THAT IS ALL IT IS — an earlier version of this comment claimed these zeros
 * "contribute to the aggregate", which is not observable. The aggregate is only
 * returned when NO sweep failed; the moment one throws, this job raises
 * EvidenceSweepFailedError instead, and the registry's catch reports
 * itemsScanned/Actioned/Skipped as 0 with no details blob at all. So nothing an
 * operator reads ever shows these values.
 *
 * What IS real, and what the test below actually covers, is that a throwing
 * sweep does not cancel its siblings: the 7-day and 1-day sweeps still run and
 * still persist their tasks after the 30-day sweep throws. That behaviour is
 * the reason this constant exists; the reporting story was fiction.
 */
const NO_SWEEP: RetentionNotificationResult = { scanned: 0, tasksCreated: 0, skippedDuplicate: 0 };

export async function runDailyEvidenceExpiryNotifications(
    options: { tenantId?: string; skipOutbox?: boolean } = {},
): Promise<DailyExpiryResult> {
    return runJob('daily-evidence-expiry', async () => {
        const failures: SweepFailure[] = [];

        /**
         * Run ONE sweep, and absorb its throw.
         *
         * The three sweeps used to be three bare `await`s with the outbox
         * flush below them, which made this job's real shape "flush the
         * outbox, unless any evidence query throws first". The outbox is the
         * delivery path for EVERY notification in the product, so a failure in
         * the 7-day evidence scan silently withheld the 05:00 leaver mail, the
         * task reminders and the access-review nudges for another 24 hours.
         * Nothing linked the two subsystems except the order of these lines.
         *
         * Catching per sweep is what breaks that link. It is NOT a decision to
         * tolerate a failing sweep: every failure is recorded here, logged at
         * error, and re-thrown once the flush is done — see
         * `EvidenceSweepFailedError`. Isolating them individually (rather than
         * wrapping all three in one try) also means the 30-day sweep throwing
         * no longer costs us the 7-day and 1-day sweeps, which are independent
         * queries over different rows.
         */
        const sweep = async (days: number): Promise<RetentionNotificationResult> => {
            try {
                const result = await runEvidenceRetentionNotifications({ days, tenantId: options.tenantId });
                logger.info('expiry sweep completed', { component: 'job', threshold: days, tasksCreated: result.tasksCreated, skipped: result.skippedDuplicate });
                return result;
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                failures.push({ days, error: message });
                // Logged HERE as well as re-thrown below, because the throw
                // carries one aggregate message while this line carries the
                // per-threshold detail a responder greps for.
                logger.error('expiry sweep failed', { component: 'job', threshold: days, error: message });
                return NO_SWEEP;
            }
        };

        // Sweep at three urgency thresholds
        const days30 = await sweep(30);
        const days7 = await sweep(7);
        const days1 = await sweep(1);

        // Flush outbox.
        //
        // Reached whether or not the sweeps above succeeded — that is the whole
        // point of the guards. It is NOT itself guarded: a flush that throws is
        // this job's own failure with nothing downstream of it to protect, and
        // swallowing it would hide the one error this job is now responsible
        // for reporting.
        let outbox: ProcessOutboxResult = { sent: 0, failed: 0, skipped: 0 };
        if (!options.skipOutbox) {
            outbox = await processOutbox({ limit: 200 });
            logger.info('outbox flushed', { component: 'job', sent: outbox.sent, failed: outbox.failed, skipped: outbox.skipped });
        }

        // Fail AFTER the flush, not instead of it. `runJob` records the failure
        // metric and reports to Sentry, the executor registry turns the throw
        // into `success: false`, and BullMQ retries — exactly as before. The
        // only difference is that the mail left first.
        if (failures.length > 0) {
            throw new EvidenceSweepFailedError(failures, outbox, !options.skipOutbox);
        }

        return { sweeps: { days30, days7, days1 }, outbox };
    }, { tenantId: options.tenantId });
}
