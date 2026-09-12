/**
 * Coverage for `src/app-layer/jobs/register-schedules.ts` (pure).
 *
 * A fake BullMQ Queue captures every `upsertJobScheduler` call so we
 * can assert the repeat-option shape branches:
 *   - every SCHEDULED_JOBS entry is registered (return = length).
 *   - `tz` is included when present (entry.tz OR entry.options.tz),
 *     omitted otherwise.
 *   - `limit` is included only when entry.options.limit is truthy.
 *   - optional logger is called per schedule when provided, and the
 *     no-logger path also works.
 *
 * The fake also models the scheduler SET (get/remove), because
 * `registerSchedules` no longer only upserts — it reconciles (#2497). The
 * reconciliation's own safety behaviour is guarded in
 * `tests/guards/scheduler-orphan-reconciliation.test.ts`; what this file
 * checks is that the upsert contract above is unchanged by it.
 */
import type { Queue } from 'bullmq';
import {
    registerSchedules,
    reconcileRetiredSchedulers,
} from '@/app-layer/jobs/register-schedules';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';

interface CapturedCall {
    name: string;
    repeat: { pattern: string; tz?: string; limit?: number };
    template: { name: string; data: unknown };
}

/**
 * `preloaded` seeds scheduler ids that already exist in "Redis" before the
 * run — the only way to give the reconciliation a NON-EMPTY population, since
 * an empty scheduler set makes every sweep assertion vacuously true.
 */
function makeFakeQueue(preloaded: readonly string[] = []) {
    const calls: CapturedCall[] = [];
    const removed: string[] = [];
    const schedulers = new Set<string>(preloaded);
    const queue = {
        upsertJobScheduler: async (
            name: string,
            repeat: CapturedCall['repeat'],
            template: CapturedCall['template'],
        ) => {
            calls.push({ name, repeat, template });
            schedulers.add(name);
        },
        // BullMQ returns `key` (the scheduler id) alongside the template
        // `name`; the two are equal for every job this app registers, and the
        // reconciliation reads `key` because that is what removeJobScheduler
        // takes. The fake keeps them equal so a code path reading the wrong
        // field is caught by the guard file, not silently by this one.
        getJobSchedulers: async () =>
            [...schedulers].map((key) => ({ key, name: key })),
        removeJobScheduler: async (id: string) => {
            removed.push(id);
            return schedulers.delete(id);
        },
    } as unknown as Queue;
    return { calls, removed, schedulers, queue };
}

describe('registerSchedules', () => {
    it('registers every SCHEDULED_JOBS entry and returns the count', async () => {
        const { queue, calls } = makeFakeQueue();
        const count = await registerSchedules(queue);
        expect(count).toBe(SCHEDULED_JOBS.length);
        expect(calls).toHaveLength(SCHEDULED_JOBS.length);
        // Each call mirrors the entry name + pattern.
        for (const entry of SCHEDULED_JOBS) {
            const call = calls.find((c) => c.name === entry.name);
            expect(call).toBeDefined();
            expect(call?.repeat.pattern).toBe(entry.pattern);
            expect(call?.template.name).toBe(entry.name);
        }
    });

    it('includes tz only when the entry (or its options) carries one', async () => {
        const { queue, calls } = makeFakeQueue();
        await registerSchedules(queue);
        for (const entry of SCHEDULED_JOBS) {
            const tz = entry.tz ?? entry.options?.tz;
            const call = calls.find((c) => c.name === entry.name)!;
            if (tz) {
                expect(call.repeat.tz).toBe(tz);
            } else {
                expect(call.repeat).not.toHaveProperty('tz');
            }
        }
    });

    it('includes limit only when options.limit is truthy', async () => {
        const { queue, calls } = makeFakeQueue();
        await registerSchedules(queue);
        for (const entry of SCHEDULED_JOBS) {
            const call = calls.find((c) => c.name === entry.name)!;
            if (entry.options?.limit) {
                expect(call.repeat.limit).toBe(entry.options.limit);
            } else {
                expect(call.repeat).not.toHaveProperty('limit');
            }
        }
    });

    it('invokes the optional logger once per schedule', async () => {
        const { queue } = makeFakeQueue();
        const info = jest.fn();
        await registerSchedules(queue, { info });
        // Exactly the registrations: nothing is retired on a queue that holds
        // only the current schedule set, so the reconciliation logs nothing.
        expect(info).toHaveBeenCalledTimes(SCHEDULED_JOBS.length);
        // Each log call carries jobName + pattern.
        expect(info.mock.calls[0][0]).toHaveProperty('jobName');
        expect(info.mock.calls[0][1]).toBe('repeatable registered');
    });

    it('leaves every current schedule in place while reconciling', async () => {
        // Positive control for the assertion below: the queue starts with a
        // removable orphan, so "nothing was removed" cannot pass vacuously.
        const { queue, removed, schedulers } = makeFakeQueue(['deadline-monitor']);
        await registerSchedules(queue);
        expect(removed).toEqual(['deadline-monitor']);
        for (const entry of SCHEDULED_JOBS) {
            expect(schedulers.has(entry.name)).toBe(true);
        }
    });

    it('survives a logger with no warn/error channel', async () => {
        // `ScheduleRegLogger.warn`/`.error` are optional; a caller passing only
        // `info` (as the suite above does) must not crash the sweep.
        const { queue } = makeFakeQueue(['someone-elses-scheduler']);
        const info = jest.fn();
        await expect(registerSchedules(queue, { info })).resolves.toBe(
            SCHEDULED_JOBS.length,
        );
    });
});

describe('reconcileRetiredSchedulers — failure direction', () => {
    it('reports and returns 0 when the scheduler set cannot be enumerated', async () => {
        // getJobSchedulers throws on a legacy BullMQ repeatable key. The sweep
        // must fail OPEN (orphans survive) rather than propagate, because the
        // caller would otherwise report a registration failure that did not
        // happen.
        const error = jest.fn();
        const queue = {
            getJobSchedulers: async () => {
                throw new Error('legacy repeatable key');
            },
        } as unknown as Queue;
        await expect(
            reconcileRetiredSchedulers(queue, { info: jest.fn(), error }),
        ).resolves.toBe(0);
        expect(error).toHaveBeenCalledTimes(1);
        expect(error.mock.calls[0][1]).toContain('left in place');
    });

    it('keeps sweeping after one removal fails, and does not count it', async () => {
        const error = jest.fn();
        // Two removable orphans; the first throws. A `removed` count of 1 with
        // both attempted is the proof the loop did not abort on the first.
        const attempted: string[] = [];
        const queue = {
            getJobSchedulers: async () => [
                { key: 'deadline-monitor', name: 'deadline-monitor' },
                { key: 'vendor-renewal-check', name: 'vendor-renewal-check' },
            ],
            removeJobScheduler: async (id: string) => {
                attempted.push(id);
                if (id === 'deadline-monitor') throw new Error('redis down');
                return true;
            },
        } as unknown as Queue;
        await expect(
            reconcileRetiredSchedulers(queue, { info: jest.fn(), error }),
        ).resolves.toBe(1);
        expect(attempted).toEqual(['deadline-monitor', 'vendor-renewal-check']);
        expect(error).toHaveBeenCalledTimes(1);
    });
});

/**
 * Rehomed from the deleted `tests/guards/risk-quantification-integrity.test.ts`.
 *
 * Every assertion in that file but this one was `existsSync(path)` over a
 * hand-maintained table of 10 epics — 30 checks that a file is still on
 * disk. Deleting `fair-calculator.ts` would fail its own numeric tests
 * first, with a message that says what broke rather than "expected true".
 *
 * This one is different in kind: it is the only thing in the repo that
 * notices a cross-tenant cron being dropped from the schedule. Every other
 * test in this file iterates SCHEDULED_JOBS, so it is self-referential —
 * remove the `risk-snapshot` entry and they all still pass, having simply
 * verified a shorter array. Silence, and the daily snapshot stops.
 *
 * It now imports the array instead of regex-matching the source file, so
 * reformatting, reordering or renaming the const cannot break it.
 */
describe('cross-tenant risk crons stay scheduled', () => {
    it.each([
        ['risk-appetite-monitor', 'portfolio appetite-breach scan (RQ-2)'],
        ['risk-snapshot', 'daily snapshots behind trend + velocity (RQ-9)'],
        ['report-delivery', 'scheduled report delivery (RQ-10)'],
    ])('%s is registered — %s', (jobName) => {
        expect(SCHEDULED_JOBS.map((j) => j.name)).toContain(jobName);
    });
});
