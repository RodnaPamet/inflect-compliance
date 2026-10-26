/**
 * Only a member whose role can edit tasks may be named a task's reviewer
 * (#4278, owner decision: option a).
 *
 * The reviewer is the only person who can complete a reviewer-gated task,
 * and completing it is a status change `assertCanWriteTasks` refuses to a
 * Reader, Auditor or AI admin — so such a reviewer left the task
 * completable by nobody. Held in three places, each tested here:
 *
 *   1. the rule (`memberCanSignOffTasks`), over built-in AND custom roles;
 *   2. the writes — createTask / updateTask refuse an ineligible reviewer
 *      with a named reason, and accept an eligible one;
 *   3. the picker's roster — `?audience=task-reviewer` lists exactly the
 *      members the write accepts.
 */
import { NextRequest } from 'next/server';

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(async (_ctx: unknown, _k: unknown, read: () => unknown) => read()),
    bumpEntityCacheVersion: jest.fn(),
}));
jest.mock('@/app-layer/automation', () => ({
    ...jest.requireActual('@/app-layer/automation'),
    emitAutomationEvent: jest.fn().mockResolvedValue(undefined),
}));

/** userId → the membership row the fake tx returns for them. */
const mockMemberships = new Map<string, Record<string, unknown>>();

jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    const pick = (userId: string) => mockMemberships.get(userId) ?? null;
    const fakeDb = {
        task: { findFirst: jest.fn().mockResolvedValue(null) },
        tenantMembership: {
            findMany: jest.fn(async ({ where }: { where: { userId?: { in: string[] } } }) =>
                where.userId
                    ? where.userId.in.filter((id) => pick(id)).map((userId) => ({ userId }))
                    : [...mockMemberships.entries()].map(([userId, m]) => ({
                          ...m,
                          user: { id: userId, name: userId, email: `${userId}@example.com`, image: null },
                      })),
            ),
            findFirst: jest.fn(async ({ where }: { where: { userId: string } }) => pick(where.userId)),
        },
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
        create: jest.fn(async () => ({ id: 'task-new', key: 'TSK-1', title: 't', assigneeUserId: null, dueAt: null })),
        getById: jest.fn(async () => ({ id: 'task-1', status: 'OPEN', reviewerUserId: null, assigneeUserId: null, type: 'TASK', controlId: null, dueAt: null })),
        update: jest.fn(async () => ({ id: 'task-1', reviewerUserId: 'x', dueAt: null })),
    },
    TaskLinkRepository: {},
    TaskCommentRepository: {},
    TaskWatcherRepository: {},
}));

const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    __esModule: true,
    getTenantCtx: (...a: unknown[]) => getTenantCtxMock(...a),
}));

import type { Role } from '@prisma/client';
import { createTask, getTask, updateTask } from '@/app-layer/usecases/task';
import { listAssignableUsers } from '@/app-layer/usecases/tenant-admin';
import {
    memberCanSignOffTasks,
    REVIEWER_CANNOT_SIGN_OFF,
} from '@/app-layer/usecases/task-reviewer-eligibility';
import { TaskRepository } from '@/app-layer/repositories/TaskRepository';
import { GET as assignableGET } from '@/app/api/t/[tenantSlug]/users/assignable/route';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('EDITOR', { userId: 'user-actor' });

const builtIn = (role: Role) => ({ role, customRole: null });
const custom = (baseRole: Role, tasks: Record<string, boolean>) => ({
    role: baseRole,
    customRole: { baseRole, permissionsJson: { tasks } },
});

async function refusal(p: Promise<unknown>): Promise<{ message: string; details: unknown }> {
    try {
        await p;
    } catch (e) {
        return { message: (e as Error).message, details: (e as { details?: unknown }).details };
    }
    throw new Error('expected a refusal');
}

beforeEach(() => {
    jest.clearAllMocks();
    mockMemberships.clear();
    mockMemberships.set('user-actor', builtIn('EDITOR'));
});

describe('memberCanSignOffTasks — the rule', () => {
    it.each([
        ['OWNER', true],
        ['ADMIN', true],
        ['EDITOR', true],
        ['READER', false],
        ['AUDITOR', false],
        ['AI_ADMIN', false],
    ] as const)('built-in %s → %s', (role, expected) => {
        expect(memberCanSignOffTasks(builtIn(role))).toBe(expected);
    });

    it('a custom role needs BOTH the write tier of its base and tasks.edit', () => {
        expect(memberCanSignOffTasks(custom('EDITOR', { view: true, edit: true }))).toBe(true);
        // The key without the tier — assertCanWriteTasks refuses it.
        expect(memberCanSignOffTasks(custom('READER', { view: true, edit: true }))).toBe(false);
        // The tier without the key.
        expect(memberCanSignOffTasks(custom('EDITOR', { view: true, edit: false }))).toBe(false);
    });
});

describe('the write paths refuse a reviewer who could never sign off', () => {
    it.each(['READER', 'AUDITOR', 'AI_ADMIN'] as const)('createTask refuses a %s reviewer', async (role) => {
        mockMemberships.set('user-rev', builtIn(role));

        const err = await refusal(createTask(ctx, { title: 'Rotate keys', reviewerUserId: 'user-rev' }));

        expect(err.message).toMatch(/reviewer must be someone whose role can edit tasks/);
        expect(err.details).toEqual({ reason: REVIEWER_CANNOT_SIGN_OFF });
        expect(TaskRepository.create).not.toHaveBeenCalled();
    });

    it('updateTask refuses naming an Auditor reviewer', async () => {
        mockMemberships.set('user-rev', builtIn('AUDITOR'));

        const err = await refusal(updateTask(ctx, 'task-1', { reviewerUserId: 'user-rev' }));

        expect(err.details).toEqual({ reason: REVIEWER_CANNOT_SIGN_OFF });
        expect(TaskRepository.update).not.toHaveBeenCalled();
    });

    it('accepts a reviewer who can edit tasks, and clearing a reviewer is never checked', async () => {
        mockMemberships.set('user-rev', builtIn('ADMIN'));
        await createTask(ctx, { title: 'Rotate keys', reviewerUserId: 'user-rev' });
        expect(TaskRepository.create).toHaveBeenCalledTimes(1);

        await updateTask(ctx, 'task-1', { reviewerUserId: null });
        expect(TaskRepository.update).toHaveBeenCalledTimes(1);
    });
});

describe('getTask says when an existing reviewer cannot sign off', () => {
    // Tasks named before the rule are not migrated; the task page reads
    // this flag to say so beside the reviewer picker.
    const withReviewer = (reviewerUserId: string | null) =>
        (TaskRepository.getById as jest.Mock).mockResolvedValueOnce({
            id: 'task-1',
            status: 'IN_REVIEW',
            severity: 'MEDIUM',
            createdAt: new Date('2026-08-01'),
            reviewerUserId,
        });

    it.each([
        ['an Auditor reviewer', 'user-rev', builtIn('AUDITOR'), false],
        ['an Editor reviewer', 'user-rev', builtIn('EDITOR'), true],
        ['a reviewer who is no longer an active member', 'user-gone', null, false],
    ] as const)('%s → %s', async (_label, reviewerUserId, membership, expected) => {
        if (membership) mockMemberships.set(reviewerUserId, membership);
        withReviewer(reviewerUserId);

        const task = await getTask(ctx, 'task-1');

        expect(task.reviewerCanSignOff).toBe(expected);
    });

    it('no reviewer → null', async () => {
        withReviewer(null);
        expect((await getTask(ctx, 'task-1')).reviewerCanSignOff).toBeNull();
    });
});

describe('the reviewer picker offers exactly the members the write accepts', () => {
    beforeEach(() => {
        mockMemberships.set('user-owner', builtIn('OWNER'));
        mockMemberships.set('user-editor', builtIn('EDITOR'));
        mockMemberships.set('user-reader', builtIn('READER'));
        mockMemberships.set('user-auditor', builtIn('AUDITOR'));
        mockMemberships.set('user-aiadmin', builtIn('AI_ADMIN'));
        mockMemberships.set('user-custom-noedit', custom('EDITOR', { view: true, edit: false }));
    });

    it('listAssignableUsers({ taskReviewersOnly }) drops every member who cannot sign off', async () => {
        const all = await listAssignableUsers(ctx);
        const reviewers = await listAssignableUsers(ctx, { taskReviewersOnly: true });

        expect(all.map((u) => u.id)).toHaveLength(mockMemberships.size);
        expect(reviewers.map((u) => u.id).sort()).toEqual(['user-actor', 'user-editor', 'user-owner']);
        // The roster shape is unchanged — no role reaches the client.
        expect(Object.keys(reviewers[0]).sort()).toEqual(['email', 'id', 'image', 'name']);
    });

    it('GET /users/assignable?audience=task-reviewer serves that roster; the bare route serves everyone', async () => {
        getTenantCtxMock.mockResolvedValue(ctx);
        const args = { params: Promise.resolve({ tenantSlug: 'acme' }) };

        const narrowed = await assignableGET(
            new NextRequest(new URL('https://x.test/api/t/acme/users/assignable?audience=task-reviewer')) as never,
            args as never,
        );
        const full = await assignableGET(
            new NextRequest(new URL('https://x.test/api/t/acme/users/assignable')) as never,
            args as never,
        );

        expect(((await narrowed.json()) as Array<{ id: string }>).map((u) => u.id).sort()).toEqual([
            'user-actor',
            'user-editor',
            'user-owner',
        ]);
        expect((await full.json()) as unknown[]).toHaveLength(mockMemberships.size);
    });

    it('an unknown audience is a 400, never a silently full roster', async () => {
        getTenantCtxMock.mockResolvedValue(ctx);
        const res = await assignableGET(
            new NextRequest(new URL('https://x.test/api/t/acme/users/assignable?audience=everyone')) as never,
            { params: Promise.resolve({ tenantSlug: 'acme' }) } as never,
        );
        expect(res.status).toBe(400);
    });
});
