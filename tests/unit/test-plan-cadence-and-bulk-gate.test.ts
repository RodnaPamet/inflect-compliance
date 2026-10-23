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
        findFirst: jest.fn(),
        update: jest.fn(),
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
import { scheduleTestPlan } from '@/app-layer/usecases/test-scheduling';
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

/**
 * The same defect one function over, reached by an easier path.
 *
 * `scheduleTestPlan` recomputed `nextDueAt` from `new Date()` and wrote it
 * UNCONDITIONALLY — and it takes no `frequency` input at all, so the review
 * cadence cannot have changed. Every schedule edit, including merely turning
 * automation OFF, therefore restarted the human clock and forgave the backlog.
 *
 * `updateTestPlan` at least required a cadence change to trigger it. This one
 * fired on any schedule write, which makes it the more likely of the two to
 * have quietly erased real overdue state.
 */
describe('scheduleTestPlan — a schedule edit does not restart the review clock', () => {
    const overdueDue = new Date(Date.now() - 90 * DAY);

    beforeEach(() => {
        mockTx.controlTestPlan.findFirst.mockResolvedValue({
            id: 'plan_1',
            tenantId: 'tenant-1',
            automationType: 'MANUAL',
            schedule: null,
            scheduleTimezone: null,
            nextRunAt: null,
            frequency: 'MONTHLY',
            nextDueAt: overdueDue,
            createdAt: new Date(Date.now() - 400 * DAY),
        });
        mockTx.controlTestPlan.update.mockImplementation(async (args: any) => ({
            id: 'plan_1',
            ...args.data,
        }));
    });

    it('preserves an overdue nextDueAt when a cron schedule is applied', async () => {
        await scheduleTestPlan(makeRequestContext('ADMIN'), 'plan_1', {
            schedule: '0 9 * * *',
            scheduleTimezone: 'UTC',
            automationType: 'MANUAL',
        } as any);

        const written = mockTx.controlTestPlan.update.mock.calls[0][0].data;
        expect(written.nextDueAt).toEqual(overdueDue);
        expect(written.nextDueAt.getTime()).toBeLessThan(Date.now());
    });

    it('preserves it when the schedule is CLEARED — the easiest way to hit this', async () => {
        await scheduleTestPlan(makeRequestContext('ADMIN'), 'plan_1', {
            schedule: null,
            automationType: 'MANUAL',
        } as any);

        const written = mockTx.controlTestPlan.update.mock.calls[0][0].data;
        expect(written.nextDueAt).toEqual(overdueDue);
    });

    it('seeds nextDueAt from createdAt when the plan has never had one, clamping to the month end', async () => {
        // A FIXED month end, built from LOCAL components so it is the 31st in
        // whatever zone this runs in. It was `Date.now() - 400 * DAY`, which
        // made the test's verdict depend on the calendar — see the expectation
        // below for what that cost.
        const created = new Date(2025, 7, 31, 5, 32, 39, 767);
        mockTx.controlTestPlan.findFirst.mockResolvedValue({
            id: 'plan_1',
            tenantId: 'tenant-1',
            automationType: 'MANUAL',
            schedule: null,
            scheduleTimezone: null,
            nextRunAt: null,
            frequency: 'MONTHLY',
            nextDueAt: null,
            createdAt: created,
        });

        await scheduleTestPlan(makeRequestContext('ADMIN'), 'plan_1', {
            schedule: null,
            automationType: 'MANUAL',
        } as any);

        // THE EXPECTATION RESTATES THE RULE; IT DOES NOT RE-DERIVE THE BUG.
        //
        // This was `setMonth(getMonth() + 1)` — the naive rollover that
        // `computeNextDueAt` exists to avoid, and which agrees with the product
        // only by luck. `created` used to be 400 days ago, so the two diverged
        // exactly on the days when that landed on a 31st followed by a 30-day
        // month: on 2026-10-05 it was 31 August 2025, naive said 1 October, the
        // product said 30 September, and that disagreement false-reddened an
        // unrelated dependency PR (#3183) for eighteen days. Roughly a dozen
        // days a year; invisible, and green, on all the rest.
        //
        // So: one month on, with the day clamped to what the target month has.
        // Both sides read wall-clock getters, matching `addMonthsClamped`, so
        // this asserts the same thing in every timezone — and because `created`
        // is now pinned to a month end, a revert to the naive form reddens this
        // on every day of the year rather than on twelve of them.
        const written = mockTx.controlTestPlan.update.mock.calls[0][0].data;
        const due: Date = written.nextDueAt;

        const target = new Date(created);
        target.setDate(1);
        target.setMonth(target.getMonth() + 1);
        const daysInTarget = new Date(
            target.getFullYear(),
            target.getMonth() + 1,
            0,
        ).getDate();

        expect(due.getFullYear()).toBe(target.getFullYear());
        expect(due.getMonth()).toBe(target.getMonth());
        expect(due.getDate()).toBe(Math.min(created.getDate(), daysInTarget));
        // The time of day rides along untouched — a due date moves months, not hours.
        expect(due.getHours()).toBe(created.getHours());
        expect(due.getMinutes()).toBe(created.getMinutes());
    });

    /** The two-clocks invariant this must not break. */
    it('keeps nextDueAt independent of the cron-derived nextRunAt', async () => {
        await scheduleTestPlan(makeRequestContext('ADMIN'), 'plan_1', {
            schedule: '0 9 * * *',
            scheduleTimezone: 'UTC',
            automationType: 'MANUAL',
        } as any);

        const written = mockTx.controlTestPlan.update.mock.calls[0][0].data;
        expect(written.nextRunAt).toBeInstanceOf(Date);
        expect(written.nextDueAt).not.toEqual(written.nextRunAt);
    });
});
