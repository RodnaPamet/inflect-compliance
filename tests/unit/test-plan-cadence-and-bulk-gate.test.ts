/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks and
 * repository shims mirroring runtime contracts; the file-level disable is
 * this repo's standard for these surfaces (see control-test.test.ts). */
/**
 * Two defects on the test-plan usecase, each executed rather than grepped.
 *
 * ─── 1. A cadence edit must not forgive the backlog ───
 *
 * `updateTestPlan` called `computeNextDueAt(patch.frequency)` with no second
 * argument. That parameter defaults to `new Date()`, so the new due date was
 * computed from NOW rather than from anything about the plan — and a plan
 * three months overdue became "due in a month" the instant anyone adjusted its
 * cadence. The gap vanished from /tests/due, the dashboard and every
 * notification, with nothing in the trail to say why.
 *
 * The fix anchors the recomputation to when the plan was last actually tested.
 * These tests pin the ANCHOR, not the arithmetic — `computeNextDueAt` itself is
 * already covered in `control-test.test.ts`, and a test that only re-checked
 * the month maths would have passed against the broken code.
 *
 * ─── 2. The admin gate on destructive bulk actions ───
 *
 * `assertCanBulkManageTestPlans` gates on `admin.manage` and is the only thing
 * stopping an EDITOR mass-deleting the test programme 100 plans at a time. It
 * had FOUR references in `src/` and ZERO in `tests/`.
 *
 * Note what it actually guards, which is narrower than it first looks:
 * `bulkDeleteTestPlan` and `bulkRestoreTestPlan`. The other two bulk verbs —
 * `bulkSetTestPlanStatus` and `bulkAssignTestPlan` — use the plain
 * `assertCanManageTestPlans` (EDITOR) *by design*: pausing or reassigning is
 * recoverable, deleting the programme is not. So this asserts the split, not a
 * blanket admin rule; collapsing the two would either lock editors out of
 * routine work or hand them the delete.
 */
// `bulkDeleteTestPlan` reads and writes the tx directly rather than going
// through the repository, so the fake tx has to carry the delegate.
const mockTx = {
    controlTestPlan: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(
        async (_ctx: unknown, fn: (db: unknown) => Promise<unknown>) => fn(mockTx),
    ),
    PrismaTx: {},
}));

const repo = {
    getById: jest.fn(),
    update: jest.fn(),
    updateNextDueAt: jest.fn(),
    lastCompletedRunAt: jest.fn(),
    bulkSoftDelete: jest.fn(),
    bulkRestore: jest.fn(),
    listByIds: jest.fn(),
    bulkUpdate: jest.fn(),
};
jest.mock('@/app-layer/repositories/TestPlanRepository', () => ({
    TestPlanRepository: new Proxy(
        {},
        { get: (_t, k: string) => (repo as any)[k] },
    ),
}));

const mockLogEvent = jest.fn();
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: (...a: unknown[]) => mockLogEvent(...a),
}));

jest.mock('@/app-layer/events/test.events', () => ({
    emitTestPlanCreated: jest.fn(),
    emitTestPlanUpdated: jest.fn(),
    emitTestPlanStatusChanged: jest.fn(),
    emitTestPlanStatusAutomationEvent: jest.fn(),
    emitTestRunCreated: jest.fn(),
    emitTestRunCompleted: jest.fn(),
    emitTestRunFailed: jest.fn(),
    emitTestEvidenceLinked: jest.fn(),
    emitTestEvidenceUnlinked: jest.fn(),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
}));

import { updateTestPlan, bulkDeleteTestPlan } from '@/app-layer/usecases/control/test-plans';
import { makeRequestContext } from '../helpers/make-context';

const DAY = 24 * 60 * 60 * 1000;

/** A plan last completed 120 days ago and 90 days overdue on a MONTHLY cadence. */
function overduePlan(over: Record<string, unknown> = {}) {
    return {
        id: 'plan_1',
        frequency: 'MONTHLY',
        status: 'ACTIVE',
        nextDueAt: new Date(Date.now() - 90 * DAY),
        createdAt: new Date(Date.now() - 400 * DAY),
        ...over,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    repo.update.mockResolvedValue({ id: 'plan_1' });
    repo.updateNextDueAt.mockResolvedValue({});
    repo.lastCompletedRunAt.mockResolvedValue(null);
    // `assertOwnerIsActiveMember` short-circuits on an undefined ownerUserId,
    // so no membership fixture is needed for these patches.
});

describe('updateTestPlan — a cadence change is anchored, not reset to now', () => {
    it('keeps an overdue plan overdue when the cadence changes', async () => {
        const plan = overduePlan();
        repo.getById.mockResolvedValue(plan);
        // Last actually tested 120 days ago.
        repo.lastCompletedRunAt.mockResolvedValue(new Date(Date.now() - 120 * DAY));

        await updateTestPlan(makeRequestContext('ADMIN'), 'plan_1', {
            frequency: 'QUARTERLY',
        } as any);

        const written = repo.updateNextDueAt.mock.calls[0][3] as Date;
        // 120 days ago + one quarter ≈ 30 days ago — still in the past.
        // Under the old code this was `now + 1 quarter`, i.e. comfortably
        // future, and the plan silently stopped being overdue.
        expect(written.getTime()).toBeLessThan(Date.now());
    });

    it('measures from the last completed run, not from now', async () => {
        const lastRun = new Date(Date.now() - 10 * DAY);
        repo.getById.mockResolvedValue(overduePlan());
        repo.lastCompletedRunAt.mockResolvedValue(lastRun);

        await updateTestPlan(makeRequestContext('ADMIN'), 'plan_1', {
            frequency: 'WEEKLY',
        } as any);

        const written = repo.updateNextDueAt.mock.calls[0][3] as Date;
        const expected = new Date(lastRun);
        expected.setDate(expected.getDate() + 7);
        expect(written.toISOString()).toBe(expected.toISOString());
    });

    it('falls back to the previous due date when the plan has never completed a run', async () => {
        const prevDue = new Date(Date.now() - 45 * DAY);
        repo.getById.mockResolvedValue(overduePlan({ nextDueAt: prevDue }));
        repo.lastCompletedRunAt.mockResolvedValue(null);

        await updateTestPlan(makeRequestContext('ADMIN'), 'plan_1', {
            frequency: 'WEEKLY',
        } as any);

        const written = repo.updateNextDueAt.mock.calls[0][3] as Date;
        const expected = new Date(prevDue);
        expected.setDate(expected.getDate() + 7);
        expect(written.toISOString()).toBe(expected.toISOString());
    });

    it('falls back to createdAt when there is neither a run nor a due date', async () => {
        const created = new Date(Date.now() - 200 * DAY);
        repo.getById.mockResolvedValue(
            overduePlan({ nextDueAt: null, createdAt: created }),
        );
        repo.lastCompletedRunAt.mockResolvedValue(null);

        await updateTestPlan(makeRequestContext('ADMIN'), 'plan_1', {
            frequency: 'WEEKLY',
        } as any);

        const written = repo.updateNextDueAt.mock.calls[0][3] as Date;
        const expected = new Date(created);
        expected.setDate(expected.getDate() + 7);
        expect(written.toISOString()).toBe(expected.toISOString());
    });

    /**
     * A relaxed cadence CAN legitimately clear an overdue state — a control
     * tested four months ago is genuinely not overdue once it becomes an
     * annual check. That is a real decision, so it is recorded rather than
     * blocked. What must never happen is the state disappearing with nothing
     * to explain it.
     */
    it('records an audit entry when the recomputation clears an overdue state', async () => {
        repo.getById.mockResolvedValue(overduePlan());
        repo.lastCompletedRunAt.mockResolvedValue(new Date(Date.now() - 120 * DAY));

        await updateTestPlan(makeRequestContext('ADMIN'), 'plan_1', {
            frequency: 'ANNUALLY',
        } as any);

        const written = repo.updateNextDueAt.mock.calls[0][3] as Date;
        expect(written.getTime()).toBeGreaterThan(Date.now());

        const actions = mockLogEvent.mock.calls.map((c) => c[2]?.action);
        expect(actions).toContain('TEST_PLAN_OVERDUE_CLEARED_BY_CADENCE');
    });

    it('does NOT record that entry when the plan stays overdue', async () => {
        repo.getById.mockResolvedValue(overduePlan());
        repo.lastCompletedRunAt.mockResolvedValue(new Date(Date.now() - 120 * DAY));

        await updateTestPlan(makeRequestContext('ADMIN'), 'plan_1', {
            frequency: 'QUARTERLY',
        } as any);

        const actions = mockLogEvent.mock.calls.map((c) => c[2]?.action);
        expect(actions).not.toContain('TEST_PLAN_OVERDUE_CLEARED_BY_CADENCE');
    });

    it('leaves nextDueAt alone when the frequency did not change', async () => {
        repo.getById.mockResolvedValue(overduePlan({ frequency: 'MONTHLY' }));

        await updateTestPlan(makeRequestContext('ADMIN'), 'plan_1', {
            frequency: 'MONTHLY',
        } as any);

        expect(repo.updateNextDueAt).not.toHaveBeenCalled();
    });
});

describe('bulkDeleteTestPlan — the admin gate is real', () => {
    it('refuses an EDITOR', async () => {
        await expect(
            bulkDeleteTestPlan(makeRequestContext('EDITOR'), ['plan_1']),
        ).rejects.toThrow(/administrator required/i);
    });

    it('refuses a READER', async () => {
        await expect(
            bulkDeleteTestPlan(makeRequestContext('READER'), ['plan_1']),
        ).rejects.toThrow(/administrator required/i);
    });

    it('refuses before touching the repository — no partial delete', async () => {
        await expect(
            bulkDeleteTestPlan(makeRequestContext('EDITOR'), ['plan_1']),
        ).rejects.toThrow();
        // The gate must fire ahead of any read or write. A refusal that still
        // ran the deleteMany would erase the programme and then report 403.
        expect(mockTx.controlTestPlan.findMany).not.toHaveBeenCalled();
        expect(mockTx.controlTestPlan.deleteMany).not.toHaveBeenCalled();
    });

    it('admits an ADMIN and deletes', async () => {
        mockTx.controlTestPlan.findMany.mockResolvedValue([{ id: 'plan_1' }]);
        mockTx.controlTestPlan.deleteMany.mockResolvedValue({ count: 1 });

        await expect(
            bulkDeleteTestPlan(makeRequestContext('ADMIN'), ['plan_1']),
        ).resolves.toEqual({ deleted: 1 });
    });
});
