/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks +
 * fakeDb shims mirror runtime Prisma contracts; per-line typing has
 * poor cost/benefit in test files (codebase convention — see
 * tests/unit/usecases/control-test.test.ts). */
/**
 * Unit tests for src/app-layer/usecases/due-planning.ts
 *
 * The due-planning usecase drives the control-test cadence engine.
 * Four functions, each branch-dense:
 *
 *   - getDueQueue            — overdue/due-soon classification
 *                              (isOverdue, hasPendingRun derived
 *                              fields).
 *   - runDuePlanning         — IDEMPOTENT batch run-creation; the
 *                              core invariant is "skip plans that
 *                              already have a PLANNED/RUNNING run".
 *   - getTestDashboardMetrics— rate maths with divide-by-zero guards
 *                              + the ≥2-FAIL repeated-failure rollup.
 *   - listAllTestPlans       — filter-to-where translation.
 *
 * Branch coverage protects: the idempotency filter (a regression
 * here double-books test runs), every rate's zero-denominator guard
 * (a regression here is a NaN on the dashboard), and the RBAC gate
 * separation (read vs manage).
 */

jest.mock('@/lib/db-context', () => {
    // getTestDashboardMetrics now routes via runInTenantReadContext;
    // share ONE mock fn so the per-test mockImplementationOnce(...) on
    // runInTenantContext applies to the read path too.
    const fn = jest.fn();
    return { runInTenantContext: fn, runInTenantReadContext: fn };
});

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    getDueQueue,
    runDuePlanning,
    getTestDashboardMetrics,
    listAllTestPlans,
} from '@/app-layer/usecases/due-planning';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext, READER_APP_PERMISSIONS } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const mockLog = logEvent as jest.MockedFunction<typeof logEvent>;

beforeEach(() => {
    jest.clearAllMocks();
});

// A minimal fakeDb — only the methods each test exercises are stubbed.
function fakeDb(overrides: Record<string, any> = {}) {
    return {
        controlTestPlan: { findMany: jest.fn(), count: jest.fn() },
        controlTestRun: { findMany: jest.fn(), create: jest.fn() },
        control: { findMany: jest.fn() },
        ...overrides,
    };
}

describe('getDueQueue', () => {
    it('rejects a caller without read permission', async () => {
        // READER still has canRead — use a context with canRead false.
        const ctx = makeRequestContext('READER', {
            permissions: {
                canRead: false,
                canWrite: false,
                canAdmin: false,
                canAudit: false,
                canExport: false,
            },
            // assertCanReadTests now gates on appPermissions.tests.view
            // (custom-role-aware), so deny it there too.
            appPermissions: {
                ...READER_APP_PERMISSIONS,
                tests: { view: false, create: false, execute: false },
            },
        });
        await expect(getDueQueue(ctx)).rejects.toThrow(/permission/i);
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('derives isOverdue + hasPendingRun per plan', async () => {
        const past = new Date(Date.now() - 86400000);
        const future = new Date(Date.now() + 3 * 86400000);
        const db = fakeDb();
        db.controlTestPlan.findMany.mockResolvedValue([
            { id: 'p1', nextDueAt: past, runs: [{ id: 'r1' }] },
            { id: 'p2', nextDueAt: future, runs: [] },
            { id: 'p3', nextDueAt: null, runs: [] },
        ]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const queue = await getDueQueue(makeRequestContext('EDITOR'));

        expect(queue[0]).toMatchObject({ id: 'p1', isOverdue: true, hasPendingRun: true });
        expect(queue[1]).toMatchObject({ id: 'p2', isOverdue: false, hasPendingRun: false });
        // nextDueAt === null → isOverdue is false (not a crash)
        expect(queue[2]).toMatchObject({ id: 'p3', isOverdue: false, hasPendingRun: false });
    });
});

describe('runDuePlanning — idempotency', () => {
    it('rejects a caller without write permission', async () => {
        await expect(runDuePlanning(makeRequestContext('READER'))).rejects.toThrow(
            /permission/i,
        );
        expect(mockRunInTx).not.toHaveBeenCalled();
    });

    it('creates PLANNED runs only for due plans WITHOUT a pending run', async () => {
        const db = fakeDb();
        db.controlTestPlan.findMany.mockResolvedValue([
            { id: 'plan-a', controlId: 'c-a', runs: [] }, // needs a run
            { id: 'plan-b', controlId: 'c-b', runs: [{ id: 'existing' }] }, // already pending — skip
            { id: 'plan-c', controlId: 'c-c', runs: [] }, // needs a run
        ]);
        let nextId = 0;
        db.controlTestRun.create.mockImplementation(async () => ({ id: `run-${++nextId}` }));
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const result = await runDuePlanning(makeRequestContext('ADMIN'));

        expect(result.checked).toBe(3);
        expect(result.alreadyPending).toBe(1);
        expect(result.created).toBe(2);
        expect(result.runIds).toEqual(['run-1', 'run-2']);
        // The skipped plan's controlId must never reach create().
        expect(db.controlTestRun.create).toHaveBeenCalledTimes(2);
        const createdControls = db.controlTestRun.create.mock.calls.map(
            (c: any) => c[0].data.controlId,
        );
        expect(createdControls).toEqual(['c-a', 'c-c']);
    });

    it('never picks up cron-SCHEDULED plans — those belong to the scheduler', async () => {
        // Dedupe by disjoint OWNERSHIP rather than a cross-process lock: the
        // scheduler claims a scheduled plan and enqueues a runner job, and
        // there's a window before the runner writes its row where the
        // pending-run filter sees nothing — so this path would mint a SECOND
        // PLANNED run for the same occurrence. Querying `schedule: null` makes
        // the double-run impossible by construction.
        const db = fakeDb();
        db.controlTestPlan.findMany.mockResolvedValue([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await runDuePlanning(makeRequestContext('ADMIN'));

        const where = db.controlTestPlan.findMany.mock.calls[0][0].where;
        expect(where.schedule).toBeNull();
        expect(where.status).toBe('ACTIVE');
    });

    it('is a no-op (creates nothing) when every due plan already has a pending run', async () => {
        const db = fakeDb();
        db.controlTestPlan.findMany.mockResolvedValue([
            { id: 'plan-a', controlId: 'c-a', runs: [{ id: 'r' }] },
        ]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const result = await runDuePlanning(makeRequestContext('ADMIN'));

        expect(result.created).toBe(0);
        expect(result.alreadyPending).toBe(1);
        expect(db.controlTestRun.create).not.toHaveBeenCalled();
    });

    it('emits a DUE_PLANNING_EXECUTED audit event carrying the batch counts', async () => {
        const db = fakeDb();
        db.controlTestPlan.findMany.mockResolvedValue([
            { id: 'plan-a', controlId: 'c-a', runs: [] },
        ]);
        db.controlTestRun.create.mockResolvedValue({ id: 'run-1' });
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await runDuePlanning(makeRequestContext('ADMIN'));

        expect(mockLog).toHaveBeenCalledTimes(1);
        const logArg = mockLog.mock.calls[0][2] as any;
        expect(logArg.action).toBe('DUE_PLANNING_EXECUTED');
        expect(logArg.detailsJson.created).toBe(1);
        expect(logArg.detailsJson.runIds).toEqual(['run-1']);
    });
});

describe('getTestDashboardMetrics — rate maths', () => {
    it('rejects a caller without read permission', async () => {
        const ctx = makeRequestContext('READER', {
            permissions: {
                canRead: false,
                canWrite: false,
                canAdmin: false,
                canAudit: false,
                canExport: false,
            },
            // assertCanReadTests now gates on appPermissions.tests.view
            // (custom-role-aware), so deny it there too.
            appPermissions: {
                ...READER_APP_PERMISSIONS,
                tests: { view: false, create: false, execute: false },
            },
        });
        await expect(getTestDashboardMetrics(ctx)).rejects.toThrow(/permission/i);
    });

    it('returns all-zero rates when there are no runs in the period (divide-by-zero guards)', async () => {
        const db = fakeDb();
        db.controlTestRun.findMany.mockResolvedValue([]);
        db.controlTestPlan.count.mockResolvedValue(0);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const m = await getTestDashboardMetrics(makeRequestContext('EDITOR'));

        expect(m.totalRuns).toBe(0);
        expect(m.completionRate).toBe(0);
        expect(m.passRate).toBe(0);
        expect(m.failRate).toBe(0);
        expect(m.evidenceRate).toBe(0);
        expect(m.repeatedFailures).toEqual([]);
        // No NaN must leak through any rate.
        expect(Number.isNaN(m.passRate)).toBe(false);
    });

    it('computes completion / pass / fail / evidence rates over completed runs', async () => {
        const db = fakeDb();
        db.controlTestRun.findMany.mockResolvedValue([
            { id: 'r1', status: 'COMPLETED', result: 'PASS', controlId: 'c1', evidence: [{ id: 'e' }] },
            { id: 'r2', status: 'COMPLETED', result: 'FAIL', controlId: 'c2', evidence: [] },
            { id: 'r3', status: 'COMPLETED', result: 'INCONCLUSIVE', controlId: 'c3', evidence: [] },
            { id: 'r4', status: 'RUNNING', result: null, controlId: 'c4', evidence: [] },
        ]);
        db.controlTestPlan.count.mockResolvedValue(7);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const m = await getTestDashboardMetrics(makeRequestContext('EDITOR'), 14);

        expect(m.periodDays).toBe(14);
        expect(m.totalRuns).toBe(4);
        expect(m.completedRuns).toBe(3);
        expect(m.passRuns).toBe(1);
        expect(m.failRuns).toBe(1);
        expect(m.inconclusiveRuns).toBe(1);
        // 3 of 4 runs completed → 75%
        expect(m.completionRate).toBe(75);
        // 1 of 3 completed runs passed → 33%
        expect(m.passRate).toBe(33);
        expect(m.failRate).toBe(33);
        // 1 of 3 completed runs carries evidence → 33%
        expect(m.evidenceRate).toBe(33);
    });

    it('rolls up controls with ≥2 FAIL runs and resolves their names', async () => {
        const db = fakeDb();
        db.controlTestRun.findMany.mockResolvedValue([
            { id: 'r1', status: 'COMPLETED', result: 'FAIL', controlId: 'c-bad', evidence: [] },
            { id: 'r2', status: 'COMPLETED', result: 'FAIL', controlId: 'c-bad', evidence: [] },
            { id: 'r3', status: 'COMPLETED', result: 'FAIL', controlId: 'c-once', evidence: [] },
        ]);
        db.controlTestPlan.count.mockResolvedValue(2);
        db.control.findMany.mockResolvedValue([
            { id: 'c-bad', name: 'Access Review', code: 'AC-2' },
        ]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const m = await getTestDashboardMetrics(makeRequestContext('EDITOR'));

        // Only c-bad has ≥2 fails — c-once (1 fail) is excluded.
        expect(m.repeatedFailures).toHaveLength(1);
        expect(m.repeatedFailures[0]).toMatchObject({
            controlId: 'c-bad',
            controlName: 'Access Review',
            controlCode: 'AC-2',
            failCount: 2,
        });
    });

    it('falls back to "Unknown" when a repeated-failure control row is missing', async () => {
        const db = fakeDb();
        db.controlTestRun.findMany.mockResolvedValue([
            { id: 'r1', status: 'COMPLETED', result: 'FAIL', controlId: 'c-ghost', evidence: [] },
            { id: 'r2', status: 'COMPLETED', result: 'FAIL', controlId: 'c-ghost', evidence: [] },
        ]);
        db.controlTestPlan.count.mockResolvedValue(1);
        db.control.findMany.mockResolvedValue([]); // control row absent
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        const m = await getTestDashboardMetrics(makeRequestContext('EDITOR'));

        expect(m.repeatedFailures[0].controlName).toBe('Unknown');
        expect(m.repeatedFailures[0].controlCode).toBeNull();
    });
});

describe('listAllTestPlans — filter translation', () => {
    it('rejects a caller without read permission', async () => {
        const ctx = makeRequestContext('READER', {
            permissions: {
                canRead: false,
                canWrite: false,
                canAdmin: false,
                canAudit: false,
                canExport: false,
            },
            // assertCanReadTests now gates on appPermissions.tests.view
            // (custom-role-aware), so deny it there too.
            appPermissions: {
                ...READER_APP_PERMISSIONS,
                tests: { view: false, create: false, execute: false },
            },
        });
        await expect(listAllTestPlans(ctx)).rejects.toThrow(/permission/i);
    });

    it('passes a bare tenant filter when no filters are supplied', async () => {
        const db = fakeDb();
        db.controlTestPlan.findMany.mockResolvedValue([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await listAllTestPlans(makeRequestContext('EDITOR'));

        const where = db.controlTestPlan.findMany.mock.calls[0][0].where;
        expect(where).toEqual({ tenantId: 'tenant-1' });
    });

    it('translates status + controlId + q filters into the where clause', async () => {
        const db = fakeDb();
        db.controlTestPlan.findMany.mockResolvedValue([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await listAllTestPlans(makeRequestContext('EDITOR'), {
            status: 'ACTIVE',
            controlId: 'c-1',
            q: 'firewall',
        });

        const where = db.controlTestPlan.findMany.mock.calls[0][0].where;
        expect(where.status).toBe('ACTIVE');
        expect(where.controlId).toBe('c-1');
        expect(where.name).toEqual({ contains: 'firewall', mode: 'insensitive' });
    });

    it('translates due=overdue into an either-clock upper bound (PR-Q)', async () => {
        const db = fakeDb();
        db.controlTestPlan.findMany.mockResolvedValue([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await listAllTestPlans(makeRequestContext('EDITOR'), { due: 'overdue' });

        // PR-Q — reconciled: overdue if EITHER nextDueAt or nextRunAt < now.
        const where = db.controlTestPlan.findMany.mock.calls[0][0].where;
        expect(where.OR).toEqual([
            { nextDueAt: { lt: expect.any(Date) } },
            { nextRunAt: { lt: expect.any(Date) } },
        ]);
        expect(where.nextDueAt).toBeUndefined();
    });

    it('translates due=next7d into an either-clock window (PR-Q)', async () => {
        const db = fakeDb();
        db.controlTestPlan.findMany.mockResolvedValue([]);
        mockRunInTx.mockImplementationOnce(async (_ctx, fn) => fn(db as never));

        await listAllTestPlans(makeRequestContext('EDITOR'), { due: 'next7d' });

        const where = db.controlTestPlan.findMany.mock.calls[0][0].where;
        expect(where.OR).toEqual([
            { nextDueAt: { gte: expect.any(Date), lte: expect.any(Date) } },
            { nextRunAt: { gte: expect.any(Date), lte: expect.any(Date) } },
        ]);
    });
});
