/**
 * TP-2 — unit coverage for the watcher notification helper. Watching a
 * task must deliver activity (comment / status / assign) to the bell.
 *
 *   1. dedupeKey shape keys on kind + discriminator so distinct events
 *      don't collapse, but a retry of the same event dedupes.
 *   2. one bell row per watcher, type TASK_WATCH_UPDATE, /tasks deep link.
 *   3. empty watcher set is a no-op (no createMany).
 *   4. SSE publish on insert, skipped on duplicate.
 */

import {
    buildWatcherDedupeKey,
    createWatcherNotifications,
    type WatcherActivity,
} from '@/app-layer/notifications/watcher';
import {
    __resetNotificationBusForTests,
    subscribeToNotifications,
    type NotificationEvent,
} from '@/lib/notifications/notification-bus';

function activity(overrides: Partial<WatcherActivity> = {}): WatcherActivity {
    return {
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        taskId: 'task-1',
        taskKey: 'TSK-42',
        taskTitle: 'Patch the firewall',
        kind: 'commented',
        discriminator: 'comment-1',
        detail: 'new comment added',
        ...overrides,
    };
}

describe('buildWatcherDedupeKey', () => {
    it('keys on tenant:TASK_WATCH:task:watcher:kind:discriminator', () => {
        const key = buildWatcherDedupeKey(activity(), 'watcher-1');
        expect(key).toBe('tenant-1:TASK_WATCH:task-1:watcher-1:commented:comment-1');
    });

    it('distinct events (different discriminator) produce distinct keys', () => {
        const a = buildWatcherDedupeKey(activity({ discriminator: 'comment-1' }), 'w1');
        const b = buildWatcherDedupeKey(activity({ discriminator: 'comment-2' }), 'w1');
        expect(a).not.toBe(b);
    });

    it('distinct kinds produce distinct keys', () => {
        const c = buildWatcherDedupeKey(activity({ kind: 'commented', discriminator: 'x' }), 'w1');
        const s = buildWatcherDedupeKey(activity({ kind: 'status_changed', discriminator: 'x' }), 'w1');
        expect(c).not.toBe(s);
    });
});

describe('createWatcherNotifications', () => {
    let createManyMock: jest.Mock;
    let db: { notification: { createMany: jest.Mock } };

    beforeEach(() => {
        createManyMock = jest.fn().mockResolvedValue({ count: 2 });
        db = { notification: { createMany: createManyMock } };
    });

    it('writes one TASK_WATCH_UPDATE row per watcher with the /tasks deep link', async () => {
        await createWatcherNotifications(db as never, ['w1', 'w2'], activity({ taskId: 'task-X' }));
        const args = createManyMock.mock.calls[0][0];
        expect(args.skipDuplicates).toBe(true);
        expect(args.data).toHaveLength(2);
        for (const row of args.data) {
            expect(row.type).toBe('TASK_WATCH_UPDATE');
            expect(row.linkUrl).toBe('/t/acme/tasks/task-X');
        }
        expect(args.data.map((r: { userId: string }) => r.userId).sort()).toEqual(['w1', 'w2']);
    });

    it('body carries the task key + label + activity detail', async () => {
        await createWatcherNotifications(db as never, ['w1'], activity({
            taskKey: 'TSK-9', taskTitle: 'Rotate keys', detail: 'status changed OPEN → IN_REVIEW',
        }));
        const row = createManyMock.mock.calls[0][0].data[0];
        expect(row.message).toContain('TSK-9');
        expect(row.message).toContain('"Rotate keys"');
        expect(row.message).toContain('status changed OPEN → IN_REVIEW');
    });

    it('is a no-op for an empty watcher set (no createMany, created 0)', async () => {
        const result = await createWatcherNotifications(db as never, [], activity());
        expect(createManyMock).not.toHaveBeenCalled();
        expect(result.created).toBe(0);
    });
});

/**
 * `findMany` by `dedupeKey`, as the helper reads the inserted rows back
 * (#5305): each key gets a row id that is NOT the key, so an event still
 * carrying the dedupe key as its id fails the assertions below.
 */
const insertedRows = () =>
    jest.fn(async ({ where }: { where: { dedupeKey: { in: string[] } } }) =>
        where.dedupeKey.in.map((dedupeKey, i) => ({
            id: `notif-row-${i + 1}`,
            dedupeKey,
            createdAt: new Date('2026-05-28T12:00:05Z'),
        })),
    );

describe('createWatcherNotifications — SSE publish', () => {
    let createManyMock: jest.Mock;
    let db: { notification: { createMany: jest.Mock; findMany: jest.Mock } };

    beforeEach(() => {
        __resetNotificationBusForTests();
        createManyMock = jest.fn();
        db = { notification: { createMany: createManyMock, findMany: insertedRows() } };
    });

    it('fans each watcher event to the bus when rows insert (count > 0)', async () => {
        const received: NotificationEvent[] = [];
        subscribeToNotifications({ tenantId: 'tenant-1', userId: 'w1', send: (e) => received.push(e) });

        createManyMock.mockResolvedValueOnce({ count: 1 });
        await createWatcherNotifications(db as never, ['w1'], activity(), new Date('2026-07-17T12:00:00Z'));

        expect(received).toHaveLength(1);
        expect(received[0].type).toBe('TASK_WATCH_UPDATE');
        // The ROW's id, not the dedupe key it used to carry (#5305).
        expect(received[0].id).toBe('notif-row-1');
    });

    it('SKIPS the bus publish when skipDuplicates collapses all inserts', async () => {
        const received: NotificationEvent[] = [];
        subscribeToNotifications({ tenantId: 'tenant-1', userId: 'w1', send: (e) => received.push(e) });

        createManyMock.mockResolvedValueOnce({ count: 0 });
        await createWatcherNotifications(db as never, ['w1'], activity());

        expect(received).toHaveLength(0);
    });
});
