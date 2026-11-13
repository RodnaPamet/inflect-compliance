/**
 * Per-user scope of `listMyNotifications` / `markNotificationRead` (#5376).
 *
 * A notification belongs to one user in one tenant. Both usecases admit every
 * role (`assertCanRead`), so the ONLY thing standing between user B and user
 * A's notifications is the `userId` + `tenantId` predicate in
 * `NotificationRepository`. These prove it against a real database, for a
 * second user in the SAME tenant and for the same user reaching through
 * ANOTHER tenant:
 *
 *   • B's list never contains A's notifications;
 *   • B marking A's notification read leaves it unread (the usecase answers
 *     `{ success: true }` either way — it does not reveal whether the id
 *     exists — so the row itself is what is checked);
 *   • A's own mark-read does take effect, so the negative cases are not
 *     passing because marking is broken.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { listMyNotifications, markNotificationRead } from '@/app-layer/usecases/notification';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `nps-${randomUUID().slice(0, 8)}`;
const TENANT_A = `t-${TAG}-a`;
const TENANT_B = `t-${TAG}-b`;

let userA = '';
let userB = '';
let NOTE_A = '';

async function makeUser(label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    return (await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
}

async function notify(tenantId: string, userId: string, title: string) {
    return globalPrisma.notification.create({
        data: { tenantId, userId, title: `${TAG} ${title}`, message: 'm' },
    });
}

const ctxFor = (tenantId: string, userId: string, role: Role = Role.READER) =>
    makeRequestContext(role, { tenantId, userId, tenantSlug: tenantId });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    for (const id of [TENANT_A, TENANT_B]) {
        await globalPrisma.tenant.create({ data: { id, name: id, slug: id } });
    }
    userA = await makeUser('a');
    userB = await makeUser('b');
    // A is in tenant A only; B is in both, so the cross-tenant case is B
    // using a legitimate membership of tenant B to reach tenant A's rows.
    await globalPrisma.tenantMembership.createMany({
        data: [
            { tenantId: TENANT_A, userId: userA, role: Role.READER, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_A, userId: userB, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_B, userId: userB, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        ],
    });
    NOTE_A = (await notify(TENANT_A, userA, 'for A')).id;
    await notify(TENANT_A, userB, 'for B in A');
    await notify(TENANT_B, userB, 'for B in B');
});

afterAll(async () => {
    if (DB_AVAILABLE) {
        const tenants = { tenantId: { in: [TENANT_A, TENANT_B] } };
        try { await globalPrisma.notification.deleteMany({ where: tenants }); } catch { /* best effort */ }
        try { await globalPrisma.tenantMembership.deleteMany({ where: tenants }); } catch { /* best effort */ }
    }
    await globalPrisma.$disconnect();
});

async function isRead(id: string) {
    return (await globalPrisma.notification.findUniqueOrThrow({ where: { id } })).read;
}

describeFn('notifications are scoped to their own user (integration)', () => {
    it('each user lists only their own notifications in the tenant they are in', async () => {
        const aList = await listMyNotifications(ctxFor(TENANT_A, userA));
        expect(aList.map((n) => n.title)).toEqual([`${TAG} for A`]);

        // B is an ADMIN of tenant A — role does not widen the list.
        const bInA = await listMyNotifications(ctxFor(TENANT_A, userB, Role.ADMIN));
        expect(bInA.map((n) => n.title)).toEqual([`${TAG} for B in A`]);
        expect(bInA.some((n) => n.id === NOTE_A)).toBe(false);

        const bInB = await listMyNotifications(ctxFor(TENANT_B, userB, Role.OWNER));
        expect(bInB.map((n) => n.title)).toEqual([`${TAG} for B in B`]);
    });

    it("user B cannot mark user A's notification read in the same tenant", async () => {
        await expect(markNotificationRead(ctxFor(TENANT_A, userB, Role.ADMIN), NOTE_A))
            .resolves.toEqual({ success: true });
        expect(await isRead(NOTE_A)).toBe(false);
    });

    it("user B cannot mark user A's notification read through another tenant", async () => {
        await expect(markNotificationRead(ctxFor(TENANT_B, userB, Role.OWNER), NOTE_A))
            .resolves.toEqual({ success: true });
        expect(await isRead(NOTE_A)).toBe(false);
    });

    it("user A's own notification is not reachable from tenant B even by user A", async () => {
        // A context naming the right user but the wrong tenant matches nothing.
        await markNotificationRead(ctxFor(TENANT_B, userA), NOTE_A);
        expect(await isRead(NOTE_A)).toBe(false);
        expect(await listMyNotifications(ctxFor(TENANT_B, userA))).toEqual([]);
    });

    it('user A can mark their own notification read', async () => {
        await markNotificationRead(ctxFor(TENANT_A, userA), NOTE_A);
        expect(await isRead(NOTE_A)).toBe(true);
    });
});
