/**
 * Unit tests for notification jobs — daily evidence expiry sweep and runner.
 */

// Mock the retention-notifications module
jest.mock('@/app-layer/jobs/retention-notifications', () => ({
    runEvidenceRetentionNotifications: jest.fn(),
}));

// Mock processOutbox
jest.mock('@/app-layer/notifications/processOutbox', () => ({
    processOutbox: jest.fn(),
}));

import { runEvidenceRetentionNotifications } from '@/app-layer/jobs/retention-notifications';
import { processOutbox } from '@/app-layer/notifications/processOutbox';
import { runDailyEvidenceExpiryNotifications, EvidenceSweepFailedError } from '@/app-layer/jobs/dailyEvidenceExpiry';

const mockedRetention = runEvidenceRetentionNotifications as jest.MockedFunction<typeof runEvidenceRetentionNotifications>;
const mockedOutbox = processOutbox as jest.MockedFunction<typeof processOutbox>;

describe('runDailyEvidenceExpiryNotifications', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedRetention.mockResolvedValue({ scanned: 0, tasksCreated: 0, skippedDuplicate: 0 });
        mockedOutbox.mockResolvedValue({ sent: 0, failed: 0, skipped: 0 });
    });

    it('runs three retention sweeps at 30, 7, and 1 day thresholds', async () => {
        await runDailyEvidenceExpiryNotifications();

        expect(mockedRetention).toHaveBeenCalledTimes(3);
        expect(mockedRetention).toHaveBeenCalledWith(expect.objectContaining({ days: 30 }));
        expect(mockedRetention).toHaveBeenCalledWith(expect.objectContaining({ days: 7 }));
        expect(mockedRetention).toHaveBeenCalledWith(expect.objectContaining({ days: 1 }));
    });

    it('flushes outbox after sweeps', async () => {
        await runDailyEvidenceExpiryNotifications();
        expect(mockedOutbox).toHaveBeenCalledTimes(1);
        expect(mockedOutbox).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    });

    it('skips outbox when skipOutbox=true', async () => {
        await runDailyEvidenceExpiryNotifications({ skipOutbox: true });
        expect(mockedOutbox).not.toHaveBeenCalled();
    });

    it('passes tenantId to each sweep when provided', async () => {
        await runDailyEvidenceExpiryNotifications({ tenantId: 'tenant-42' });

        for (const call of mockedRetention.mock.calls) {
            expect(call[0]).toHaveProperty('tenantId', 'tenant-42');
        }
    });

    it('returns aggregate results', async () => {
        mockedRetention
            .mockResolvedValueOnce({ scanned: 10, tasksCreated: 2, skippedDuplicate: 1 })
            .mockResolvedValueOnce({ scanned: 5, tasksCreated: 1, skippedDuplicate: 0 })
            .mockResolvedValueOnce({ scanned: 2, tasksCreated: 0, skippedDuplicate: 0 });
        mockedOutbox.mockResolvedValue({ sent: 3, failed: 0, skipped: 0 });

        const result = await runDailyEvidenceExpiryNotifications();

        expect(result.sweeps.days30.tasksCreated).toBe(2);
        expect(result.sweeps.days7.tasksCreated).toBe(1);
        expect(result.sweeps.days1.tasksCreated).toBe(0);
        expect(result.outbox.sent).toBe(3);
    });

    it('is idempotent — duplicate sweeps do not create extra tasks', async () => {
        // First run creates tasks
        mockedRetention.mockResolvedValue({ scanned: 5, tasksCreated: 3, skippedDuplicate: 0 });
        await runDailyEvidenceExpiryNotifications();

        // Second run — existing tasks are skipped
        mockedRetention.mockResolvedValue({ scanned: 5, tasksCreated: 0, skippedDuplicate: 3 });
        const result = await runDailyEvidenceExpiryNotifications();

        expect(result.sweeps.days30.tasksCreated).toBe(0);
        expect(result.sweeps.days30.skippedDuplicate).toBe(3);
    });
});

/**
 * THE COUPLING (#2485).
 *
 * The three evidence sweeps used to be bare `await`s with the outbox flush
 * below them, so this job's real behaviour was "flush the outbox, unless an
 * evidence query throws first". The outbox is the delivery path for EVERY
 * notification the product sends — including, since 2026-09-12, the mail that
 * tells a manager a leaver's directory account has been disabled. A failure in
 * an unrelated evidence scan therefore withheld that mail until the next 06:00
 * tick, roughly 25 hours later, and nothing anywhere said so.
 *
 * These are BEHAVIOURAL assertions. The new `notification-outbox-flush`
 * schedule is shape and is covered by its own wiring test; what has to be true
 * HERE is that a sweep can throw and the mail still leaves — while the job
 * still FAILS, because turning a loud sweep failure into a quiet one would be
 * its own regression.
 */
describe('a failing evidence sweep does not withhold the outbox', () => {
    beforeEach(() => {
        // mockReset, not clearAllMocks: several cases below queue
        // `...Once` outcomes, and `clearAllMocks` does NOT drain an
        // unconsumed once-queue. A case whose first sweep aborts the run
        // would otherwise leak its remaining queued outcomes into the next
        // test — which is exactly the shape of a cascade that makes a
        // later reordering look like a real regression.
        mockedRetention.mockReset();
        mockedOutbox.mockReset();
        mockedRetention.mockResolvedValue({ scanned: 0, tasksCreated: 0, skippedDuplicate: 0 });
        mockedOutbox.mockResolvedValue({ sent: 0, failed: 0, skipped: 0 });
    });

    it('flushes the outbox even though the 30-day sweep threw', async () => {
        mockedRetention
            .mockRejectedValueOnce(new Error('evidence scan exploded'))
            .mockResolvedValue({ scanned: 0, tasksCreated: 0, skippedDuplicate: 0 });
        mockedOutbox.mockResolvedValue({ sent: 4, failed: 0, skipped: 0 });

        await expect(runDailyEvidenceExpiryNotifications()).rejects.toBeInstanceOf(EvidenceSweepFailedError);

        // THE CLAIM. Before the guards this was zero calls: the throw left the
        // function before the flush line was ever reached.
        expect(mockedOutbox).toHaveBeenCalledTimes(1);
        expect(mockedOutbox).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    });

    it('flushes the outbox even though ALL THREE sweeps threw', async () => {
        mockedRetention.mockRejectedValue(new Error('database is gone'));

        await expect(runDailyEvidenceExpiryNotifications()).rejects.toBeInstanceOf(EvidenceSweepFailedError);

        expect(mockedOutbox).toHaveBeenCalledTimes(1);
    });

    it('one throwing sweep does not cancel the other two', async () => {
        // Per-sweep try/catch rather than one try around all three: the
        // thresholds are independent queries over different rows, so losing
        // the 7-day and 1-day sweeps to a 30-day failure would be a second,
        // smaller copy of the same coupling.
        mockedRetention.mockRejectedValueOnce(new Error('30d blew up'));

        await expect(runDailyEvidenceExpiryNotifications()).rejects.toThrow();

        expect(mockedRetention).toHaveBeenCalledTimes(3);
        expect(mockedRetention).toHaveBeenCalledWith(expect.objectContaining({ days: 7 }));
        expect(mockedRetention).toHaveBeenCalledWith(expect.objectContaining({ days: 1 }));
    });

    it('still FAILS the job — a caught sweep is reported, not swallowed', async () => {
        // The negative half. Had the guards simply absorbed the error, this job
        // would report success while a third of its work never ran, and BullMQ
        // would not retry. Both are worse than the bug being fixed.
        mockedRetention.mockRejectedValueOnce(new Error('7d scan timed out'));

        await expect(runDailyEvidenceExpiryNotifications()).rejects.toThrow(/1 of 3 evidence sweeps failed/);
    });

    it('names the failing threshold and the flush that happened', async () => {
        // What an operator reads at 06:05 when the job goes red. The question
        // they actually have is "did the 05:00 leaver mail go out?", so the
        // error answers it instead of only naming the sweep.
        mockedRetention
            .mockResolvedValueOnce({ scanned: 1, tasksCreated: 0, skippedDuplicate: 0 })
            .mockRejectedValueOnce(new Error('7d scan timed out'))
            .mockResolvedValueOnce({ scanned: 1, tasksCreated: 0, skippedDuplicate: 0 });
        mockedOutbox.mockResolvedValue({ sent: 9, failed: 0, skipped: 1 });

        const thrown = await runDailyEvidenceExpiryNotifications().catch((e: unknown) => e);

        expect(thrown).toBeInstanceOf(EvidenceSweepFailedError);
        const failure = thrown as EvidenceSweepFailedError;
        expect(failure.failures).toEqual([{ days: 7, error: '7d scan timed out' }]);
        expect(failure.outbox).toEqual({ sent: 9, failed: 0, skipped: 1 });
        expect(failure.message).toContain('7d: 7d scan timed out');
        expect(failure.message).toContain('outbox still flushed (9 sent, 0 failed, 1 skipped)');
    });

    it('says the flush was skipped when the caller asked for no flush', async () => {
        // skipOutbox is the dry-run path (scripts/notifications-runner.ts
        // --dry-run). Claiming a flush that never happened would be the same
        // class of stale promise this repo keeps finding in comments.
        mockedRetention.mockRejectedValueOnce(new Error('30d blew up'));

        const thrown = await runDailyEvidenceExpiryNotifications({ skipOutbox: true })
            .catch((e: unknown) => e) as EvidenceSweepFailedError;

        expect(mockedOutbox).not.toHaveBeenCalled();
        expect(thrown.message).toContain('outbox flush was skipped by the caller');
    });

    it('one throwing sweep does not stop its siblings, and each failure is named', async () => {
        // RENAMED: the old name promised that a failed sweep "contributes zeros,
        // not a sibling's numbers", which is not observable — the aggregate is
        // unreachable once any sweep throws. What this test actually asserts,
        // and the thing worth protecting, is that a throw does not cancel the
        // other sweeps and that every failure is named in the error.
        // Only the 1-day sweep succeeds here.
        mockedRetention
            .mockRejectedValueOnce(new Error('30d blew up'))
            .mockRejectedValueOnce(new Error('7d blew up'))
            .mockResolvedValueOnce({ scanned: 5, tasksCreated: 2, skippedDuplicate: 1 });

        const thrown = await runDailyEvidenceExpiryNotifications()
            .catch((e: unknown) => e) as EvidenceSweepFailedError;

        expect(thrown.failures.map((f) => f.days)).toEqual([30, 7]);
    });

    it('a clean run still resolves — the guards did not make failure the norm', async () => {
        // Positive control. Every assertion above is about a rejection, and a
        // function that ALWAYS rejected would satisfy all of them.
        mockedRetention.mockResolvedValue({ scanned: 3, tasksCreated: 1, skippedDuplicate: 0 });
        mockedOutbox.mockResolvedValue({ sent: 2, failed: 0, skipped: 0 });

        const result = await runDailyEvidenceExpiryNotifications();

        expect(result.outbox.sent).toBe(2);
        expect(result.sweeps.days30.tasksCreated).toBe(1);
    });
});
