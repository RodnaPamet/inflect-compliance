/**
 * A refused status change reaches the user VERBATIM — the Tasks page, the
 * quick-view panel and the task detail page all show the API error's
 * message as the reason (#4278). So the wording is user copy, and it used
 * to read like a log line:
 *
 *   Illegal work-item transition: TRIAGED → OPEN.
 *   Cannot bulk-transition task clx9…: …
 *   … must pass through IN_REVIEW before it can be CLOSED …
 *
 * These drive the real `setTaskStatus` / `bulkSetTaskStatus` down each
 * refusal path and assert the message names statuses and types the way
 * the UI does, and names a task by its title rather than its id.
 */

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));
jest.mock('@/app-layer/usecases/task-source-reconcile', () => ({
    reconcileTaskSource: jest.fn(),
}));
jest.mock('@/lib/cache/list-cache', () => ({
    cachedListRead: jest.fn(async (_ctx: unknown, _k: unknown, read: () => unknown) => read()),
    bumpEntityCacheVersion: jest.fn(),
}));

const mockRelevanceRows: Array<Record<string, unknown>> = [];
jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    const fakeDb = {
        task: {
            findFirst: jest.fn().mockResolvedValue(null),
            findMany: jest.fn(async () => mockRelevanceRows),
        },
        tenantMembership: {
            findMany: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
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
        getById: jest.fn(),
        setStatus: jest.fn(),
        listByIds: jest.fn(),
        bulkSetStatus: jest.fn(),
    },
    TaskLinkRepository: {
        listByTask: jest.fn().mockResolvedValue([]),
        listByTaskIds: jest.fn().mockResolvedValue([]),
    },
    TaskCommentRepository: {},
    TaskWatcherRepository: {},
}));

import { setTaskStatus, bulkSetTaskStatus } from '@/app-layer/usecases/task';
import { TaskRepository } from '@/app-layer/repositories/TaskRepository';
import { ALL_TASK_STATUSES } from '@/app-layer/domain/task-status';
import { makeRequestContext } from '../../helpers/make-context';

const ctx = makeRequestContext('OWNER', { userId: 'actor-1' });
const TASK_ID = 'clx9d2k7b0000qz8l3f6h1abc';

const getById = TaskRepository.getById as jest.Mock;
const listByIds = TaskRepository.listByIds as jest.Mock;

/** The refusal message a call produced. */
async function refusal(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (e) {
        return (e as Error).message;
    }
    throw new Error('expected the call to be refused');
}

/**
 * What in `message` is not user copy: a raw status enum (they are
 * SCREAMING_SNAKE; no display name is), the internal word "work-item", or
 * the task's database id. Empty for a user-facing message.
 */
function rawFragments(message: string): string[] {
    const raw: string[] = ALL_TASK_STATUSES.filter((status) =>
        new RegExp(`\\b${status}\\b`).test(message),
    );
    if (/work-item/i.test(message)) raw.push('work-item');
    if (message.includes(TASK_ID)) raw.push(TASK_ID);
    return raw;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockRelevanceRows.length = 0;
});

describe('single-task status refusals', () => {
    it('an illegal move names both statuses as the UI does', async () => {
        getById.mockResolvedValue({ id: TASK_ID, status: 'TRIAGED', type: 'TASK', controlId: null, reviewerUserId: null });

        const message = await refusal(setTaskStatus(ctx, TASK_ID, 'OPEN'));

        expect(message).toBe('A task cannot move from Triaged to Open.');
        expect(rawFragments(message)).toEqual([]);
    });

    it('the reviewer gate names the review status, not IN_REVIEW', async () => {
        getById.mockResolvedValue({ id: TASK_ID, status: 'IN_PROGRESS', type: 'TASK', controlId: null, reviewerUserId: 'reviewer-1' });

        const message = await refusal(setTaskStatus(ctx, TASK_ID, 'CLOSED', 'done'));

        expect(message).toBe(
            'This task has a reviewer, so it must be In review before it can be closed. Move it to In review for sign-off first.',
        );
        expect(rawFragments(message)).toEqual([]);
    });

    it('a terminal move without a resolution names the status', async () => {
        getById.mockResolvedValue({ id: TASK_ID, status: 'IN_PROGRESS', type: 'TASK', controlId: null, reviewerUserId: null });

        const message = await refusal(setTaskStatus(ctx, TASK_ID, 'CANCELED'));

        expect(message).toBe('A resolution is required when moving a task to Canceled.');
        expect(rawFragments(message)).toEqual([]);
    });

    it('the type-relevance rule names the type and targets, not the enum values', async () => {
        getById.mockResolvedValue({ id: TASK_ID, status: 'IN_PROGRESS', type: 'INCIDENT', controlId: null, reviewerUserId: null });

        const message = await refusal(setTaskStatus(ctx, TASK_ID, 'CLOSED', 'contained'));

        expect(message).toBe('Incident tasks must have a control, or a link to a control or asset.');
        expect(message).not.toMatch(/\bINCIDENT\b|\bCONTROL\b|\bASSET\b|controlId/);
    });
});

describe('bulk status refusals name the task by its title, never its id', () => {
    it('an illegal move in the batch', async () => {
        listByIds.mockResolvedValue([
            { id: TASK_ID, title: 'Rotate the edge certificates', status: 'CLOSED', reviewerUserId: null },
        ]);

        const message = await refusal(bulkSetTaskStatus(ctx, [TASK_ID], 'TRIAGED'));

        expect(message).toBe(
            'Cannot change the status of "Rotate the edge certificates": A task cannot move from Closed to Triaged.',
        );
        expect(rawFragments(message)).toEqual([]);
    });

    it('the reviewer gate in the batch', async () => {
        listByIds.mockResolvedValue([
            { id: TASK_ID, title: 'Review the vendor DPA', status: 'OPEN', reviewerUserId: 'reviewer-1' },
        ]);

        const message = await refusal(bulkSetTaskStatus(ctx, [TASK_ID], 'CLOSED', 'done'));

        expect(message).toBe(
            'Cannot change the status of "Review the vendor DPA": This task has a reviewer, so it must be In review before it can be closed. Move it to In review for sign-off first.',
        );
        expect(rawFragments(message)).toEqual([]);
    });

    it('the type-relevance rule in the batch', async () => {
        listByIds.mockResolvedValue([
            { id: TASK_ID, title: 'Close the pen-test gap', status: 'IN_PROGRESS', reviewerUserId: null },
        ]);
        mockRelevanceRows.push({ id: TASK_ID, type: 'CONTROL_GAP', controlId: null });

        const message = await refusal(bulkSetTaskStatus(ctx, [TASK_ID], 'CLOSED', 'done'));

        expect(message).toBe(
            'Cannot change the status of "Close the pen-test gap": Control Gap tasks must have a control, or a link to a control or framework requirement.',
        );
        expect(rawFragments(message)).toEqual([]);
        expect(message).not.toMatch(/CONTROL_GAP|FRAMEWORK_REQUIREMENT|controlId/);
    });
});
