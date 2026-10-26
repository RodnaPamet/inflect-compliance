/**
 * The bulk-Assign digest email (#4278): ONE mail for everything a bulk
 * Assign handed one person. It rides the TASK_ASSIGNED type — adding an
 * `EmailNotificationType` value would be a migration — so `enqueueEmail`
 * picks the body by the payload's shape.
 */
jest.mock('@/app-layer/notifications/settings', () => ({
    ...jest.requireActual('@/app-layer/notifications/settings'),
    isNotificationsEnabled: jest.fn().mockResolvedValue(true),
}));

import { buildTaskAssignedDigestEmail } from '@/app-layer/notifications/templates';
import { enqueueEmail } from '@/app-layer/notifications/enqueue';

const DIGEST = {
    tasks: [
        { taskTitle: 'Rotate the edge certificates', taskKey: 'TSK-7', taskType: 'TASK' },
        { taskTitle: 'Review the <vendor> DPA', taskKey: null, taskType: 'AUDIT_FINDING' },
    ],
    assigneeName: 'Dana Lee',
    assignerName: 'Sam Ray',
    tenantSlug: 'acme',
};

describe('buildTaskAssignedDigestEmail', () => {
    it('lists every task in one email, with its key where it has one', () => {
        const mail = buildTaskAssignedDigestEmail(DIGEST);

        expect(mail.subject).toBe('2 tasks assigned to you');
        expect(mail.bodyText).toContain('Hi Dana Lee,');
        expect(mail.bodyText).toContain('You have been assigned 2 tasks by Sam Ray:');
        expect(mail.bodyText).toContain('  [TSK-7] Rotate the edge certificates');
        expect(mail.bodyText).toContain('  Review the <vendor> DPA');
        expect(mail.bodyText).toContain('/t/acme/tasks');
    });

    it('escapes task titles in the HTML body', () => {
        const mail = buildTaskAssignedDigestEmail(DIGEST);

        expect(mail.bodyHtml).toContain('Review the &lt;vendor&gt; DPA');
        expect(mail.bodyHtml).not.toContain('<vendor>');
    });

    it('drops the by-line when the assigner has no name', () => {
        const mail = buildTaskAssignedDigestEmail({ ...DIGEST, assignerName: undefined });

        expect(mail.bodyText).toContain('You have been assigned 2 tasks:');
    });
});

describe('enqueueEmail — TASK_ASSIGNED builds the body the payload asks for', () => {
    function fakeDb() {
        const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'out-1', ...data }));
        return { db: { notificationOutbox: { create } } as never, create };
    }

    it('a payload with `tasks` gets the digest body', async () => {
        const { db, create } = fakeDb();

        await enqueueEmail(db, {
            tenantId: 'tenant-1',
            type: 'TASK_ASSIGNED',
            toEmail: 'dana@example.com',
            entityId: 'bulk-assign:abc',
            payload: DIGEST,
        });

        expect(create.mock.calls[0][0].data.subject).toBe('2 tasks assigned to you');
    });

    it('a single-task payload still gets the single-task body', async () => {
        const { db, create } = fakeDb();

        await enqueueEmail(db, {
            tenantId: 'tenant-1',
            type: 'TASK_ASSIGNED',
            toEmail: 'dana@example.com',
            entityId: 'task-1',
            payload: {
                taskTitle: 'Rotate the edge certificates',
                taskKey: 'TSK-7',
                taskType: 'TASK',
                assigneeName: 'Dana Lee',
                tenantSlug: 'acme',
            },
        });

        expect(create.mock.calls[0][0].data.subject).toBe(
            'Task assigned to you: [TSK-7] Rotate the edge certificates',
        );
    });
});
