/**
 * Epic G-2 — Control Test Scheduler unit tests.
 *
 * Pure-memory tests of `runControlTestScheduler` — Prisma, the
 * BullMQ queue, the logger, and the runJob observability wrapper
 * are all mocked. Verifies the four invariants the scheduler must
 * uphold:
 *
 *   1. Scan filter — automationType IN (SCRIPT, INTEGRATION),
 *      status=ACTIVE, schedule non-null, nextRunAt due-or-null,
 *      tenant scope honoured when supplied.
 *   2. Bootstrap — null nextRunAt rows get a stamped nextRunAt and
 *      do NOT enqueue this tick (one-tick latency by design).
 *   3. Claim contract — the optimistic lock stamps the previous
 *      nextRunAt as part of the WHERE clause; if updateMany returns
 *      count=0 the tick lost the race and skips enqueue.
 *   4. Enqueue contract — successful claim yields an enqueue with
 *      the deterministic `ctr:{planId}:{scheduledForIso}` jobId so
 *      a worker-restart retry cannot double-fire the same intended
 *      execution.
 */

// ─── Mocks ─────────────────────────────────────────────────────────

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
};

jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));

jest.mock('@/lib/observability/job-runner', () => ({
    runJob: jest.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
}));

const mockFindMany = jest.fn();
const mockUpdateMany = jest.fn();
jest.mock('@/lib/prisma', () => ({
    prisma: {
        controlTestPlan: {
            findMany: (...args: unknown[]) => mockFindMany(...args),
            updateMany: (...args: unknown[]) => mockUpdateMany(...args),
        },
    },
}));

const mockEnqueue = jest.fn();
jest.mock('@/app-layer/jobs/queue', () => ({
    enqueue: (...args: unknown[]) => mockEnqueue(...args),
}));

import { runControlTestScheduler } from '@/app-layer/jobs/control-test-scheduler';

// ─── Helpers ───────────────────────────────────────────────────────

const NOW = new Date('2026-05-05T12:00:00.000Z');
const PAST = new Date('2026-05-05T11:55:00.000Z');

function makePlan(overrides: Partial<{
    id: string;
    tenantId: string;
    schedule: string;
    scheduleTimezone: string | null;
    nextRunAt: Date | null;
}> = {}) {
    // `'key' in overrides` instead of `??` so `nextRunAt: null` is
    // honoured as an explicit override (the bootstrap path) and not
    // silently replaced by PAST.
    return {
        id: overrides.id ?? 'plan-1',
        tenantId: overrides.tenantId ?? 'tenant-1',
        schedule: overrides.schedule ?? '*/5 * * * *',
        scheduleTimezone:
            'scheduleTimezone' in overrides
                ? overrides.scheduleTimezone!
                : null,
        nextRunAt: 'nextRunAt' in overrides ? overrides.nextRunAt! : PAST,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockFindMany.mockReset();
    mockUpdateMany.mockReset();
    mockEnqueue.mockReset();
});

// ─── 1. Happy path ─────────────────────────────────────────────────

describe('runControlTestScheduler — happy path', () => {
    test('claims one due plan and enqueues with deterministic jobId', async () => {
        const plan = makePlan();
        mockFindMany.mockResolvedValueOnce([plan]);
        mockUpdateMany.mockResolvedValueOnce({ count: 1 });

        const result = await runControlTestScheduler({ now: NOW });

        expect(result).toMatchObject({
            totalDue: 1,
            bootstrapped: 0,
            enqueued: 1,
            skippedClaimRace: 0,
            skippedInvalidSchedule: 0,
            enqueueFailures: 0,
            dryRun: false,
        });

        // The claim's WHERE includes the OLD nextRunAt — that's the
        // optimistic lock. Without it, two parallel ticks could both
        // succeed at advancing the same plan.
        expect(mockUpdateMany).toHaveBeenCalledTimes(1);
        const claimCall = mockUpdateMany.mock.calls[0][0];
        expect(claimCall.where).toMatchObject({
            id: plan.id,
            tenantId: plan.tenantId,
            nextRunAt: plan.nextRunAt,
        });
        expect(claimCall.data.lastScheduledRunAt).toEqual(NOW);
        expect(claimCall.data.nextRunAt).toBeInstanceOf(Date);

        // The enqueue's jobId is the dedupe contract.
        expect(mockEnqueue).toHaveBeenCalledTimes(1);
        const [jobName, payload, options] = mockEnqueue.mock.calls[0];
        expect(jobName).toBe('control-test-runner');
        expect(payload).toMatchObject({
            tenantId: plan.tenantId,
            testPlanId: plan.id,
            scheduledForIso: plan.nextRunAt!.toISOString(),
        });
        expect(options.jobId).toBe(
            `ctr:${plan.id}:${plan.nextRunAt!.toISOString()}`,
        );
    });
});

// ─── 2. Scan filter ────────────────────────────────────────────────

describe('runControlTestScheduler — scan filter', () => {
    test('does NOT restrict by automationType — any scheduled plan is due-eligible (PR-P)', async () => {
        // PR-P — a MANUAL plan on a cadence must be enqueued too (it instantiates
        // a PLANNED "awaiting manual completion" run each tick). The old
        // `automationType IN (SCRIPT, INTEGRATION)` filter excluded scheduled
        // MANUAL plans entirely, making them permanently un-ticked. Due-eligibility
        // is now driven solely by status=ACTIVE + a non-null schedule.
        mockFindMany.mockResolvedValueOnce([]);
        await runControlTestScheduler({ now: NOW });
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.automationType).toBeUndefined();
    });

    test('filters by status=ACTIVE and non-null schedule', async () => {
        mockFindMany.mockResolvedValueOnce([]);
        await runControlTestScheduler({ now: NOW });
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.status).toBe('ACTIVE');
        expect(where.schedule).toEqual({ not: null });
    });

    test('filters by nextRunAt due OR null', async () => {
        mockFindMany.mockResolvedValueOnce([]);
        await runControlTestScheduler({ now: NOW });
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.OR).toEqual([
            { nextRunAt: { lte: NOW } },
            { nextRunAt: null },
        ]);
    });

    test('scopes by tenantId when provided', async () => {
        mockFindMany.mockResolvedValueOnce([]);
        await runControlTestScheduler({ now: NOW, tenantId: 'tenant-X' });
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.tenantId).toBe('tenant-X');
    });

    test('omits tenantId filter for the cron-tick all-tenants scan', async () => {
        mockFindMany.mockResolvedValueOnce([]);
        await runControlTestScheduler({ now: NOW });
        const where = mockFindMany.mock.calls[0][0].where;
        expect(where.tenantId).toBeUndefined();
    });

    test('respects custom batch size', async () => {
        mockFindMany.mockResolvedValueOnce([]);
        await runControlTestScheduler({ now: NOW, batchSize: 50 });
        expect(mockFindMany.mock.calls[0][0].take).toBe(50);
    });
});

// ─── 3. Bootstrap path ─────────────────────────────────────────────

describe('runControlTestScheduler — bootstrap path', () => {
    test('null nextRunAt is bootstrapped with stamped nextRunAt, no enqueue', async () => {
        const plan = makePlan({ nextRunAt: null });
        mockFindMany.mockResolvedValueOnce([plan]);
        mockUpdateMany.mockResolvedValueOnce({ count: 1 });

        const result = await runControlTestScheduler({ now: NOW });

        expect(result.bootstrapped).toBe(1);
        expect(result.enqueued).toBe(0);
        // No enqueue this tick — the next tick will pick up the just-
        // stamped plan if its computed nextRunAt is due.
        expect(mockEnqueue).not.toHaveBeenCalled();

        // Bootstrap update guards on null nextRunAt — if a parallel
        // tick already bootstrapped, the WHERE clause fails and the
        // count is 0 (no double-stamp).
        expect(mockUpdateMany).toHaveBeenCalledTimes(1);
        const bootCall = mockUpdateMany.mock.calls[0][0];
        expect(bootCall.where).toMatchObject({
            id: plan.id,
            tenantId: plan.tenantId,
            nextRunAt: null,
        });
        expect(bootCall.data.nextRunAt).toBeInstanceOf(Date);
        expect('lastScheduledRunAt' in bootCall.data).toBe(false);
    });
});

// ─── 4. Claim race (optimistic lock loss) ──────────────────────────

describe('runControlTestScheduler — claim race', () => {
    test('updateMany count=0 means another tick already claimed; no enqueue', async () => {
        const plan = makePlan();
        mockFindMany.mockResolvedValueOnce([plan]);
        mockUpdateMany.mockResolvedValueOnce({ count: 0 });

        const result = await runControlTestScheduler({ now: NOW });

        expect(result.skippedClaimRace).toBe(1);
        expect(result.enqueued).toBe(0);
        expect(mockEnqueue).not.toHaveBeenCalled();
    });

    test('mixed batch — some plans claimed, others lost the race', async () => {
        const a = makePlan({ id: 'a' });
        const b = makePlan({ id: 'b' });
        mockFindMany.mockResolvedValueOnce([a, b]);
        // a wins, b loses
        mockUpdateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });

        const result = await runControlTestScheduler({ now: NOW });

        expect(result.enqueued).toBe(1);
        expect(result.skippedClaimRace).toBe(1);
        expect(mockEnqueue).toHaveBeenCalledTimes(1);
        expect(mockEnqueue.mock.calls[0][1].testPlanId).toBe('a');
    });
});

// ─── 5. Invalid schedule ───────────────────────────────────────────

describe('runControlTestScheduler — invalid schedule', () => {
    test('un-parseable cron is logged and skipped, others still proceed', async () => {
        const broken = makePlan({ id: 'broken', schedule: 'not a cron' });
        const ok = makePlan({ id: 'ok' });
        mockFindMany.mockResolvedValueOnce([broken, ok]);
        mockUpdateMany.mockResolvedValueOnce({ count: 1 });

        const result = await runControlTestScheduler({ now: NOW });

        expect(result.skippedInvalidSchedule).toBe(1);
        expect(result.enqueued).toBe(1);
        expect(mockEnqueue).toHaveBeenCalledTimes(1);
        expect(mockEnqueue.mock.calls[0][1].testPlanId).toBe('ok');

        // The bad plan didn't even attempt a claim — invalid schedule
        // is detected before any DB write.
        expect(mockUpdateMany).toHaveBeenCalledTimes(1);
        expect(mockUpdateMany.mock.calls[0][0].where.id).toBe('ok');

        // Escalated to an error log (a genuinely invalid cron means the plan
        // can never run until fixed — distinct from the benign "no next run"
        // case) so on-call sees it rather than a per-tick warn.
        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.stringContaining('invalid schedule'),
            expect.objectContaining({
                planId: 'broken',
                schedule: 'not a cron',
            }),
        );
    });
});

// ─── 6. Cron-parser timezone wiring ────────────────────────────────

describe('runControlTestScheduler — timezone handling', () => {
    test('UTC-default cron computes UTC-anchored next run', async () => {
        // Cron: every day at 09:00. With NOW=12:00 UTC, next is
        // tomorrow 09:00 UTC.
        const plan = makePlan({ schedule: '0 9 * * *', scheduleTimezone: null });
        mockFindMany.mockResolvedValueOnce([plan]);
        mockUpdateMany.mockResolvedValueOnce({ count: 1 });

        await runControlTestScheduler({ now: NOW });

        const stamped = mockUpdateMany.mock.calls[0][0].data.nextRunAt as Date;
        expect(stamped.toISOString()).toBe('2026-05-06T09:00:00.000Z');
    });

    test('explicit timezone shifts the cron firing instant', async () => {
        // 09:00 in Asia/Tokyo (UTC+9) is 00:00 UTC. With NOW=12:00 UTC
        // 2026-05-05, next 09:00 JST is 2026-05-06 00:00 UTC.
        const plan = makePlan({
            schedule: '0 9 * * *',
            scheduleTimezone: 'Asia/Tokyo',
        });
        mockFindMany.mockResolvedValueOnce([plan]);
        mockUpdateMany.mockResolvedValueOnce({ count: 1 });

        await runControlTestScheduler({ now: NOW });

        const stamped = mockUpdateMany.mock.calls[0][0].data.nextRunAt as Date;
        expect(stamped.toISOString()).toBe('2026-05-06T00:00:00.000Z');
    });
});

// ─── 7. Dry run ────────────────────────────────────────────────────

describe('runControlTestScheduler — dry run', () => {
    test('counts but does not write or enqueue', async () => {
        mockFindMany.mockResolvedValueOnce([
            makePlan({ id: 'a' }),
            makePlan({ id: 'b', nextRunAt: null }),
        ]);

        const result = await runControlTestScheduler({
            now: NOW,
            dryRun: true,
        });

        expect(result).toMatchObject({
            totalDue: 2,
            bootstrapped: 1,
            enqueued: 1,
            dryRun: true,
        });
        expect(mockUpdateMany).not.toHaveBeenCalled();
        expect(mockEnqueue).not.toHaveBeenCalled();
    });
});

// ─── 8. Enqueue failure post-claim ─────────────────────────────────

describe('runControlTestScheduler — enqueue failure', () => {
    test('logs and increments counter; the plan stays advanced', async () => {
        const plan = makePlan();
        mockFindMany.mockResolvedValueOnce([plan]);
        mockUpdateMany.mockResolvedValueOnce({ count: 1 });
        mockEnqueue.mockRejectedValueOnce(new Error('redis blip'));

        const result = await runControlTestScheduler({ now: NOW });

        expect(result.enqueueFailures).toBe(1);
        expect(result.enqueued).toBe(0);
        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.stringContaining('enqueue failed'),
            expect.objectContaining({ planId: plan.id }),
        );
    });
});
