/**
 * The notification outbox has its OWN schedule (#2485).
 *
 * Until this job, the only scheduled `processOutbox` call in the codebase was
 * the tail of `daily-evidence-expiry` at 06:00 UTC, behind three unguarded
 * awaits. Everything the product sends by email — digests, task reminders,
 * access-review nudges, and the mail that tells a manager a leaver's directory
 * account was disabled at 05:00 — left the building in that one minute or not
 * that day at all.
 *
 * These assertions are about REACHABILITY and CADENCE, not shape. A job module
 * that exists, is typed, and is registered but is on nobody's schedule is the
 * exact failure this repo has hit before (`evidence-stale-review-sweep` shipped
 * complete and never ran for months). So: the executor resolves, executing it
 * actually reaches `processOutbox`, and the cron that fires it is short enough
 * that the delay this job exists to remove is genuinely removed.
 */
import { executorRegistry } from '@/app-layer/jobs/executor-registry';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { JOB_DEFAULTS } from '@/app-layer/jobs/types';

const JOB = 'notification-outbox-flush';

const outboxMock = jest.fn(async (_opts: { limit?: number; tenantId?: string }) => ({
    sent: 3,
    failed: 1,
    skipped: 2,
}));
jest.mock('@/app-layer/notifications/processOutbox', () => ({
    __esModule: true,
    processOutbox: (opts: { limit?: number; tenantId?: string }) => outboxMock(opts),
}));

/** Shortest gap between two firings of `m h * * *`, in minutes. */
function cronPeriodMinutes(pattern: string): number {
    const [minute, hour, dom, month, dow] = pattern.trim().split(/\s+/);
    if (dom !== '*' || month !== '*' || dow !== '*') {
        throw new Error(`unsupported cron (non-daily fields): "${pattern}"`);
    }
    if (minute === '*') return 1;
    const everyMinute = /^\*\/(\d+)$/.exec(minute);
    if (everyMinute) return Number(everyMinute[1]);
    if (!/^\d+$/.test(minute)) throw new Error(`unsupported cron minute: "${pattern}"`);
    if (/^\d+$/.test(hour)) return 24 * 60;
    if (hour === '*') return 60;
    const everyHour = /^\*\/(\d+)$/.exec(hour);
    if (everyHour) return Number(everyHour[1]) * 60;
    throw new Error(`unsupported cron hour: "${pattern}"`);
}

describe('notification-outbox-flush is wired, not merely written', () => {
    beforeEach(() => outboxMock.mockClear());

    it('has a registered executor', () => {
        expect(executorRegistry.has(JOB)).toBe(true);
    });

    it('executing the job reaches processOutbox and reports its counts', async () => {
        const result = await executorRegistry.execute(JOB, {});

        // POSITIVE first: "no error" alone would pass against an executor that
        // returns a stub without ever touching the outbox.
        expect(outboxMock).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(true);
        expect(result.itemsActioned).toBe(3);          // sent
        expect(result.itemsSkipped).toBe(2);           // deferred / already claimed
        expect(result.itemsScanned).toBe(6);           // sent + failed + skipped
        expect(result.details).toMatchObject({ sent: 3, failed: 1, skipped: 2 });
    });

    it('drains every tenant when no tenantId is given', async () => {
        await executorRegistry.execute(JOB, {});

        // undefined, not omitted, and deliberately so: `processOutbox` reads
        // `options.tenantId` and an absent key must mean "every tenant". This
        // is the SCHEDULED shape — a platform job draining a platform queue.
        expect(outboxMock.mock.calls[0][0]).toEqual({ limit: 200, tenantId: undefined });
    });

    it('forwards an explicit tenantId for an operator re-run', async () => {
        // The dangerous direction is the other one: a tenant-scoped caller
        // whose tenantId is dropped sends every other tenant's queued mail.
        await executorRegistry.execute(JOB, { tenantId: 't-42' });

        expect(outboxMock.mock.calls[0][0]).toMatchObject({ tenantId: 't-42' });
    });

    it('forwards an explicit limit, and defaults to 200 without one', async () => {
        await executorRegistry.execute(JOB, { limit: 25 });
        expect(outboxMock.mock.calls[0][0]).toMatchObject({ limit: 25 });

        outboxMock.mockClear();
        await executorRegistry.execute(JOB, {});
        expect(outboxMock.mock.calls[0][0]).toMatchObject({ limit: 200 });
    });

    it('is on the schedule', () => {
        expect(SCHEDULED_JOBS.map((s) => s.name)).toContain(JOB);
    });

    it('fires at least every 15 minutes — the whole point is not waiting for 06:00', () => {
        // The bound, not the exact pattern. A future tuning from 10 to 5 or 15
        // minutes is a judgement call; a silent edit back to a daily cron would
        // restore #2485 with the job still present and green, which is the
        // regression worth failing on.
        const entry = SCHEDULED_JOBS.find((s) => s.name === JOB);
        expect(entry).toBeDefined();
        expect(cronPeriodMinutes(entry!.pattern)).toBeLessThanOrEqual(15);
    });

    it('the cron parser is not vacuously permissive', () => {
        // Positive control for the assertion above: a parser that returned a
        // small number for everything would pass it against a daily schedule.
        expect(cronPeriodMinutes('*/10 * * * *')).toBe(10);
        expect(cronPeriodMinutes('0 6 * * *')).toBe(24 * 60);
        expect(cronPeriodMinutes('0 * * * *')).toBe(60);
    });

    it('declares a single attempt — the next tick is the retry', () => {
        // At this cadence a BullMQ retry five seconds later re-enters the same
        // dead SMTP host. Per-MESSAGE retry still exists inside processOutbox
        // (three attempts per row), spread across ticks instead of burned in
        // one. A future edit raising this would answer an outage with a storm.
        expect(JOB_DEFAULTS[JOB].attempts).toBe(1);
    });

    it('daily-evidence-expiry keeps its own flush — this job is an addition', () => {
        // Not a replacement. The expiry sweeps enqueue mail and then hand it
        // straight to a flush; removing that tail would make their output wait
        // up to a full tick for no benefit, since a second drain in the same
        // minute sends nothing twice.
        expect(SCHEDULED_JOBS.map((s) => s.name)).toContain('daily-evidence-expiry');
    });
});
