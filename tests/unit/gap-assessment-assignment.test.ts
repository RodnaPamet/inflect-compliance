/**
 * Unit coverage for the NIS2 gap-assessment assignment usecase surface.
 *
 * The DB-bound flows (dispatch/submit/finalize) are driven here with a mocked
 * `runInTenantContext` + `db`, so every authorization / validation / idempotency
 * branch is exercised without a live database (the integration suite proves the
 * real RLS path).
 */
jest.mock('@/lib/db-context', () => ({ runInTenantContext: jest.fn() }));
jest.mock('../../src/app-layer/policies/common', () => ({
    assertCanRead: jest.fn(),
    assertCanWrite: jest.fn(),
}));
jest.mock('../../src/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('../../src/app-layer/usecases/task', () => ({ createTask: jest.fn().mockResolvedValue({ id: 'task-1' }) }));
jest.mock('../../src/app-layer/usecases/nis2-readiness', () => ({ snapshotNis2Readiness: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/app-layer/repositories/Nis2GapAssessmentRepository', () => ({
    Nis2GapAssessmentRepository: {
        listQuestions: jest.fn(),
        listDomains: jest.fn(),
        listAnswers: jest.fn(),
        upsertAnswer: jest.fn(),
        markAssessmentCompleted: jest.fn(),
        lockAssessmentStatusForShare: jest.fn(),
    },
}));

import {
    NIS2_RESPONDENT_ROLES,
    partitionByRespondent,
    dispatchAssignments,
    submitAssignmentAnswers,
    finalizeAssessment,
    getAssignmentForRespondent,
    listAssignments,
} from '@/app-layer/usecases/gap-assessment-assignment';
import { runInTenantContext } from '@/lib/db-context';
import { assertCanRead, assertCanWrite } from '@/app-layer/policies/common';
import { Nis2GapAssessmentRepository } from '@/app-layer/repositories/Nis2GapAssessmentRepository';
import { createTask } from '@/app-layer/usecases/task';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;
const repo = Nis2GapAssessmentRepository as jest.Mocked<typeof Nis2GapAssessmentRepository>;
const mockCreateTask = createTask as jest.MockedFunction<typeof createTask>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (over: any = {}): any => ({ tenantId: 't1', userId: 'u1', role: 'ADMIN', appPermissions: {}, ...over });

/** Run the usecase's `runInTenantContext` callback against a supplied mock db. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withDb(db: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRunInTx.mockImplementation(async (_c: any, fn: any) => fn(db));
}

const QUESTIONS = [
    { id: 'q1', respondent: 'CEO' },
    { id: 'q2', respondent: 'IT' },
    { id: 'q3', respondent: 'ZZZ-unknown' }, // falls back to ANYONE
];

beforeEach(() => {
    jest.clearAllMocks();
    repo.listQuestions.mockResolvedValue(QUESTIONS as never);
    repo.lockAssessmentStatusForShare.mockResolvedValue({ status: 'IN_PROGRESS' });
});

describe('gap-assessment-assignment — surface', () => {
    it('exposes the five NIS2 respondent roles', () => {
        expect([...NIS2_RESPONDENT_ROLES]).toEqual(['CEO', 'IT', 'HR', 'PROCUREMENT', 'ANYONE']);
    });
});

describe('partitionByRespondent', () => {
    it('buckets by respondent and falls unknown roles back to ANYONE', async () => {
        withDb({});
        const buckets = await partitionByRespondent(ctx());
        expect(buckets.CEO).toEqual(['q1']);
        expect(buckets.IT).toEqual(['q2']);
        expect(buckets.ANYONE).toEqual(['q3']); // unknown respondent → ANYONE
        expect(buckets.HR).toEqual([]);
    });
});

describe('dispatchAssignments', () => {
    function db(over: Record<string, unknown> = {}) {
        return {
            nis2SelfAssessment: { findFirst: jest.fn().mockResolvedValue({ id: 'a1', source: 'STANDALONE' }) },
            nis2GapAssignment: {
                findUnique: jest.fn().mockResolvedValue(null),
                upsert: jest.fn().mockResolvedValue({ id: 'asg-1' }),
            },
            notification: { create: jest.fn().mockResolvedValue({}) },
            // The context below carries no `tenantSlug` (a job-style context),
            // so the notification link's slug is looked up.
            tenant: { findUnique: jest.fn().mockResolvedValue({ slug: 'acme' }) },
            ...over,
        };
    }

    it('throws notFound when the assessment is missing', async () => {
        const d = db({ nis2SelfAssessment: { findFirst: jest.fn().mockResolvedValue(null) } });
        withDb(d);
        await expect(dispatchAssignments(ctx(), 'a1', {})).rejects.toThrow(/not found/i);
    });

    it('rejects a WIZARD_BASELINE run', async () => {
        const d = db({ nis2SelfAssessment: { findFirst: jest.fn().mockResolvedValue({ id: 'a1', source: 'WIZARD_BASELINE' }) } });
        withDb(d);
        await expect(dispatchAssignments(ctx(), 'a1', {})).rejects.toThrow(/baseline/i);
    });

    it('creates assignments + a task/notification for each newly-assigned role', async () => {
        const d = db();
        withDb(d);
        const res = await dispatchAssignments(ctx(), 'a1', { CEO: 'user-ceo', IT: 'user-it' });
        // CEO, IT, ANYONE all have questions → 3 upserts; HR/PROCUREMENT empty → skipped.
        expect(d.nis2GapAssignment.upsert).toHaveBeenCalledTimes(3);
        expect(res.assignmentsCreated).toBe(3);
        expect(res.assignmentsUpdated).toBe(0);
        // Only CEO + IT had an assignee → 2 tasks.
        expect(mockCreateTask).toHaveBeenCalledTimes(2);
        expect(res.tasksCreated).toBe(2);
    });

    it('links the assignee notification inside the workspace, not to a bare tenant path (#4128)', async () => {
        const d = db();
        withDb(d);
        await dispatchAssignments(ctx(), 'a1', { CEO: 'user-ceo' });
        expect(d.notification.create).toHaveBeenCalledTimes(1);
        expect(d.notification.create.mock.calls[0][0].data.linkUrl).toBe('/t/acme/audits/nis2-gap/respond/asg-1');
        // Looked up once for the dispatch, not once per role.
        expect(d.tenant.findUnique).toHaveBeenCalledTimes(1);
    });

    it('counts an existing assignment as updated and skips the task when the assignee is unchanged', async () => {
        const d = db({
            nis2GapAssignment: {
                findUnique: jest.fn().mockResolvedValue({ id: 'asg-x', assigneeUserId: 'user-ceo' }),
                upsert: jest.fn().mockResolvedValue({ id: 'asg-x' }),
            },
        });
        withDb(d);
        const res = await dispatchAssignments(ctx(), 'a1', { CEO: 'user-ceo' });
        expect(res.assignmentsUpdated).toBe(3);
        expect(res.assignmentsCreated).toBe(0);
        // CEO assignee unchanged → no task; IT/ANYONE have no assignee → no task.
        expect(res.tasksCreated).toBe(0);
    });

    it('a notification failure does not fail dispatch', async () => {
        const d = db({
            notification: { create: jest.fn().mockRejectedValue(new Error('dedupe')) },
        });
        withDb(d);
        await expect(dispatchAssignments(ctx(), 'a1', { CEO: 'user-ceo' })).resolves.toMatchObject({ assignmentsCreated: 3 });
    });
});

describe('listAssignments', () => {
    it('lists by assessment', async () => {
        const d = { nis2GapAssignment: { findMany: jest.fn().mockResolvedValue([{ id: 'asg-1' }]) } };
        withDb(d);
        await expect(listAssignments(ctx(), 'a1')).resolves.toEqual([{ id: 'asg-1' }]);
    });
});

describe('getAssignmentForRespondent', () => {
    function d(assignment: unknown, runStatus: string = 'IN_PROGRESS') {
        return {
            nis2GapAssignment: { findFirst: jest.fn().mockResolvedValue(assignment) },
            nis2SelfAssessment: { findFirst: jest.fn().mockResolvedValue({ status: runStatus }) },
        };
    }
    beforeEach(() => {
        repo.listDomains.mockResolvedValue([{ id: 'd1' }] as never);
        repo.listAnswers.mockResolvedValue([{ questionId: 'q1', answer: 'YES', note: null }] as never);
    });

    it('throws notFound when the assignment is missing', async () => {
        withDb(d(null));
        await expect(getAssignmentForRespondent(ctx(), 'asg-1')).rejects.toThrow(/not found/i);
    });

    it('forbids a non-assignee non-admin', async () => {
        withDb(d({ id: 'asg-1', assigneeUserId: 'other', assessmentId: 'a1', questionIds: ['q1'] }));
        await expect(
            getAssignmentForRespondent(ctx({ role: 'EDITOR', userId: 'u1' }), 'asg-1'),
        ).rejects.toThrow(/another member/i);
    });

    it('returns the scoped bucket for the assignee', async () => {
        withDb(d({ id: 'asg-1', assigneeUserId: 'u1', assessmentId: 'a1', questionIds: ['q1'] }));
        const out = await getAssignmentForRespondent(ctx({ role: 'EDITOR', userId: 'u1' }), 'asg-1');
        expect(out.questions).toEqual([{ id: 'q1', respondent: 'CEO' }]);
        expect(out.answers).toEqual([{ questionId: 'q1', answer: 'YES', note: null }]);
        expect(out.finalized).toBe(false);
    });

    it('says when the run is finalised, so the page stops offering Submit (#4633)', async () => {
        withDb(d({ id: 'asg-1', assigneeUserId: 'u1', assessmentId: 'a1', questionIds: ['q1'] }, 'COMPLETED'));
        const out = await getAssignmentForRespondent(ctx({ role: 'READER', userId: 'u1' }), 'asg-1');
        expect(out.finalized).toBe(true);
    });

    it('allows an OWNER admin who is not the assignee', async () => {
        withDb(d({ id: 'asg-1', assigneeUserId: 'other', assessmentId: 'a1', questionIds: ['q1'] }));
        await expect(getAssignmentForRespondent(ctx({ role: 'OWNER' }), 'asg-1')).resolves.toBeDefined();
    });
});

describe('submitAssignmentAnswers', () => {
    const validAssignment = { id: 'asg-1', assigneeUserId: 'u1', assessmentId: 'a1', questionIds: ['q1', 'q2'] };
    function d(assignment: unknown) {
        return {
            nis2GapAssignment: {
                findFirst: jest.fn().mockResolvedValue(assignment),
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
        };
    }

    it('rejects an invalid answer enum before touching the db', async () => {
        withDb(d(validAssignment));
        await expect(
            submitAssignmentAnswers(ctx(), 'asg-1', [{ questionId: 'q1', answer: 'MAYBE' }]),
        ).rejects.toThrow(/invalid answer/i);
    });

    it('throws notFound for a missing assignment', async () => {
        withDb(d(null));
        await expect(
            submitAssignmentAnswers(ctx(), 'asg-1', [{ questionId: 'q1', answer: 'YES' }]),
        ).rejects.toThrow(/not found/i);
    });

    it('forbids a non-assignee non-admin', async () => {
        withDb(d({ ...validAssignment, assigneeUserId: 'other' }));
        await expect(
            submitAssignmentAnswers(ctx({ role: 'EDITOR' }), 'asg-1', [{ questionId: 'q1', answer: 'YES' }]),
        ).rejects.toThrow(/another member/i);
    });

    it('forbids answering a question outside the bucket (data-layer authz)', async () => {
        withDb(d(validAssignment));
        await expect(
            submitAssignmentAnswers(ctx(), 'asg-1', [{ questionId: 'q99', answer: 'YES' }]),
        ).rejects.toThrow(/not in your assignment/i);
    });

    it('writes in-bucket answers and marks the assignment submitted', async () => {
        const db = d(validAssignment);
        withDb(db);
        const res = await submitAssignmentAnswers(ctx(), 'asg-1', [
            { questionId: 'q1', answer: 'YES' },
            { questionId: 'q2', answer: 'NO', note: 'n' },
        ]);
        expect(res.written).toBe(2);
        expect(repo.upsertAnswer).toHaveBeenCalledTimes(2);
        expect(db.nis2GapAssignment.updateMany).toHaveBeenCalled();
    });

    it('lets an assignee submit whatever their role — the assignment is the grant (#4633)', async () => {
        withDb(d(validAssignment));
        const res = await submitAssignmentAnswers(ctx({ role: 'READER', userId: 'u1' }), 'asg-1', [
            { questionId: 'q1', answer: 'YES' },
        ]);
        expect(res.written).toBe(1);
        expect(assertCanRead).toHaveBeenCalled();
        expect(assertCanWrite).not.toHaveBeenCalled();
    });

    it('accepts a re-submit while the run is open', async () => {
        withDb(d({ ...validAssignment, status: 'SUBMITTED' }));
        await expect(
            submitAssignmentAnswers(ctx(), 'asg-1', [{ questionId: 'q1', answer: 'NO' }]),
        ).resolves.toEqual({ written: 1 });
    });

    it.each(['COMPLETED', 'ARCHIVED'])('refuses a submit to a %s run and writes nothing (#4633)', async (status) => {
        repo.lockAssessmentStatusForShare.mockResolvedValue({ status });
        const db = d(validAssignment);
        withDb(db);
        await expect(
            submitAssignmentAnswers(ctx(), 'asg-1', [{ questionId: 'q1', answer: 'NO' }]),
        ).rejects.toMatchObject({ status: 409 });
        expect(repo.upsertAnswer).not.toHaveBeenCalled();
        expect(db.nis2GapAssignment.updateMany).not.toHaveBeenCalled();
        expect(repo.lockAssessmentStatusForShare).toHaveBeenCalledWith(db, expect.anything(), 'a1');
    });

    it('refuses when the run cannot be found rather than writing into it', async () => {
        repo.lockAssessmentStatusForShare.mockResolvedValue(null);
        withDb(d(validAssignment));
        await expect(
            submitAssignmentAnswers(ctx(), 'asg-1', [{ questionId: 'q1', answer: 'NO' }]),
        ).rejects.toMatchObject({ status: 409 });
        expect(repo.upsertAnswer).not.toHaveBeenCalled();
    });
});

describe('finalizeAssessment', () => {
    function d(assignments: unknown[]) {
        return { nis2GapAssignment: { findMany: jest.fn().mockResolvedValue(assignments) } };
    }

    it('rejects finalize while assignments are outstanding (no force)', async () => {
        withDb(d([{ status: 'SUBMITTED' }, { status: 'PENDING' }]));
        await expect(finalizeAssessment(ctx(), 'a1')).rejects.toThrow(/not yet submitted/i);
    });

    it('force-finalizes with outstanding assignments', async () => {
        withDb(d([{ status: 'PENDING' }]));
        await expect(finalizeAssessment(ctx(), 'a1', { force: true })).resolves.toEqual({ finalized: true });
        expect(repo.markAssessmentCompleted).toHaveBeenCalled();
    });

    it('finalizes cleanly when every assignment is submitted', async () => {
        withDb(d([{ status: 'SUBMITTED' }, { status: 'SUBMITTED' }]));
        await expect(finalizeAssessment(ctx(), 'a1')).resolves.toEqual({ finalized: true });
    });
});
