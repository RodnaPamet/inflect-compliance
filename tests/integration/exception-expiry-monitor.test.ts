/**
 * Epic G-5 — exception-expiry-monitor integration tests.
 *
 * Coverage
 * --------
 *   1. calendar-day pure function (boundary math)
 *   2. reminderWindowFor selects 30/14/7 only
 *   3. APPROVED + in-window → enqueues notification (one per recipient)
 *   4. dedup per (exception, window, day) — re-running same day = 0 new
 *   5. different windows for the same exception are distinct rows
 *   6. NOT in-window (e.g. day-15) → no notification
 *   7. REJECTED / REQUESTED / EXPIRED rows skipped
 *   8. tenant scoping — single-tenant invocation never touches other
 *      tenants
 *   9. notifications-disabled tenant → no rows in the outbox
 *  10. duplicate recipient (riskAcceptedBy === approvedBy) →
 *      one email, not two
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import {
    calendarDaysUntil,
    reminderWindowFor,
    runExceptionExpiryMonitor,
} from '@/app-layer/jobs/exception-expiry-monitor';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `g5e-${randomUUID().slice(0, 8)}`;
const TENANT_A_ID = `t-${SUITE_TAG}-a`;
const TENANT_B_ID = `t-${SUITE_TAG}-b`;

let admin: { userId: string; email: string };
let approver: { userId: string; email: string };
let foreignAdmin: { userId: string };
let CONTROL_A_ID = '';
let CONTROL_B_ID = '';

async function makeUser(label: string): Promise<{ userId: string; email: string }> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return { userId: u.id, email };
}

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_A_ID },
        update: {},
        create: { id: TENANT_A_ID, name: `t ${SUITE_TAG}-a`, slug: `${SUITE_TAG}-a` },
    });
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_B_ID },
        update: {},
        create: { id: TENANT_B_ID, name: `t ${SUITE_TAG}-b`, slug: `${SUITE_TAG}-b` },
    });
    admin = await makeUser('admin');
    approver = await makeUser('approver');
    foreignAdmin = await makeUser('foreign');
    await globalPrisma.tenantMembership.createMany({
        data: [
            { tenantId: TENANT_A_ID, userId: admin.userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_A_ID, userId: approver.userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_B_ID, userId: foreignAdmin.userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
        ],
    });
    const a = await globalPrisma.control.create({
        data: { tenantId: TENANT_A_ID, name: 'A: control under exception', code: 'AC.42' },
    });
    CONTROL_A_ID = a.id;
    const b = await globalPrisma.control.create({
        data: { tenantId: TENANT_B_ID, name: 'B: control', code: 'BC.7' },
    });
    CONTROL_B_ID = b.id;
}

async function teardown() {
    const tenantIds = [TENANT_A_ID, TENANT_B_ID];
    await globalPrisma.notificationOutbox.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.tenantNotificationSettings.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.controlException.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.control.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.tenantMembership.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
            `SET LOCAL session_replication_role = 'replica'`,
        );
        await tx.$executeRawUnsafe(
            `DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`,
            tenantIds,
        );
    });
    const userIds = [admin, approver, foreignAdmin]
        .filter(Boolean)
        .map((u) => u.userId);
    if (userIds.length > 0) {
        await globalPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await globalPrisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

interface ExceptionSetup {
    tenantId?: string;
    controlId?: string;
    expiresAt: Date;
    riskAcceptedByUserId?: string;
    approvedByUserId?: string;
    status?: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
}

async function makeException(setup: ExceptionSetup) {
    const tenantId = setup.tenantId ?? TENANT_A_ID;
    const controlId = setup.controlId ?? CONTROL_A_ID;
    const riskAcceptedByUserId = setup.riskAcceptedByUserId ?? admin.userId;
    const status = setup.status ?? 'APPROVED';
    const isApproved = status === 'APPROVED' || status === 'EXPIRED';
    return globalPrisma.controlException.create({
        data: {
            tenantId,
            controlId,
            justification: 'auto-fixture',
            riskAcceptedByUserId,
            createdByUserId: riskAcceptedByUserId,
            status,
            expiresAt: setup.expiresAt,
            ...(isApproved
                ? {
                      approvedAt: new Date(setup.expiresAt.getTime() - 60 * 24 * 60 * 60 * 1000),
                      approvedByUserId: setup.approvedByUserId ?? approver.userId,
                  }
                : {}),
            ...(status === 'REJECTED'
                ? {
                      rejectedAt: new Date(),
                      rejectedByUserId: approver.userId,
                  }
                : {}),
        },
    });
}

const futureMidnight = (days: number) => {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
};

// ─── Pure-function tests ───────────────────────────────────────────

describe('Epic G-5 expiry monitor — boundary math', () => {
    it('calendarDaysUntil ignores time-of-day', () => {
        // 2 days minus 1 minute is still 2 calendar days.
        const now = new Date('2026-05-07T23:00:00Z');
        const expires = new Date('2026-05-09T00:01:00Z');
        expect(calendarDaysUntil(expires, now)).toBe(2);
    });

    it('reminderWindowFor returns the matching window or null', () => {
        const now = new Date('2026-05-07T12:00:00Z');
        // 30 days out — at midnight UTC.
        const in30 = new Date('2026-06-06T12:00:00Z');
        expect(reminderWindowFor(in30, now)).toBe(30);
        const in14 = new Date('2026-05-21T12:00:00Z');
        expect(reminderWindowFor(in14, now)).toBe(14);
        const in7 = new Date('2026-05-14T12:00:00Z');
        expect(reminderWindowFor(in7, now)).toBe(7);
        // 15 days — not a window.
        const in15 = new Date('2026-05-22T12:00:00Z');
        expect(reminderWindowFor(in15, now)).toBeNull();
    });
});

// ─── DB integration ────────────────────────────────────────────────

describeFn('Epic G-5 expiry monitor — DB integration', () => {
    beforeAll(async () => {
        await seed();
    });
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });
    afterEach(async () => {
        await globalPrisma.notificationOutbox.deleteMany({
            where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
        });
        await globalPrisma.controlException.deleteMany({
            where: { tenantId: { in: [TENANT_A_ID, TENANT_B_ID] } },
        });
    });

    it('APPROVED exception in 30-day window enqueues a reminder for each recipient', async () => {
        const ex = await makeException({ expiresAt: futureMidnight(30) });
        const r = await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_A_ID,
        });
        // Two recipients: risk-accepter (admin) + approver.
        expect(r.scanned).toBe(1);
        expect(r.enqueued).toBe(2);
        const outbox = await globalPrisma.notificationOutbox.findMany({
            where: { tenantId: TENANT_A_ID, type: 'EXCEPTION_EXPIRING' },
            orderBy: { toEmail: 'asc' },
        });
        expect(outbox).toHaveLength(2);
        for (const o of outbox) {
            expect(o.subject).toMatch(/expires in 30 days/i);
            expect(o.dedupeKey).toContain(`${ex.id}:30d`);
        }
    });

    it('re-running on the same day is idempotent — no duplicate rows', async () => {
        await makeException({ expiresAt: futureMidnight(30) });
        const first = await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_A_ID,
        });
        const second = await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_A_ID,
        });
        expect(first.enqueued).toBeGreaterThan(0);
        expect(second.enqueued).toBe(0);
        expect(second.skippedDuplicate).toBe(first.enqueued);
        const outbox = await globalPrisma.notificationOutbox.findMany({
            where: { tenantId: TENANT_A_ID, type: 'EXCEPTION_EXPIRING' },
        });
        expect(outbox).toHaveLength(first.enqueued);
    });

    it('different windows for the same exception are distinct outbox rows', async () => {
        // Same exception scanned today (30-day window) and again
        // simulating "tomorrow" with `now=tomorrow` and `expiresAt`
        // adjusted so calendar-days-until = 14. The dedupeKey
        // changes (entityId carries the window). Both rows land.
        const ex = await makeException({ expiresAt: futureMidnight(30) });
        await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_A_ID,
        });
        // Re-target the exception to 14-day window + advance "now".
        await globalPrisma.controlException.update({
            where: { id: ex.id },
            data: { expiresAt: futureMidnight(14) },
        });
        // Different bucket → different entityId → different dedupeKey.
        const r = await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_A_ID,
        });
        expect(r.enqueued).toBeGreaterThan(0);
        const buckets = await globalPrisma.notificationOutbox.findMany({
            where: { tenantId: TENANT_A_ID, type: 'EXCEPTION_EXPIRING' },
            select: { dedupeKey: true },
        });
        const has30 = buckets.some((b) => b.dedupeKey.includes(`${ex.id}:30d`));
        const has14 = buckets.some((b) => b.dedupeKey.includes(`${ex.id}:14d`));
        expect(has30).toBe(true);
        expect(has14).toBe(true);
    });

    it('day-15 (out-of-window) emits nothing', async () => {
        await makeException({ expiresAt: futureMidnight(15) });
        const r = await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_A_ID,
        });
        expect(r.scanned).toBe(0);
        expect(r.enqueued).toBe(0);
    });

    it('non-APPROVED rows are skipped', async () => {
        await makeException({
            expiresAt: futureMidnight(30),
            status: 'REQUESTED',
        });
        await makeException({
            expiresAt: futureMidnight(30),
            status: 'REJECTED',
        });
        await makeException({
            expiresAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
            status: 'EXPIRED',
        });
        const r = await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_A_ID,
        });
        expect(r.scanned).toBe(0);
        expect(r.enqueued).toBe(0);
    });

    it('tenant-scoped invocation never reaches other tenants', async () => {
        await makeException({ expiresAt: futureMidnight(30) });
        await makeException({
            tenantId: TENANT_B_ID,
            controlId: CONTROL_B_ID,
            riskAcceptedByUserId: foreignAdmin.userId,
            approvedByUserId: foreignAdmin.userId,
            expiresAt: futureMidnight(30),
        });
        await runExceptionExpiryMonitor(globalPrisma, { tenantId: TENANT_A_ID });
        const otherOutbox = await globalPrisma.notificationOutbox.findMany({
            where: { tenantId: TENANT_B_ID, type: 'EXCEPTION_EXPIRING' },
        });
        expect(otherOutbox).toHaveLength(0);
    });

    it('respects tenant notifications-disabled', async () => {
        await globalPrisma.tenantNotificationSettings.upsert({
            where: { tenantId: TENANT_A_ID },
            update: { enabled: false },
            create: { tenantId: TENANT_A_ID, enabled: false, defaultFromEmail: 'fixture@example.test' },
        });
        try {
            await makeException({ expiresAt: futureMidnight(30) });
            const r = await runExceptionExpiryMonitor(globalPrisma, {
                tenantId: TENANT_A_ID,
            });
            expect(r.scanned).toBe(1);
            expect(r.enqueued).toBe(0);
            const outbox = await globalPrisma.notificationOutbox.findMany({
                where: { tenantId: TENANT_A_ID, type: 'EXCEPTION_EXPIRING' },
            });
            expect(outbox).toHaveLength(0);
        } finally {
            await globalPrisma.tenantNotificationSettings.delete({
                where: { tenantId: TENANT_A_ID },
            });
        }
    });

    it('deduplicates the recipient when riskAcceptedBy === approvedBy', async () => {
        // Same user is both the risk accepter AND the approver.
        await makeException({
            expiresAt: futureMidnight(30),
            riskAcceptedByUserId: admin.userId,
            approvedByUserId: admin.userId,
        });
        const r = await runExceptionExpiryMonitor(globalPrisma, {
            tenantId: TENANT_A_ID,
        });
        expect(r.scanned).toBe(1);
        // Just one email — the duplicate-recipient check fires.
        expect(r.enqueued).toBe(1);
        const outbox = await globalPrisma.notificationOutbox.findMany({
            where: { tenantId: TENANT_A_ID, type: 'EXCEPTION_EXPIRING' },
        });
        expect(outbox).toHaveLength(1);
        expect(outbox[0].toEmail).toBe(admin.email);
    });
});
