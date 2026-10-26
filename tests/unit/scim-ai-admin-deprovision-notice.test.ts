/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fakes for Prisma delegates. */
/**
 * A directory (SCIM) deprovision of an AI admin tells the workspace's Owners
 * (owner decision, 2026-10-25).
 *
 * The deprovision itself is unchanged — the owner decision of 2026-10-18 lets
 * the directory switch an AI_ADMIN off, so a leaver loses the agent keys at
 * once. What this adds is that an Owner hears about it: on the members page
 * only an Owner deactivates an AI admin (#4118), so the directory doing it is
 * the one way it can happen without an Owner's own hand on it.
 *
 * The prisma fake keeps the property the dedupe relies on: `createMany` with
 * `skipDuplicates` skips a row whose `dedupeKey` is already stored, as the
 * unique index does.
 */

const stored: Array<{ userId: string; title: string; message: string; linkUrl: string | null; dedupeKey: string; type: string }> = [];
const mockPublish = jest.fn();

/** `createMany` with `skipDuplicates`: a stored `dedupeKey` is skipped, as the unique index does. */
const createManyImpl = async ({ data }: any) => {
    let count = 0;
    for (const row of data) {
        if (stored.some((n) => n.dedupeKey === row.dedupeKey)) continue;
        stored.push(row);
        count++;
    }
    return { count };
};

const db: any = {
    user: {
        findUnique: jest.fn(async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' })),
        update: jest.fn(),
    },
    tenant: { findUnique: jest.fn(async () => ({ slug: 'acme' })) },
    tenantMembership: {
        findFirst: jest.fn(),
        findMany: jest.fn(async () => [{ userId: 'owner-1' }, { userId: 'owner-2' }]),
        update: jest.fn(async () => ({})),
        count: jest.fn(async () => 0),
    },
    notification: { createMany: jest.fn(createManyImpl) },
};

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: db, prisma: db }));
jest.mock('@/lib/audit/audit-writer', () => ({ appendAuditEntry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/notifications/notification-bus', () => ({
    publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

import { scimDeleteUser, scimPatchUser, scimPutUser } from '@/app-layer/usecases/scim-users';
import {
    notifyOwnersOfScimAiAdminDeprovision,
    SCIM_AI_ADMIN_DEPROVISIONED_TITLE,
} from '@/app-layer/notifications/scim-deprovision';

const scimCtx = { tenantId: 'tenant-1', tokenLabel: 'okta-prod', tokenId: 'tok-1' };

const membership = (role: string, status = 'ACTIVE') => ({
    id: 'm-1',
    tenantId: 'tenant-1',
    userId: 'u-ai',
    role,
    status,
    user: { id: 'u-ai', email: 'ada@example.com', name: 'Ada Lovelace', createdAt: new Date(), updatedAt: new Date() },
});

beforeEach(() => {
    jest.clearAllMocks();
    stored.length = 0;
    // RESET, not clear: a queued `…Once` a test set and the code never read
    // would otherwise leak into the next test.
    db.notification.createMany.mockReset().mockImplementation(createManyImpl);
});

describe('a SCIM deprovision of an AI admin notifies every active Owner', () => {
    it.each([
        ['DELETE', () => scimDeleteUser(scimCtx, 'u-ai')],
        ['PATCH active:false', () => scimPatchUser(scimCtx, 'u-ai', [{ op: 'replace', path: 'active', value: false }], 'https://x')],
        ['PUT active:false', () => scimPutUser(scimCtx, 'u-ai', { userName: 'ada@example.com', active: false }, 'https://x')],
    ])('%s', async (_label, call) => {
        db.tenantMembership.findFirst.mockResolvedValue(membership('AI_ADMIN'));

        await call();

        // The deprovision itself happened, as it always did.
        expect(db.tenantMembership.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'DEACTIVATED' }) }),
        );
        expect(stored.map((n) => n.userId)).toEqual(['owner-1', 'owner-2']);
        for (const n of stored) {
            expect(n.type).toBe('GENERAL');
            expect(n.title).toBe(SCIM_AI_ADMIN_DEPROVISIONED_TITLE);
            expect(n.message).toContain('Ada Lovelace');
            expect(n.message).toContain('identity provider (SCIM)');
            expect(n.linkUrl).toBe('/t/acme/admin/members');
        }
        // Recipients are ACTIVE Owners of THIS workspace, bounded.
        expect(db.tenantMembership.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { tenantId: 'tenant-1', role: 'OWNER', status: 'ACTIVE' },
                take: 50,
            }),
        );
        expect(mockPublish).toHaveBeenCalledTimes(2);
    });

    it('notifies nobody for a role other than AI admin', async () => {
        db.tenantMembership.findFirst.mockResolvedValue(membership('EDITOR'));
        await scimDeleteUser(scimCtx, 'u-ai');
        expect(db.tenantMembership.update).toHaveBeenCalled();
        expect(db.notification.createMany).not.toHaveBeenCalled();
    });

    it('notifies nobody when the AI admin was already deactivated (a repeated DELETE)', async () => {
        db.tenantMembership.findFirst.mockResolvedValue(membership('AI_ADMIN', 'DEACTIVATED'));
        await scimDeleteUser(scimCtx, 'u-ai');
        expect(db.notification.createMany).not.toHaveBeenCalled();
    });

    it('a reactivation is not a deprovision', async () => {
        db.tenantMembership.findFirst.mockResolvedValue(membership('AI_ADMIN', 'DEACTIVATED'));
        await scimPatchUser(scimCtx, 'u-ai', [{ op: 'replace', path: 'active', value: true }], 'https://x');
        expect(db.notification.createMany).not.toHaveBeenCalled();
    });

    it('a failed notification does not fail the deprovision', async () => {
        db.tenantMembership.findFirst.mockResolvedValue(membership('AI_ADMIN'));
        db.notification.createMany.mockRejectedValueOnce(new Error('notification table down'));
        await expect(scimDeleteUser(scimCtx, 'u-ai')).resolves.toBe(true);
        expect(db.tenantMembership.update).toHaveBeenCalled();
    });
});

describe('notifyOwnersOfScimAiAdminDeprovision', () => {
    const input = (deactivatedAt: Date) => ({ tenantId: 'tenant-1', userId: 'u-ai', membershipId: 'm-1', deactivatedAt });

    it('dedupes a retry of the same deprovision, and tells them again about a later one', async () => {
        const first = new Date('2026-10-25T10:00:00.000Z');
        expect(await notifyOwnersOfScimAiAdminDeprovision(db, input(first))).toEqual({ created: 2 });
        expect(await notifyOwnersOfScimAiAdminDeprovision(db, input(first))).toEqual({ created: 0 });
        // Published only for the real write.
        expect(mockPublish).toHaveBeenCalledTimes(2);

        const later = new Date('2026-11-02T09:00:00.000Z');
        expect(await notifyOwnersOfScimAiAdminDeprovision(db, input(later))).toEqual({ created: 2 });
        expect(stored).toHaveLength(4);
    });

    it('names the person by email when they have no name', async () => {
        db.user.findUnique.mockResolvedValueOnce({ name: null, email: 'ada@example.com' });
        await notifyOwnersOfScimAiAdminDeprovision(db, input(new Date()));
        expect(stored[0].message.startsWith('ada@example.com was deactivated')).toBe(true);
    });

    it('writes nothing when the workspace has no active Owner', async () => {
        db.tenantMembership.findMany.mockResolvedValueOnce([]);
        expect(await notifyOwnersOfScimAiAdminDeprovision(db, input(new Date()))).toEqual({ created: 0 });
        expect(db.notification.createMany).not.toHaveBeenCalled();
    });
});
