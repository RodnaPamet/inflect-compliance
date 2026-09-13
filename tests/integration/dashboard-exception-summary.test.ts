/**
 * Epic G-5 — dashboard `getExceptionSummary` aggregation test.
 *
 * Confirms the five counts surface the right slices:
 *   activeApproved    — APPROVED rows with no expiry OR expiry in future
 *   pendingRequest    — REQUESTED rows still awaiting an approver
 *   expiringWithin30  — APPROVED + expiry within next 30 days
 *   expiringWithin7   — APPROVED + expiry within next 7 days
 *   expired           — EXPIRED rows
 *
 * Soft-deleted rows are excluded from every bucket.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { DashboardRepository } from '@/app-layer/repositories/DashboardRepository';
import { runInTenantContext } from '@/lib/db-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
const SUITE_TAG = `g5d-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let admin: { userId: string };
let CONTROL_ID = '';

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
    });
    const u = await globalPrisma.user.create({
        data: {
            email: `${SUITE_TAG}-admin@example.test`,
            emailHash: hashForLookup(`${SUITE_TAG}-admin@example.test`),
        },
    });
    admin = { userId: u.id };
    await globalPrisma.tenantMembership.create({
        data: {
            tenantId: TENANT_ID,
            userId: admin.userId,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });
    const c = await globalPrisma.control.create({
        data: { tenantId: TENANT_ID, name: 'control' },
    });
    CONTROL_ID = c.id;
}

async function teardown() {
    await globalPrisma.controlException.deleteMany({
        where: { tenantId: TENANT_ID },
    });
    await globalPrisma.control.deleteMany({ where: { tenantId: TENANT_ID } });
    await globalPrisma.tenantMembership.deleteMany({
        where: { tenantId: TENANT_ID },
    });
    await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
    if (admin) {
        await globalPrisma.user.delete({ where: { id: admin.userId } });
    }
    await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
}

const futureDate = (days: number) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000);
const pastDate = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describeFn('Epic G-5 — dashboard exception summary', () => {
    beforeAll(async () => {
        await seed();
    });
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });
    afterEach(async () => {
        await globalPrisma.controlException.deleteMany({
            where: { tenantId: TENANT_ID },
        });
    });

    it('counts each bucket independently and excludes soft-deleted rows', async () => {
        // Set up a varied population.
        const mk = (data: Partial<{
            status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
            expiresAt: Date | null;
            approvedAt: Date | null;
            approvedByUserId: string | null;
            rejectedAt: Date | null;
            rejectedByUserId: string | null;
            deletedAt: Date | null;
        }> = {}) =>
            globalPrisma.controlException.create({
                data: {
                    tenantId: TENANT_ID,
                    controlId: CONTROL_ID,
                    justification: 'fixture',
                    riskAcceptedByUserId: admin.userId,
                    createdByUserId: admin.userId,
                    status: data.status ?? 'APPROVED',
                    expiresAt: data.expiresAt ?? null,
                    approvedAt:
                        data.status === 'APPROVED' || data.status === 'EXPIRED'
                            ? data.approvedAt ?? new Date()
                            : null,
                    approvedByUserId:
                        data.status === 'APPROVED' || data.status === 'EXPIRED'
                            ? data.approvedByUserId ?? admin.userId
                            : null,
                    rejectedAt: data.status === 'REJECTED' ? new Date() : null,
                    rejectedByUserId:
                        data.status === 'REJECTED' ? admin.userId : null,
                    deletedAt: data.deletedAt ?? null,
                    deletedByUserId: data.deletedAt ? admin.userId : null,
                },
            });

        // The CHECK constraint requires APPROVED rows to carry an
        // expiresAt — see migration 20260507140000. So every active
        // APPROVED fixture has a future expiry.
        // 1× APPROVED expiring in 90d → activeApproved (outside 30 + 7)
        await mk({ status: 'APPROVED', expiresAt: futureDate(90) });
        // 1× APPROVED expiring in 60d → activeApproved (outside 30 + 7)
        await mk({ status: 'APPROVED', expiresAt: futureDate(60) });
        // 1× APPROVED expiring in 20d → activeApproved + expiringWithin30
        await mk({ status: 'APPROVED', expiresAt: futureDate(20) });
        // 1× APPROVED expiring in 5d → activeApproved + expiringWithin30 + expiringWithin7
        await mk({ status: 'APPROVED', expiresAt: futureDate(5) });
        // 1× REQUESTED → pendingRequest
        await mk({ status: 'REQUESTED' });
        // 1× EXPIRED → expired
        await mk({
            status: 'EXPIRED',
            expiresAt: pastDate(10),
            approvedAt: pastDate(100),
        });
        // 1× REJECTED → no bucket
        await mk({ status: 'REJECTED' });
        // 1× soft-deleted APPROVED → no bucket
        await mk({
            status: 'APPROVED',
            expiresAt: futureDate(20),
            deletedAt: new Date(),
        });

        const ctx = makeRequestContext(Role.ADMIN, {
            userId: admin.userId,
            tenantId: TENANT_ID,
        });
        const summary = await runInTenantContext(ctx, (db) =>
            DashboardRepository.getExceptionSummary(db, ctx),
        );

        // 4 APPROVED rows are activeApproved (90d + 60d + 20d + 5d).
        // The soft-deleted APPROVED is excluded.
        expect(summary.activeApproved).toBe(4);
        expect(summary.pendingRequest).toBe(1);
        // 20d AND 5d are inside 30. 60d is outside.
        expect(summary.expiringWithin30).toBe(2);
        // Only 5d is inside 7.
        expect(summary.expiringWithin7).toBe(1);
        expect(summary.expired).toBe(1);
    });

    it('returns zeros for a tenant with no exceptions', async () => {
        const ctx = makeRequestContext(Role.ADMIN, {
            userId: admin.userId,
            tenantId: TENANT_ID,
        });
        const summary = await runInTenantContext(ctx, (db) =>
            DashboardRepository.getExceptionSummary(db, ctx),
        );
        expect(summary).toEqual({
            activeApproved: 0,
            pendingRequest: 0,
            expiringWithin30: 0,
            expiringWithin7: 0,
            expired: 0,
        });
    });
});
