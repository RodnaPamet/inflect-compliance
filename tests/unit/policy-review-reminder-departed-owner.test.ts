/**
 * #5059 / #5297 — the policy-review reminder and owners who have left.
 *
 * `createTask` refuses an assignee who is not an ACTIVE member, and that
 * refusal used to throw out of the job: every policy after it, across all
 * tenants, got no task, email or event that day, every day. The departed
 * owner also kept being emailed about the tenant's policies, and a removed
 * workspace's policies kept being reminded about.
 */
const mockCreateTask = jest.fn();
jest.mock('@/app-layer/usecases/task', () => ({
    createTask: (...a: unknown[]) => mockCreateTask(...a),
    addTaskLink: jest.fn(async () => ({})),
}));
jest.mock('@/app-layer/context-system', () => ({
    ...jest.requireActual('@/app-layer/context-system'),
    buildTenantSystemJobContext: jest.fn(async ({ tenantId }: { tenantId: string }) => ({
        tenantId,
        userId: `sys_${tenantId}`,
    })),
}));
jest.mock('@/app-layer/automation', () => ({ emitAutomationEvent: jest.fn(async () => undefined) }));
jest.mock('@/app-layer/notifications/settings', () => ({ isNotificationsEnabled: jest.fn(async () => true) }));

import type { PrismaClient } from '@prisma/client';
import { processOverdueReminders } from '@/app-layer/jobs/policyReviewReminder';

const yesterday = new Date(Date.now() - 86_400_000);
const policy = (id: string, ownerUserId: string) => ({
    id,
    tenantId: 't-1',
    title: `Policy ${id}`,
    slug: id,
    nextReviewAt: yesterday,
    ownerUserId,
    owner: { email: `${ownerUserId}@acme.test` },
    tenant: { reminderDaysBefore: 14 },
});

function fakeDb(activeOwnerIds: string[]) {
    const outboxCreate = jest.fn(async () => ({}));
    const policyFindMany = jest.fn(async () => [policy('p-departed', 'gone'), policy('p-live', 'here')]);
    const db = {
        policy: { findMany: policyFindMany },
        taskLink: { findMany: jest.fn(async () => []) },
        tenantMembership: {
            findMany: jest.fn(async () => activeOwnerIds.map((userId) => ({ tenantId: 't-1', userId }))),
        },
        auditLog: { create: jest.fn(async () => ({})) },
        notificationOutbox: { create: outboxCreate },
    };
    return { db: db as unknown as PrismaClient, outboxCreate, policyFindMany };
}

beforeEach(() => {
    mockCreateTask.mockReset().mockImplementation(async () => ({ id: 'task-1' }));
});

describe('policy review reminder — owners who have left', () => {
    it('does not scan a removed workspace', async () => {
        const { db, policyFindMany } = fakeDb(['here']);
        await processOverdueReminders(db);
        expect((policyFindMany.mock.calls[0] as unknown as [{ where: { tenant: unknown } }])[0].where.tenant).toEqual({
            deletedAt: null,
        });
    });

    it('raises the departed owner’s review unassigned, and emails only the owner who is still a member', async () => {
        const { db, outboxCreate } = fakeDb(['here']);
        await processOverdueReminders(db);

        const byTitle = Object.fromEntries(
            mockCreateTask.mock.calls.map(([, input]: [unknown, { title: string; assigneeUserId?: string }]) => [
                input.title,
                input.assigneeUserId,
            ]),
        );
        expect(byTitle['Review policy: Policy p-departed']).toBeUndefined();
        expect(byTitle['Review policy: Policy p-live']).toBe('here');

        const emailed = outboxCreate.mock.calls.map((c) => (c as unknown as [{ data: { toEmail: string } }])[0].data.toEmail);
        expect(emailed).toEqual(['here@acme.test']);
    });

    it('one policy’s task failure does not stop the policies after it', async () => {
        mockCreateTask.mockReset()
            .mockImplementationOnce(async () => { throw new Error('refused'); })
            .mockImplementation(async () => ({ id: 'task-2' }));
        const { db } = fakeDb(['gone', 'here']);

        const res = await processOverdueReminders(db);

        expect(mockCreateTask).toHaveBeenCalledTimes(2);
        expect(res.processed).toBe(2);
    });

    it('the outbox dedupe key carries no raw email (#5307)', async () => {
        // `processOutbox` logs the key on every failed send.
        const { db, outboxCreate } = fakeDb(['here']);
        await processOverdueReminders(db);
        const keys = outboxCreate.mock.calls.map(
            (c) => (c as unknown as [{ data: { dedupeKey: string } }])[0].data.dedupeKey,
        );
        expect(keys).toHaveLength(1);
        expect(keys[0]).not.toContain('here@acme.test');
        expect(keys[0]).not.toContain('@');
        expect(keys[0]).toContain('p-live');
    });
});

describe('policy review reminder — the scan is not capped (#5307)', () => {
    it('processes every due policy past the old 1000-row cap, paging by id', async () => {
        const all = Array.from({ length: 1203 }, (_, i) =>
            policy(`p-${String(i).padStart(5, '0')}`, 'here'));
        // A page-serving double: honours `cursor` / `skip` / `take` over a
        // list sorted by id, the way the real read does.
        const policyFindMany = jest.fn(async (args: { take: number; cursor?: { id: string }; skip?: number }) => {
            const start = args.cursor ? all.findIndex((p) => p.id === args.cursor!.id) + (args.skip ?? 0) : 0;
            return all.slice(start, start + args.take);
        });
        const db = {
            policy: { findMany: policyFindMany },
            taskLink: { findMany: jest.fn(async () => []) },
            tenantMembership: { findMany: jest.fn(async () => [{ tenantId: 't-1', userId: 'here' }]) },
            auditLog: { create: jest.fn(async () => ({})) },
            notificationOutbox: { create: jest.fn(async () => ({})) },
        } as unknown as PrismaClient;

        const res = await processOverdueReminders(db);

        expect(res.processed).toBe(1203);
        expect(mockCreateTask).toHaveBeenCalledTimes(1203);
        expect(policyFindMany.mock.calls.length).toBeGreaterThan(1);
    });
});
