/**
 * A bell row pushed over SSE carries the id of the row that was written
 * (#5305).
 *
 * `createMany` returns no ids, so the helpers pushed each event with a
 * synthetic id — the dedupe key, or a `kind:entity:user` string. The bell
 * marks a row read with `PATCH …/notifications/<id>`, so a freshly pushed
 * row's mark-read named no notification: it failed, and the row came back
 * unread on the next list refetch.
 *
 * Against the real database, so the id compared is the one Postgres assigned
 * and the list and the PATCH use.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { createAssignmentNotification } from '@/app-layer/notifications/assignment';
import { createTaskDueNotification } from '@/app-layer/notifications/task-due';
import { createWatcherNotifications } from '@/app-layer/notifications/watcher';
import {
    __resetNotificationBusForTests,
    subscribeToNotifications,
    type NotificationEvent,
} from '@/lib/notifications/notification-bus';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const SUITE = randomUUID().slice(0, 8);
const T = `notif-push-${SUITE}`;
let userId = '';
let received: NotificationEvent[] = [];

beforeAll(async () => {
    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const email = `bell@${SUITE}.test`;
    userId = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
    await prisma.tenantMembership.create({ data: { tenantId: T, userId, role: 'EDITOR', status: 'ACTIVE' } });
});

beforeEach(() => {
    __resetNotificationBusForTests();
    received = [];
    subscribeToNotifications({ tenantId: T, userId, send: (e) => received.push(e) });
});

afterAll(async () => {
    await prisma.notification.deleteMany({ where: { tenantId: T } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: T } });
    await prisma.tenant.deleteMany({ where: { id: T } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
});

/** The pushed event names a row the bell can PATCH, and it is the row just written. */
async function expectPushedRowIsStored(type: string) {
    expect(received).toHaveLength(1);
    const row = await prisma.notification.findUnique({ where: { id: received[0].id } });
    expect(row).toMatchObject({ tenantId: T, userId, type });
}

describe('an SSE-pushed bell row carries its real Notification id', () => {
    it('task assignment', async () => {
        await createAssignmentNotification(prisma, 'TASK_ASSIGNED', {
            tenantId: T,
            assigneeUserId: userId,
            entityId: `task-${SUITE}`,
            entityLabel: 'Patch the firewall',
            entityKey: 'T-1',
            tenantSlug: T,
        });
        await expectPushedRowIsStored('TASK_ASSIGNED');
    });

    it('a task due reminder', async () => {
        const now = new Date('2026-11-14T09:00:00Z');
        await createTaskDueNotification(
            prisma,
            {
                id: `due-${SUITE}`,
                tenantId: T,
                tenantSlug: T,
                title: 'Rotate keys',
                key: 'T-2',
                dueAt: new Date('2026-11-15T09:00:00Z'),
                assigneeUserId: userId,
            },
            now,
        );
        await expectPushedRowIsStored('TASK_DUE');
    });

    it('a watched task update', async () => {
        await createWatcherNotifications(prisma, [userId], {
            tenantId: T,
            tenantSlug: T,
            taskId: `watched-${SUITE}`,
            taskKey: 'T-3',
            taskTitle: 'Review access',
            kind: 'commented',
            discriminator: 'comment-1',
            detail: 'new comment added',
        });
        await expectPushedRowIsStored('TASK_WATCH_UPDATE');
    });

    it('a duplicate pushes nothing — the control', async () => {
        const target = {
            tenantId: T,
            assigneeUserId: userId,
            entityId: `task-${SUITE}`,
            entityLabel: 'Patch the firewall',
            entityKey: 'T-1',
            tenantSlug: T,
        };
        // Same entity, same user, same day as the first case: deduped.
        const out = await createAssignmentNotification(prisma, 'TASK_ASSIGNED', target);
        expect(out.status).toBe('duplicate');
        expect(received).toHaveLength(0);
    });
});
