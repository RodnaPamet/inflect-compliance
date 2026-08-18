/**
 * The calendar push fan-out: two jobs, and why that is not over-engineering.
 *
 * The shape is a cron DISPATCHER plus an ENQUEUED per-tenant child. The obvious
 * alternative — one scheduled job that does everything — is wrong for a reason
 * that is invisible in the source and mechanical rather than aesthetic:
 *
 *   `registerSchedules` calls `upsertJobScheduler(name, repeatOpts, {name, data})`
 *   with NO `opts`, and BullMQ merges `Object.assign({}, jobsOpts, template.opts)`.
 *   With `opts` undefined that yields the QUEUE DEFAULT — attempts: 3,
 *   exponential — regardless of the job's JOB_DEFAULTS entry. All 29 scheduled
 *   jobs are in that state.
 *
 *   `enqueue()` DOES apply JOB_DEFAULTS[name].
 *
 * So the only way work that talks to Google or Graph actually gets attempts: 1
 * is for it to arrive as a child. Collapsing the two jobs silently restores
 * three attempts against a rate-limited provider, and nothing in the diff would
 * say so. The last test in this file is the one that would notice.
 */
const findMany = jest.fn<Promise<unknown[]>, [Record<string, unknown>]>();
/**
 * Typed with its real parameter tuple so `mock.calls[0][2]` — the jobId options
 * — is inspectable. `jest.fn(async () => …)` infers a zero-length tuple, and
 * the deterministic-id assertion is about the THIRD argument.
 */
const enqueue = jest.fn<Promise<{ id: string }>, [string, unknown, Record<string, unknown>?]>(
    async () => ({ id: 'job-1' }),
);

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        userCalendarConnection: {
            findMany: (...a: unknown[]) => findMany(...(a as [Record<string, unknown>])),
        },
    },
}));
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...a: unknown[]) =>
        enqueue(...(a as [string, unknown, Record<string, unknown>?])),
}));

import { runCalendarPushDispatch, runCalendarPushTenant } from '@/app-layer/jobs/calendar-push';
import { JOB_DEFAULTS } from '@/app-layer/jobs/types';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import * as fs from 'node:fs';
import * as path from 'node:path';

beforeEach(() => {
    jest.clearAllMocks();
    enqueue.mockResolvedValue({ id: 'job-1' });
});

describe('the dispatcher enqueues one child per tenant that actually has a connection', () => {
    it('queries distinct tenantIds over LIVE connections only', async () => {
        findMany.mockResolvedValue([{ tenantId: 't1' }, { tenantId: 't2' }]);
        const r = await runCalendarPushDispatch({});

        const q = findMany.mock.calls[0][0];
        // Revoked connections must not resurrect a tenant into the fan-out.
        expect(q.where).toEqual({ revokedAt: null });
        expect(q.distinct).toEqual(['tenantId']);
        // Bounded, like every other fan-out here.
        expect(typeof q.take).toBe('number');
        expect(r.tenants).toBe(2);
        expect(r.dispatched).toBe(2);
    });

    it('does NOT scan every tenant', async () => {
        // The population is "tenants where somebody connected a calendar",
        // which is a small fraction. Scanning Tenant would enqueue a job per
        // tenant just to discover it has nothing to do.
        findMany.mockResolvedValue([]);
        await runCalendarPushDispatch({});
        expect(findMany.mock.calls[0][0].select).toEqual({ tenantId: true });
    });

    it('gives each child a deterministic per-day job id', async () => {
        // A re-run of the dispatcher inside the same bucket must be a no-op,
        // not a second pass over everyone's calendar.
        findMany.mockResolvedValue([{ tenantId: 't1' }]);
        await runCalendarPushDispatch({});
        const [name, payload, opts] = enqueue.mock.calls[0] as unknown as [string, unknown, { jobId: string }];
        expect(name).toBe('calendar-push-tenant');
        expect(payload).toEqual({ tenantId: 't1' });
        expect(opts.jobId).toContain('t1');

        // Same inputs, same id — that is the whole dedupe.
        enqueue.mockClear();
        await runCalendarPushDispatch({});
        const second = (enqueue.mock.calls[0] as unknown as [string, unknown, { jobId: string }])[2];
        expect(second.jobId).toBe(opts.jobId);
    });
});

describe('one tenant failing does not abort the fan-out', () => {
    it('continues past a failed enqueue and reports the count', async () => {
        findMany.mockResolvedValue([{ tenantId: 't1' }, { tenantId: 't2' }, { tenantId: 't3' }]);
        enqueue
            .mockResolvedValueOnce({ id: 'a' })
            .mockRejectedValueOnce(new Error('redis blip') as never)
            .mockResolvedValueOnce({ id: 'c' });

        const r = await runCalendarPushDispatch({});
        expect(r.dispatched).toBe(2);
        expect(r.failed).toBe(1);
    });

    it('THROWS only when every enqueue failed — that is an outage, not a tenant problem', async () => {
        findMany.mockResolvedValue([{ tenantId: 't1' }, { tenantId: 't2' }]);
        enqueue.mockRejectedValue(new Error('redis down') as never);
        await expect(runCalendarPushDispatch({})).rejects.toThrow(/all 2 enqueues failed/);
    });

    it('an empty population is not a failure', async () => {
        // Nobody has connected a calendar yet. That must not page anyone.
        findMany.mockResolvedValue([]);
        await expect(runCalendarPushDispatch({})).resolves.toMatchObject({ tenants: 0, dispatched: 0 });
    });
});

describe('the per-tenant child', () => {
    it('scans with the tenantId-leading predicate the index was built for', async () => {
        findMany.mockResolvedValue([]);
        await runCalendarPushTenant({ tenantId: 't1' });
        // `@@index([tenantId, provider, revokedAt])` — and the index ratchet's
        // written justification names this exact scan. A global drain with no
        // tenantId predicate would leave the leading column unconstrained and
        // make that recorded reason false.
        expect(findMany.mock.calls[0][0].where).toEqual({ tenantId: 't1', revokedAt: null });
    });

    it('is bounded', async () => {
        findMany.mockResolvedValue([]);
        await runCalendarPushTenant({ tenantId: 't1' });
        expect(typeof findMany.mock.calls[0][0].take).toBe('number');
    });

    it('refuses a payload with no tenantId', async () => {
        await expect(runCalendarPushTenant({ tenantId: '' })).rejects.toThrow(/requires tenantId/);
    });
});

describe('the two-job shape is what makes attempts:1 real', () => {
    it('the CHILD is enqueued, never scheduled', async () => {
        // The load-bearing assertion. JOB_DEFAULTS is inert for cron-fired
        // jobs, so a scheduled child would run 3 exponential attempts against
        // Google/Graph no matter what its entry says.
        const scheduled = SCHEDULED_JOBS.map((s) => s.name);
        expect(scheduled).toContain('calendar-push-dispatch');
        expect(scheduled).not.toContain('calendar-push-tenant');
    });

    it('and the dispatcher really does enqueue it, so the child is reachable', async () => {
        // The mirror: "not scheduled" is only safe if something enqueues it.
        // An unenqueued, unscheduled job is dead code that looks wired.
        findMany.mockResolvedValue([{ tenantId: 't1' }]);
        await runCalendarPushDispatch({});
        expect((enqueue.mock.calls[0] as unknown as string[])[0]).toBe('calendar-push-tenant');
    });

    it('both declare attempts: 1', () => {
        expect(JOB_DEFAULTS['calendar-push-dispatch'].attempts).toBe(1);
        expect(JOB_DEFAULTS['calendar-push-tenant'].attempts).toBe(1);
    });

    it('the schedule carries NO tz — the bucket parser ignores it and floors on UTC', () => {
        // A zoned cron puts two firings 23h apart on the DST spring-forward
        // day, which can land in one UTC bucket and silently skip a run. The
        // bucket guard's parser reads only `pattern`, so it cannot notice.
        const entry = SCHEDULED_JOBS.find((s) => s.name === 'calendar-push-dispatch');
        expect(entry).toBeDefined();
        expect(entry?.tz).toBeUndefined();
        expect((entry as { options?: { tz?: string } })?.options?.tz).toBeUndefined();
    });

    it('the dispatcher is registered with no payload parameter', () => {
        // `async (_payload)` on a cross-tenant job is banned outright by the
        // tenant-isolation guard, with no exemption list: an unused payload
        // parameter is how a cross-tenant job acquires a tenantId nobody
        // notices.
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/jobs/executor-registry.ts'),
            'utf8',
        );
        expect(src).toMatch(/register\('calendar-push-dispatch',\s*async \(\)\s*=>/);
    });
});
