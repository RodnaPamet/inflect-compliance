/**
 * The stale-review sweep is REACHABLE.
 *
 * The usecase shipped complete and tested on 2026-05-22 and then never ran:
 * no executor registration, no `JobPayloadMap` entry, no schedule, no caller.
 * What stood in for coverage was five `expect(src).toMatch(...)` assertions in
 * `tests/guardrails/audit-s3-evidence-mgmt.test.ts` — every one of which passes
 * against a function nobody calls, because a regex over source text cannot tell
 * "implemented" from "implemented and wired".
 *
 * So these assertions are deliberately about REACHABILITY, not shape. They fail
 * if the registration, the schedule entry, or the call into the usecase is
 * removed — which is the regression the greps could not see.
 */
import { executorRegistry } from '@/app-layer/jobs/executor-registry';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { scheduler } from '@/app-layer/jobs/scheduler';

const JOB = 'evidence-stale-review-sweep';

const sweepMock = jest.fn(async (_opts: { tenantId?: string }) => ({ transitioned: 7 }));
jest.mock('@/app-layer/usecases/evidence-stale-review-sweep', () => ({
    __esModule: true,
    runEvidenceStaleReviewSweep: (opts: { tenantId?: string }) => sweepMock(opts),
}));

/** Minutes past midnight for a `m h * * *` daily cron, or null if not daily. */
function dailyMinuteOfDay(pattern: string): number | null {
    const [min, hour, dom, mon, dow] = pattern.trim().split(/\s+/);
    if (dom !== '*' || mon !== '*' || dow !== '*') return null;
    if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return null;
    return Number(hour) * 60 + Number(min);
}

describe('evidence-stale-review-sweep is wired, not merely written', () => {
    beforeEach(() => sweepMock.mockClear());

    it('has a registered executor', () => {
        expect(executorRegistry.has(JOB)).toBe(true);
    });

    it('executing the job reaches the usecase and returns its count', async () => {
        const result = await executorRegistry.execute(JOB, {});

        // POSITIVE first: the executor ran and the count came back through it.
        // "no error" alone would pass against an executor that returns a stub.
        expect(sweepMock).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(true);
        expect(result.itemsActioned).toBe(7);
        expect(result.itemsScanned).toBe(7);
        expect(result.details).toMatchObject({ transitioned: 7 });
    });

    it('forwards an explicit tenantId, and sweeps all tenants without one', async () => {
        await executorRegistry.execute(JOB, { tenantId: 't-42' });
        expect(sweepMock.mock.calls[0][0]).toEqual({ tenantId: 't-42' });

        sweepMock.mockClear();
        await executorRegistry.execute(JOB, {});
        // undefined, not omitted — the usecase reads `options.tenantId` and an
        // absent key must mean "every tenant", never "tenant undefined".
        expect(sweepMock.mock.calls[0][0]).toEqual({ tenantId: undefined });
    });

    it('is on the schedule', () => {
        expect(SCHEDULED_JOBS.map((s) => s.name)).toContain(JOB);
    });

    it('every scheduled job has an executor (this one included)', () => {
        // The positive control for the assertion above: proves the mechanism
        // that would notice a missing registration is itself alive and sees
        // a non-empty schedule.
        expect(SCHEDULED_JOBS.length).toBeGreaterThan(0);
        expect(scheduler.validateRegistrations()).toEqual({ valid: true, missing: [] });
    });

    it('fires before notification-dispatch, which is what tells the owner', () => {
        const sweep = SCHEDULED_JOBS.find((s) => s.name === JOB);
        const dispatch = SCHEDULED_JOBS.find((s) => s.name === 'notification-dispatch');
        expect(sweep).toBeDefined();
        expect(dispatch).toBeDefined();

        const sweepAt = dailyMinuteOfDay(sweep!.pattern);
        const dispatchAt = dailyMinuteOfDay(dispatch!.pattern);

        // Both must be plain daily crons for a minute-of-day comparison to
        // mean anything — otherwise this test would silently compare
        // incomparable schedules and pass.
        expect(sweepAt).not.toBeNull();
        expect(dispatchAt).not.toBeNull();
        expect(sweep!.tz).toBeUndefined();
        expect(dispatch!.tz).toBeUndefined();

        // Derived, not pinned to '30 6': moving EITHER job past the other
        // fails here, which is the ordering that actually matters. Run the
        // sweep after the dispatch and every owner learns a day late.
        expect(sweepAt!).toBeLessThan(dispatchAt!);
    });
});
