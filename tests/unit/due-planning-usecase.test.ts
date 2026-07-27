/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * Unit tests for `src/app-layer/usecases/due-planning.ts`.
 *
 * Roadmap Q3 — Work items adjacency. Tests the test-plan due queue,
 * the idempotent due-planning sweep, the dashboard metrics
 * aggregation, and the cross-control plan listing.
 *
 * Covers:
 *   - getDueQueue — isOverdue + hasPendingRun derivations.
 *   - runDuePlanning — idempotency (skip plans with pending runs),
 *     PLANNED run creation, DUE_PLANNING_EXECUTED audit shape.
 *   - getTestDashboardMetrics — completion/pass/fail/evidence rate
 *     math + zero-division safety + repeated-failure threshold
 *     (≥2) + Unknown name fallback.
 *   - listAllTestPlans — filter shape (status / controlId / due
 *     overdue / due next7d / q text search).
 */

const mockDb = {
    controlTestPlan: { findMany: jest.fn(), count: jest.fn() },
    controlTestRun: { create: jest.fn(), findMany: jest.fn(), groupBy: jest.fn(), count: jest.fn() },
    control: { findMany: jest.fn() },
} as any;

// R4-P3 #2 — getTestDashboardMetrics aggregates via groupBy (status×result,
// then controlId for FAILs) + count (evidence coverage). Helper wires both.
function wireMetricsGroupBy(
    statusResult: Array<{ status: string; result: string | null; _count: { _all: number } }>,
    failByControl: Array<{ controlId: string; _count: { _all: number } }>,
    evidenceCount = 0,
) {
    (mockDb.controlTestRun.groupBy as jest.Mock).mockImplementation(async (args: any) =>
        args.by.includes('status') ? statusResult : failByControl,
    );
    (mockDb.controlTestRun.count as jest.Mock).mockResolvedValue(evidenceCount);
}

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
    runInTenantReadContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(),
}));

import { logEvent } from '@/app-layer/events/audit';
import {
    getDueQueue,
    runDuePlanning,
    getTestDashboardMetrics,
    listAllTestPlans,
} from '@/app-layer/usecases/due-planning';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    jest.clearAllMocks();
});

const adminCtx = makeRequestContext('ADMIN');
const editorCtx = makeRequestContext('EDITOR');
const readerCtx = makeRequestContext('READER');

// ─── getDueQueue ──────────────────────────────────────────────────

describe('getDueQueue', () => {
    it('derives isOverdue from nextDueAt vs now', async () => {
        const past = new Date(Date.now() - 86400000);
        const future = new Date(Date.now() + 86400000);
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([
            { id: 'p-1', nextDueAt: past, runs: [] },
            { id: 'p-2', nextDueAt: future, runs: [] },
            { id: 'p-3', nextDueAt: null, runs: [] },
        ]);

        const queue = await getDueQueue(readerCtx);

        expect(queue[0].isOverdue).toBe(true);
        expect(queue[1].isOverdue).toBe(false);
        expect(queue[2].isOverdue).toBe(false); // null nextDueAt → not overdue
    });

    it('derives hasPendingRun from the runs array length', async () => {
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([
            { id: 'p-1', nextDueAt: new Date(), runs: [{ id: 'r-1', status: 'PLANNED' }] },
            { id: 'p-2', nextDueAt: new Date(), runs: [] },
        ]);

        const queue = await getDueQueue(readerCtx);

        expect(queue[0].hasPendingRun).toBe(true);
        expect(queue[1].hasPendingRun).toBe(false);
    });

    it('includes any plan with either due clock (no frequency filter) — PR-Q', async () => {
        // PR-Q — reconciled due signal: a plan is due-eligible when EITHER
        // nextDueAt or nextRunAt is at/before the horizon, regardless of
        // frequency. The old `frequency != AD_HOC` filter made a cron-scheduled
        // AD_HOC plan permanently invisible; it is gone.
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([]);
        await getDueQueue(readerCtx);
        const args = (mockDb.controlTestPlan.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where.frequency).toBeUndefined();
        expect(args.where.OR).toEqual([
            { nextDueAt: { lte: expect.any(Date) } },
            { nextRunAt: { lte: expect.any(Date) } },
        ]);
        // Ordering is done in-memory by effectiveDueAt (Prisma can't order by
        // min(nextDueAt, nextRunAt)), so the query itself carries no orderBy.
        expect(args.orderBy).toBeUndefined();
    });
});

// ─── runDuePlanning ────────────────────────────────────────────────

describe('runDuePlanning — idempotency', () => {
    it('creates PLANNED runs only for plans without existing pending runs', async () => {
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([
            { id: 'p-1', controlId: 'c-1', runs: [{ id: 'r-existing' }] }, // already pending
            { id: 'p-2', controlId: 'c-2', runs: [] },                      // needs run
        ]);
        (mockDb.controlTestRun.create as jest.Mock).mockResolvedValueOnce({ id: 'r-new' });

        const res = await runDuePlanning(editorCtx);

        expect(res.checked).toBe(2);
        expect(res.alreadyPending).toBe(1);
        expect(res.created).toBe(1);
        expect(res.runIds).toEqual(['r-new']);
        expect(mockDb.controlTestRun.create).toHaveBeenCalledTimes(1);
        const runCreateArgs = (mockDb.controlTestRun.create as jest.Mock).mock.calls[0][0].data;
        expect(runCreateArgs.controlId).toBe('c-2');
        expect(runCreateArgs.status).toBe('PLANNED');
    });

    it('emits DUE_PLANNING_EXECUTED audit', async () => {
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([]);
        await runDuePlanning(editorCtx);
        const payload = (logEvent as jest.Mock).mock.calls[0][2];
        expect(payload.action).toBe('DUE_PLANNING_EXECUTED');
        expect(payload.detailsJson.event).toBe('due_planning_executed');
    });

    it('returns zero counts on idle (no due plans)', async () => {
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([]);
        const res = await runDuePlanning(editorCtx);
        expect(res).toEqual({ checked: 0, alreadyPending: 0, created: 0, runIds: [] });
    });

    it('rejects READER (manage-test-plans gate)', async () => {
        await expect(runDuePlanning(readerCtx)).rejects.toBeDefined();
        expect(mockDb.controlTestPlan.findMany).not.toHaveBeenCalled();
    });
});

// ─── getTestDashboardMetrics ──────────────────────────────────────

describe('getTestDashboardMetrics', () => {
    it('computes completion / pass / fail / evidence rates with the right rounding', async () => {
        // 4 runs: 3 COMPLETED (PASS×2, FAIL×1) + 1 RUNNING; 2 completed carry evidence.
        wireMetricsGroupBy(
            [
                { status: 'COMPLETED', result: 'PASS', _count: { _all: 2 } },
                { status: 'COMPLETED', result: 'FAIL', _count: { _all: 1 } },
                { status: 'RUNNING', result: null, _count: { _all: 1 } },
            ],
            [{ controlId: 'c-2', _count: { _all: 1 } }],
            2,
        );
        (mockDb.controlTestPlan.count as jest.Mock)
            .mockResolvedValueOnce(2)  // overdue
            .mockResolvedValueOnce(10); // totalPlans

        const m = await getTestDashboardMetrics(readerCtx);

        expect(m.totalRuns).toBe(4);
        expect(m.completedRuns).toBe(3);
        expect(m.passRuns).toBe(2);
        expect(m.failRuns).toBe(1);
        expect(m.completionRate).toBe(75); // 3/4
        expect(m.passRate).toBe(67);       // 2/3 rounded
        expect(m.failRate).toBe(33);
        expect(m.evidenceRate).toBe(67);   // 2/3 completed runs have evidence
        expect(m.overduePlans).toBe(2);
        expect(m.totalPlans).toBe(10);
    });

    it('returns zero rates when no runs exist (no division by zero)', async () => {
        wireMetricsGroupBy([], [], 0);
        (mockDb.controlTestPlan.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0);

        const m = await getTestDashboardMetrics(readerCtx);

        expect(m.completionRate).toBe(0);
        expect(m.passRate).toBe(0);
        expect(m.failRate).toBe(0);
        expect(m.evidenceRate).toBe(0);
    });

    it('flags controls with ≥2 FAIL runs as repeatedFailures', async () => {
        wireMetricsGroupBy(
            [{ status: 'COMPLETED', result: 'FAIL', _count: { _all: 3 } }],
            [
                { controlId: 'c-flaky', _count: { _all: 2 } },
                { controlId: 'c-once', _count: { _all: 1 } }, // single fail, NOT repeated
            ],
            0,
        );
        (mockDb.controlTestPlan.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        (mockDb.control.findMany as jest.Mock).mockResolvedValue([
            { id: 'c-flaky', name: 'Backup', code: 'A.8.13' },
        ]);

        const m = await getTestDashboardMetrics(readerCtx);

        expect(m.repeatedFailures).toEqual([
            { controlId: 'c-flaky', controlName: 'Backup', controlCode: 'A.8.13', failCount: 2 },
        ]);
    });

    it('falls back to Unknown name when control is missing from lookup', async () => {
        wireMetricsGroupBy(
            [{ status: 'COMPLETED', result: 'FAIL', _count: { _all: 2 } }],
            [{ controlId: 'c-orphan', _count: { _all: 2 } }],
            0,
        );
        (mockDb.controlTestPlan.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        (mockDb.control.findMany as jest.Mock).mockResolvedValue([]);

        const m = await getTestDashboardMetrics(readerCtx);

        expect(m.repeatedFailures[0].controlName).toBe('Unknown');
    });

    it('honours custom periodDays parameter', async () => {
        wireMetricsGroupBy([], [], 0);
        (mockDb.controlTestPlan.count as jest.Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0);
        const before = Date.now();

        const m = await getTestDashboardMetrics(readerCtx, 7);

        expect(m.periodDays).toBe(7);
        const groupByArgs = (mockDb.controlTestRun.groupBy as jest.Mock).mock.calls[0][0];
        const periodStart = groupByArgs.where.createdAt.gte as Date;
        const delta = before - periodStart.getTime();
        const sevenDays = 7 * 86_400_000;
        expect(delta).toBeGreaterThan(sevenDays - 5_000);
        expect(delta).toBeLessThan(sevenDays + 5_000);
    });
});

// ─── listAllTestPlans ──────────────────────────────────────────────

describe('listAllTestPlans — filter shape', () => {
    it('applies status filter when supplied', async () => {
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([]);
        await listAllTestPlans(readerCtx, { status: 'ACTIVE' });
        const args = (mockDb.controlTestPlan.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where.status).toBe('ACTIVE');
    });

    it('applies controlId filter when supplied', async () => {
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([]);
        await listAllTestPlans(readerCtx, { controlId: 'c-1' });
        const args = (mockDb.controlTestPlan.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where.controlId).toBe('c-1');
    });

    it('applies due=overdue (either clock < now) — PR-Q', async () => {
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([]);
        await listAllTestPlans(readerCtx, { due: 'overdue' });
        const args = (mockDb.controlTestPlan.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where.OR).toEqual([
            { nextDueAt: { lt: expect.any(Date) } },
            { nextRunAt: { lt: expect.any(Date) } },
        ]);
    });

    it('applies due=next7d (either clock between now and now+7d) — PR-Q', async () => {
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([]);
        await listAllTestPlans(readerCtx, { due: 'next7d' });
        const args = (mockDb.controlTestPlan.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where.OR).toEqual([
            { nextDueAt: { gte: expect.any(Date), lte: expect.any(Date) } },
            { nextRunAt: { gte: expect.any(Date), lte: expect.any(Date) } },
        ]);
    });

    it('applies q text search to name (case-insensitive)', async () => {
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([]);
        await listAllTestPlans(readerCtx, { q: 'backup' });
        const args = (mockDb.controlTestPlan.findMany as jest.Mock).mock.calls[0][0];
        expect(args.where.name).toEqual({ contains: 'backup', mode: 'insensitive' });
    });

    it('passes through with no filters when called bare', async () => {
        (mockDb.controlTestPlan.findMany as jest.Mock).mockResolvedValue([{ id: 'p-1' }]);
        const rows = await listAllTestPlans(readerCtx);
        expect(rows).toEqual([{ id: 'p-1' }]);
    });
});
// reference to keep import live in case future refactor drops it
void adminCtx;
