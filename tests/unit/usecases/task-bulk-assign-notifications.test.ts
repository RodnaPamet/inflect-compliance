/**
 * Bulk Assign notifies the assignee (#4278, owner decision: option b).
 *
 * It notified nobody, while assigning one task emails the assignee and
 * rings their bell. Now a bulk Assign sends:
 *
 *   - ONE email for everything it newly handed the assignee — the digest
 *     for two or more tasks, the ordinary single-task email for one;
 *   - a bell per newly assigned task, through the same
 *     `createAssignmentNotification` the single-task path uses;
 *   - nothing for a task that already had this assignee, and nothing for
 *     an unassign.
 *
 * Drives the real `bulkAssignTasks` against a stubbed transaction; the
 * email and bell writers are captured at their module boundary.
 */

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(async (_ctx: unknown, _k: unknown, read: () => unknown) => read()),
    bumpEntityCacheVersion: jest.fn(),
}));
jest.mock('@/app-layer/notifications/enqueue', () => ({
    ...jest.requireActual('@/app-layer/notifications/enqueue'),
    enqueueEmail: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/app-layer/notifications/assignment', () => ({
    ...jest.requireActual('@/app-layer/notifications/assignment'),
    createAssignmentNotification: jest.fn().mockResolvedValue({ status: 'created' }),
}));

const ASSIGNEE = 'user-dana';

jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    const fakeDb = {
        task: { findFirst: jest.fn().mockResolvedValue(null) },
        tenantMembership: {
            // assertActiveMembers — every id asked about is active.
            findMany: jest.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in.map((userId) => ({ userId })),
            ),
            // The email's recipient lookup.
            findFirst: jest.fn().mockResolvedValue({
                user: { email: 'dana@example.com', name: 'Dana Lee' },
            }),
        },
        user: { findUnique: jest.fn().mockResolvedValue({ name: 'Sam Ray' }) },
    };
    return {
        ...actual,
        runInTenantContext: jest.fn(
            async (_ctx: unknown, callback: (db: unknown) => Promise<unknown>) => callback(fakeDb),
        ),
    };
});

jest.mock('@/app-layer/repositories/TaskRepository', () => ({
    TaskRepository: {
        listByIds: jest.fn(),
        bulkAssign: jest.fn(),
    },
    TaskLinkRepository: {},
    TaskCommentRepository: {},
    TaskWatcherRepository: {},
}));

import { bulkAssignTasks } from '@/app-layer/usecases/task';
import { TaskRepository } from '@/app-layer/repositories/TaskRepository';
import { enqueueEmail } from '@/app-layer/notifications/enqueue';
import { createAssignmentNotification } from '@/app-layer/notifications/assignment';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('EDITOR', { userId: 'user-sam' });
const listByIds = TaskRepository.listByIds as jest.Mock;
const bulkAssign = TaskRepository.bulkAssign as jest.Mock;
const emails = enqueueEmail as jest.Mock;
const bells = createAssignmentNotification as jest.Mock;

function task(id: string, title: string, assigneeUserId: string | null) {
    return { id, key: id.toUpperCase(), title, type: 'TASK', status: 'OPEN', assigneeUserId, reviewerUserId: null };
}

const A = task('tsk-a', 'Rotate the edge certificates', null);
const B = task('tsk-b', 'Review the vendor DPA', 'user-other');
const C = task('tsk-c', 'Patch the bastion host', ASSIGNEE);

/** The task ids each bell named, in call order. */
const belledTaskIds = () => bells.mock.calls.map((c) => c[2].entityId);

beforeEach(() => {
    jest.clearAllMocks();
    bulkAssign.mockResolvedValue({ count: 3 });
});

describe('bulk Assign — who is told what', () => {
    it('sends ONE digest email listing only the tasks newly assigned, and a bell for each', async () => {
        listByIds.mockResolvedValue([A, B, C]);

        await bulkAssignTasks(ctx, [A.id, B.id, C.id], ASSIGNEE);

        expect(emails).toHaveBeenCalledTimes(1);
        const email = emails.mock.calls[0][1];
        expect(email.type).toBe('TASK_ASSIGNED');
        expect(email.toEmail).toBe('dana@example.com');
        // C already had this assignee — it is not news, so it is not listed.
        expect(email.payload.tasks).toEqual([
            { taskTitle: A.title, taskKey: A.key, taskType: 'TASK' },
            { taskTitle: B.title, taskKey: B.key, taskType: 'TASK' },
        ]);
        expect(email.payload.assigneeName).toBe('Dana Lee');
        expect(email.payload.assignerName).toBe('Sam Ray');
        // Deduped per task SET and day, not per task: a different set the
        // same day is a different digest.
        expect(email.entityId).toMatch(/^bulk-assign:[0-9a-f]+$/);

        expect(belledTaskIds()).toEqual([A.id, B.id]);
        for (const [, kind, target] of bells.mock.calls) {
            expect(kind).toBe('TASK_ASSIGNED');
            expect(target.assigneeUserId).toBe(ASSIGNEE);
        }
    });

    it('the digest is keyed on the set, whatever order the ids arrive in', async () => {
        listByIds.mockResolvedValue([A, B]);
        await bulkAssignTasks(ctx, [A.id, B.id], ASSIGNEE);
        listByIds.mockResolvedValue([B, A]);
        await bulkAssignTasks(ctx, [B.id, A.id], ASSIGNEE);

        expect(emails.mock.calls[0][1].entityId).toBe(emails.mock.calls[1][1].entityId);
    });

    it('one newly assigned task goes out as the ordinary single-task email', async () => {
        listByIds.mockResolvedValue([A, C]);

        await bulkAssignTasks(ctx, [A.id, C.id], ASSIGNEE);

        expect(emails).toHaveBeenCalledTimes(1);
        const email = emails.mock.calls[0][1];
        // Same entity id as assigning the task on its own, so the two paths
        // collapse into one mail for the same task on the same day.
        expect(email.entityId).toBe(A.id);
        expect(email.payload).toEqual(
            expect.objectContaining({ taskTitle: A.title, taskKey: A.key, taskType: 'TASK' }),
        );
        expect(email.payload).not.toHaveProperty('tasks');
        expect(belledTaskIds()).toEqual([A.id]);
    });

    it('tells nobody when every task already had this assignee', async () => {
        listByIds.mockResolvedValue([C]);

        await bulkAssignTasks(ctx, [C.id], ASSIGNEE);

        expect(emails).not.toHaveBeenCalled();
        expect(bells).not.toHaveBeenCalled();
    });

    it('tells nobody on a bulk unassign', async () => {
        listByIds.mockResolvedValue([A, B, C]);

        await bulkAssignTasks(ctx, [A.id, B.id, C.id], null);

        expect(emails).not.toHaveBeenCalled();
        expect(bells).not.toHaveBeenCalled();
    });
});
