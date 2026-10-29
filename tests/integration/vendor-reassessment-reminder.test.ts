/**
 * The nightly vendor reassessment reminder, against a real database (#4462).
 *
 * Two properties the unit test can only describe, because both are the
 * database's: the reminder is written ONCE per overdue date however many
 * nights the vendor stays overdue (the Notification `dedupeKey` unique index),
 * and the vendor's `nextReviewAt` is left exactly where it was.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { runVendorReassessmentReminder } from '@/app-layer/usecases/vendor-reassessment-reminder';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `vrem-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE}`;
const DUE = new Date('2026-05-01T09:30:00.000Z');

describeFn('vendor reassessment reminder — integration', () => {
    let ownerId: string;

    beforeAll(async () => {
        await globalPrisma.tenant.create({ data: { id: TENANT_ID, name: `t ${SUITE}`, slug: SUITE } });
        const email = `${SUITE}-owner@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        ownerId = u.id;
        await globalPrisma.tenantMembership.create({
            data: { tenantId: TENANT_ID, userId: ownerId, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
        });
    });

    afterEach(async () => {
        await globalPrisma.notification.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.vendor.deleteMany({ where: { tenantId: TENANT_ID } });
    });

    afterAll(async () => {
        await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } });
        // The sweep writes no audit row, but the fixtures can (the audit
        // extension records each statement), and a row would block the deletes.
        await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
        await globalPrisma.user.deleteMany({ where: { id: ownerId } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('reminds the owner once across several nights and never moves the review date', async () => {
        const v = await globalPrisma.vendor.create({
            data: { tenantId: TENANT_ID, name: 'Overdue Co', ownerUserId: ownerId, nextReviewAt: DUE },
        });

        const first = await runVendorReassessmentReminder({
            tenantId: TENANT_ID,
            now: new Date('2026-05-24T02:00:00Z'),
        });
        const second = await runVendorReassessmentReminder({
            tenantId: TENANT_ID,
            now: new Date('2026-05-25T02:00:00Z'),
        });

        expect(first.reminded).toBe(1);
        expect(second.reminded).toBe(0);
        const rows = await globalPrisma.notification.findMany({
            where: { tenantId: TENANT_ID, type: 'VENDOR_REVIEW_DUE' },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].userId).toBe(ownerId);

        // The vendor is still overdue, on its original date — the sweep used
        // to push it to now + 365 days, unaudited.
        const after = await globalPrisma.vendor.findUniqueOrThrow({ where: { id: v.id } });
        expect(after.nextReviewAt?.toISOString()).toBe(DUE.toISOString());
    });

    it('a vendor with no owner is left alone: no reminder, no date change', async () => {
        const v = await globalPrisma.vendor.create({
            data: { tenantId: TENANT_ID, name: 'Unowned Co', nextReviewAt: DUE },
        });

        const out = await runVendorReassessmentReminder({ tenantId: TENANT_ID });

        expect(out.reminded).toBe(0);
        expect(await globalPrisma.notification.count({ where: { tenantId: TENANT_ID } })).toBe(0);
        const after = await globalPrisma.vendor.findUniqueOrThrow({ where: { id: v.id } });
        expect(after.nextReviewAt?.toISOString()).toBe(DUE.toISOString());
    });
});
