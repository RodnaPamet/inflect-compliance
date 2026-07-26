/**
 * Epic G-2 — Test Scheduling usecase unit tests.
 *
 * Pure-memory tests of the three new app-layer entry points:
 *
 *   • scheduleTestPlan — cross-field invariants, cron + IANA-tz
 *     parsing, mutation shape, audit log, permission gate.
 *   • getTestDashboard — Promise.all aggregations, top-10 upcoming
 *     ordering, per-day trend bucketing.
 *
 * Prisma is mocked via `runInTenantContext` short-circuit; the
 * permissions module is mocked to flip canRead/canWrite per test.
 */

// ─── Mocks ─────────────────────────────────────────────────────────

const mockTx = {
    controlTestPlan: {
        findFirst: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
        findMany: jest.fn(),
    },
    controlTestRun: {
        findMany: jest.fn(),
    },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) =>
            fn(mockTx),
    ),
    runInTenantReadContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) =>
            fn(mockTx),
    ),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/security/sanitize', () => ({
    sanitizePlainText: jest.fn((s: string) => s.trim()),
}));

// ─── Imports ───────────────────────────────────────────────────────

import {
    scheduleTestPlan,
    getTestDashboard,
} from '@/app-layer/usecases/test-scheduling';

// ─── Helpers ───────────────────────────────────────────────────────

function makeCtx(overrides: { canRead?: boolean; canWrite?: boolean } = {}) {
    const canRead = overrides.canRead ?? true;
    const canWrite = overrides.canWrite ?? true;
    return {
        requestId: 'req-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        role: 'ADMIN' as const,
        permissions: {
            canRead,
            canWrite,
            canAdmin: false,
            canAudit: false,
            canExport: false,
        },
        // The test policies now gate on appPermissions.tests.* (custom-role-
        // aware), so mirror the canRead/canWrite flags into the granular keys.
        appPermissions: {
            tests: { view: canRead, create: canWrite, execute: canWrite },
        } as never,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    Object.values(mockTx.controlTestPlan).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
    Object.values(mockTx.controlTestRun).forEach((fn) =>
        (fn as jest.Mock).mockReset(),
    );
});

// ═══════════════════════════════════════════════════════════════════
// 1. scheduleTestPlan
// ═══════════════════════════════════════════════════════════════════

describe('scheduleTestPlan — permissions', () => {
    test('rejects callers without canWrite', async () => {
        await expect(
            scheduleTestPlan(makeCtx({ canWrite: false }), 'plan-1', {
                schedule: '0 9 * * *',
                automationType: 'SCRIPT',
            }),
        ).rejects.toThrow(/permission/i);
    });
});

describe('scheduleTestPlan — cross-field invariants', () => {
    test('MANUAL with a non-null schedule is now ACCEPTED (scheduled manual review) (PR-P)', async () => {
        // PR-P — a MANUAL plan MAY carry a cron. Each scheduler tick instantiates
        // a PLANNED "awaiting manual completion" run. This is the honest shape
        // while no SCRIPT/INTEGRATION engine exists; a cadence no longer forces
        // the misleading SCRIPT label.
        mockTx.controlTestPlan.findFirst.mockResolvedValueOnce({
            id: 'plan-1',
            tenantId: 'tenant-1',
            automationType: 'MANUAL',
            schedule: null,
            scheduleTimezone: null,
            nextRunAt: null,
        });
        mockTx.controlTestPlan.update.mockResolvedValueOnce({ id: 'plan-1', automationType: 'MANUAL' });

        await scheduleTestPlan(makeCtx(), 'plan-1', {
            schedule: '0 9 * * MON',
            scheduleTimezone: 'UTC',
            automationType: 'MANUAL',
        });

        const updateCall = mockTx.controlTestPlan.update.mock.calls[0][0];
        expect(updateCall.data).toMatchObject({
            automationType: 'MANUAL',
            schedule: '0 9 * * MON',
        });
        // A cron was supplied, so nextRunAt is computed (not nulled).
        expect(updateCall.data.nextRunAt).toBeInstanceOf(Date);
    });

    test('SCRIPT with null schedule is rejected', async () => {
        await expect(
            scheduleTestPlan(makeCtx(), 'plan-1', {
                schedule: null,
                automationType: 'SCRIPT',
            }),
        ).rejects.toThrow(/SCRIPT plans require a non-null cron schedule/);
    });

    test('INTEGRATION with null schedule is rejected', async () => {
        await expect(
            scheduleTestPlan(makeCtx(), 'plan-1', {
                schedule: null,
                automationType: 'INTEGRATION',
            }),
        ).rejects.toThrow(/INTEGRATION plans require a non-null cron schedule/);
    });

    test('invalid cron expression is rejected', async () => {
        await expect(
            scheduleTestPlan(makeCtx(), 'plan-1', {
                schedule: 'every tuesday at noon',
                automationType: 'SCRIPT',
            }),
        ).rejects.toThrow(/Invalid cron expression/);
    });

    test('unknown timezone is rejected', async () => {
        await expect(
            scheduleTestPlan(makeCtx(), 'plan-1', {
                schedule: '0 9 * * *',
                scheduleTimezone: 'Mars/Olympus_Mons',
                automationType: 'SCRIPT',
            }),
        ).rejects.toThrow(/Unknown timezone/);
    });
});

describe('scheduleTestPlan — happy path', () => {
    test('SCRIPT + cron + UTC sets all fields and recomputes nextRunAt', async () => {
        mockTx.controlTestPlan.findFirst.mockResolvedValueOnce({
            id: 'plan-1',
            tenantId: 'tenant-1',
            automationType: 'MANUAL',
            schedule: null,
            scheduleTimezone: null,
            nextRunAt: null,
        });
        mockTx.controlTestPlan.update.mockResolvedValueOnce({
            id: 'plan-1',
            automationType: 'SCRIPT',
        });

        await scheduleTestPlan(makeCtx(), 'plan-1', {
            schedule: '0 9 * * *',
            scheduleTimezone: 'UTC',
            automationType: 'SCRIPT',
            automationConfig: { scriptId: 'aws.iam.password-policy' },
        });

        expect(mockTx.controlTestPlan.update).toHaveBeenCalledTimes(1);
        const updateCall = mockTx.controlTestPlan.update.mock.calls[0][0];
        expect(updateCall.where).toEqual({ id: 'plan-1' });
        expect(updateCall.data).toMatchObject({
            automationType: 'SCRIPT',
            schedule: '0 9 * * *',
            scheduleTimezone: 'UTC',
            // lastScheduledRunAt is cleared because the schedule
            // context just shifted — prior tick bookkeeping is stale.
            lastScheduledRunAt: null,
        });
        expect(updateCall.data.automationConfig).toEqual({
            scriptId: 'aws.iam.password-policy',
        });
        expect(updateCall.data.nextRunAt).toBeInstanceOf(Date);
    });

    test('clearing schedule (MANUAL + null) sets nextRunAt to null', async () => {
        mockTx.controlTestPlan.findFirst.mockResolvedValueOnce({
            id: 'plan-1',
            tenantId: 'tenant-1',
            automationType: 'SCRIPT',
            schedule: '0 9 * * *',
            scheduleTimezone: 'UTC',
            nextRunAt: new Date(),
        });
        mockTx.controlTestPlan.update.mockResolvedValueOnce({ id: 'plan-1' });

        await scheduleTestPlan(makeCtx(), 'plan-1', {
            schedule: null,
            automationType: 'MANUAL',
        });

        const updateCall = mockTx.controlTestPlan.update.mock.calls[0][0];
        expect(updateCall.data).toMatchObject({
            automationType: 'MANUAL',
            schedule: null,
            nextRunAt: null,
            lastScheduledRunAt: null,
        });
    });

    test('plan-not-found surfaces a notFound error', async () => {
        mockTx.controlTestPlan.findFirst.mockResolvedValueOnce(null);
        await expect(
            scheduleTestPlan(makeCtx(), 'plan-missing', {
                schedule: '0 9 * * *',
                automationType: 'SCRIPT',
            }),
        ).rejects.toThrow(/Test plan not found/);
        expect(mockTx.controlTestPlan.update).not.toHaveBeenCalled();
    });
});

// PR-Q — `getUpcomingTests` (and its `/tests/upcoming` route) was removed as
// dead surface (no UI consumer; the dashboard's "upcoming" comes from
// getTestDashboard). The reconciled due/upcoming signal now lives in
// due-planning.ts (effectiveDueAt over both clocks) and is covered there.

// ═══════════════════════════════════════════════════════════════════
// 3. getTestDashboard
// ═══════════════════════════════════════════════════════════════════

describe('getTestDashboard', () => {
    test('rejects callers without canRead', async () => {
        await expect(
            getTestDashboard(makeCtx({ canRead: false })),
        ).rejects.toThrow(/permission/i);
    });

    test('coerces invalid period to 30 days', async () => {
        mockTx.controlTestPlan.count.mockResolvedValue(0);
        mockTx.controlTestPlan.findMany.mockResolvedValue([]);
        mockTx.controlTestRun.findMany.mockResolvedValue([]);

        const result = await getTestDashboard(makeCtx(), 999);
        expect(result.periodDays).toBe(30);
    });

    test('aggregates automation counts in parallel', async () => {
        // Five .count() calls: manual, script, integration, scheduled-active, overdue
        mockTx.controlTestPlan.count
            .mockResolvedValueOnce(5)   // MANUAL
            .mockResolvedValueOnce(2)   // SCRIPT
            .mockResolvedValueOnce(1)   // INTEGRATION
            .mockResolvedValueOnce(3)   // scheduled active
            .mockResolvedValueOnce(1);  // overdue
        mockTx.controlTestPlan.findMany.mockResolvedValueOnce([]);
        mockTx.controlTestRun.findMany.mockResolvedValueOnce([]);

        const result = await getTestDashboard(makeCtx(), 30);

        expect(result.automation).toEqual({
            plansManual: 5,
            plansScript: 2,
            plansIntegration: 1,
            plansScheduledActive: 3,
            overdueScheduled: 1,
        });
    });

    test('per-day trend buckets COMPLETED runs by UTC date of executedAt', async () => {
        mockTx.controlTestPlan.count.mockResolvedValue(0);
        mockTx.controlTestPlan.findMany.mockResolvedValueOnce([]);

        // Three runs across three different days within the last 7 days.
        const today = new Date();
        const yesterday = new Date(today.getTime() - 86_400_000);
        const twoDaysAgo = new Date(today.getTime() - 2 * 86_400_000);

        mockTx.controlTestRun.findMany.mockResolvedValueOnce([
            { result: 'PASS', executedAt: today },
            { result: 'FAIL', executedAt: yesterday },
            { result: 'INCONCLUSIVE', executedAt: twoDaysAgo },
            // A run from outside the period — should be ignored even
            // though Prisma mock returned it (defensive).
            {
                result: 'PASS',
                executedAt: new Date(today.getTime() - 100 * 86_400_000),
            },
        ]);

        const result = await getTestDashboard(makeCtx(), 30);

        expect(result.trend.days).toHaveLength(30);
        // sum(pass) = 1, sum(fail) = 1, sum(inconclusive) = 1
        const totalPass = result.trend.pass.reduce((a, b) => a + b, 0);
        const totalFail = result.trend.fail.reduce((a, b) => a + b, 0);
        const totalInc = result.trend.inconclusive.reduce((a, b) => a + b, 0);
        expect(totalPass).toBe(1);
        expect(totalFail).toBe(1);
        expect(totalInc).toBe(1);
        // Days are oldest → newest.
        expect(result.trend.days[0] < result.trend.days[29]).toBe(true);
    });

    test('upcoming list is capped at 10 and sorted by nextRunAt asc', async () => {
        mockTx.controlTestPlan.count.mockResolvedValue(0);
        mockTx.controlTestRun.findMany.mockResolvedValueOnce([]);
        mockTx.controlTestPlan.findMany.mockResolvedValueOnce([]);

        await getTestDashboard(makeCtx(), 30);

        const findManyCall = mockTx.controlTestPlan.findMany.mock.calls[0][0];
        expect(findManyCall.take).toBe(10);
        expect(findManyCall.orderBy).toEqual({ nextRunAt: 'asc' });
        expect(findManyCall.where.automationType).toEqual({
            in: ['SCRIPT', 'INTEGRATION'],
        });
    });
});
