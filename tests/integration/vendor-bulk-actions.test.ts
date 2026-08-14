/**
 * Integration tests for the vendor bulk-action usecases — coverage wave A.
 *
 * Targets the two ZERO-reference public functions in
 * `src/app-layer/usecases/vendor.ts`:
 *   - bulkSetVendorStatus  (empty-set branch + happy path + per-row audit)
 *   - bulkAssignVendor     (empty-set branch + assign branch + clear branch)
 *
 * Plus the permission gate (canWrite) on each.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { ForbiddenError } from '@/lib/errors/types';
import { bulkSetVendorStatus, bulkAssignVendor, bulkDeleteVendor } from '@/app-layer/usecases/vendor';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `vbulk-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE}`;

let admin: { userId: string };
let reader: { userId: string };

async function makeUser(label: string): Promise<{ userId: string }> {
    const email = `${SUITE}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return { userId: u.id };
}

async function seedVendor(name: string, status = 'ONBOARDING', ownerUserId: string | null = null) {
    const v = await globalPrisma.vendor.create({
        data: {
            tenantId: TENANT_ID,
            name,
            status: status as 'ONBOARDING',
            criticality: 'MEDIUM',
            ...(ownerUserId ? { ownerUserId } : {}),
        },
    });
    return v.id;
}

function ctxAs(role: Role, userId: string) {
    return makeRequestContext(role, { userId, tenantId: TENANT_ID });
}

async function clearAudit() {
    await globalPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
    });
}

describeFn('vendor bulk actions — integration', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE}`, slug: SUITE },
        });
        admin = await makeUser('admin');
        reader = await makeUser('reader');
        await globalPrisma.tenantMembership.createMany({
            data: [
                { tenantId: TENANT_ID, userId: admin.userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
                { tenantId: TENANT_ID, userId: reader.userId, role: Role.READER, status: MembershipStatus.ACTIVE },
            ],
        });
    });

    afterEach(async () => {
        await globalPrisma.vendor.deleteMany({
            where: { tenantId: { in: [TENANT_ID, `${TENANT_ID}-other`] } },
        });
        await clearAudit();
    });

    afterAll(async () => {
        await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } });
        await clearAudit();
        await globalPrisma.user.deleteMany({ where: { id: { in: [admin.userId, reader.userId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    // ── bulkSetVendorStatus ──────────────────────────────────────

    it('bulkSetVendorStatus updates rows + emits one audit per row', async () => {
        const v1 = await seedVendor('Acme', 'ONBOARDING');
        const v2 = await seedVendor('Globex', 'ONBOARDING');

        // A non-ACTIVE transition is ungated — all rows eligible, none blocked.
        const res = await bulkSetVendorStatus(ctxAs(Role.ADMIN, admin.userId), [v1, v2], 'OFFBOARDING');
        expect(res).toEqual({ updated: 2, blocked: [] });

        const rows = await globalPrisma.vendor.findMany({ where: { tenantId: TENANT_ID } });
        expect(rows.every((r) => r.status === 'OFFBOARDING')).toBe(true);

        const audits = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, action: 'VENDOR_STATUS_CHANGED' },
        });
        expect(audits).toHaveLength(2);
    });

    it('bulkSetVendorStatus returns {updated:0} for an empty / unknown id set (early-return branch)', async () => {
        // No matching rows → findMany returns [] → the `rows.length === 0` guard fires.
        const res = await bulkSetVendorStatus(ctxAs(Role.ADMIN, admin.userId), ['no-such-id'], 'OFFBOARDED');
        expect(res).toEqual({ updated: 0, blocked: [] });
        const audits = await globalPrisma.auditLog.findMany({ where: { tenantId: TENANT_ID } });
        expect(audits).toHaveLength(0);
    });

    it('bulkSetVendorStatus rejects a READER (canWrite gate)', async () => {
        const v1 = await seedVendor('Initech');
        await expect(
            bulkSetVendorStatus(ctxAs(Role.READER, reader.userId), [v1], 'ACTIVE'),
        ).rejects.toBeInstanceOf(ForbiddenError);
    });

    // ── bulkAssignVendor ─────────────────────────────────────────

    it('bulkAssignVendor assigns an owner (truthy ownerUserId branch)', async () => {
        const v1 = await seedVendor('Umbrella');
        const v2 = await seedVendor('Soylent');

        const res = await bulkAssignVendor(ctxAs(Role.ADMIN, admin.userId), [v1, v2], admin.userId);
        expect(res).toEqual({ updated: 2 });

        const rows = await globalPrisma.vendor.findMany({ where: { tenantId: TENANT_ID } });
        expect(rows.every((r) => r.ownerUserId === admin.userId)).toBe(true);

        const audits = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, action: 'VENDOR_UPDATED' },
        });
        expect(audits).toHaveLength(2);
        expect(audits[0].details).toMatch(/reassigned/);
    });

    it('bulkAssignVendor clears an owner (null ownerUserId branch)', async () => {
        const v1 = await seedVendor('Tyrell', 'ONBOARDING', admin.userId);

        const res = await bulkAssignVendor(ctxAs(Role.ADMIN, admin.userId), [v1], null);
        expect(res).toEqual({ updated: 1 });

        const row = await globalPrisma.vendor.findUnique({ where: { id: v1 } });
        expect(row!.ownerUserId).toBeNull();

        const audit = await globalPrisma.auditLog.findFirst({
            where: { tenantId: TENANT_ID, action: 'VENDOR_UPDATED' },
        });
        expect(audit!.details).toMatch(/cleared/);
    });

    it('bulkAssignVendor returns {updated:0} for an empty id set (early-return branch)', async () => {
        const res = await bulkAssignVendor(ctxAs(Role.ADMIN, admin.userId), [], admin.userId);
        expect(res).toEqual({ updated: 0 });
    });

    it('bulkAssignVendor rejects a READER (canWrite gate)', async () => {
        const v1 = await seedVendor('Wonka');
        await expect(
            bulkAssignVendor(ctxAs(Role.READER, reader.userId), [v1], admin.userId),
        ).rejects.toBeInstanceOf(ForbiddenError);
    });

    /**
     * The count the client reports must be ACHIEVED, not REQUESTED.
     *
     * Every bulk usecase resolves its rows through a tenant-scoped listByIds
     * before acting, so an id that a teammate already deleted is silently
     * dropped. The clients used to toast `ids.length` regardless — select 10
     * where 3 were gone and the user was told 10 — while the single-item paths
     * throw notFound in exactly that situation.
     *
     * These prove the SERVER figure is genuinely reconciled, which is what the
     * clients now surface. Asserting it here rather than in the UI is
     * deliberate: this is where the number is decided.
     */
    it('bulkDeleteVendor reports rows ACTUALLY deleted, not ids requested', async () => {
        const alive = await seedVendor('Alive Co');
        const gone = await seedVendor('Gone Co');
        // A teammate got there first.
        await bulkDeleteVendor(ctxAs(Role.ADMIN, admin.userId), [gone]);

        const res = await bulkDeleteVendor(ctxAs(Role.ADMIN, admin.userId), [alive, gone]);
        expect(res).toEqual({ deleted: 1 });
    });

    it('bulkSetVendorStatus reports rows ACTUALLY updated', async () => {
        const alive = await seedVendor('Status Alive');
        const gone = await seedVendor('Status Gone');
        await bulkDeleteVendor(ctxAs(Role.ADMIN, admin.userId), [gone]);

        const res = await bulkSetVendorStatus(
            ctxAs(Role.ADMIN, admin.userId),
            [alive, gone],
            'OFFBOARDING',
        );
        expect(res.updated).toBe(1);
    });

    it('bulkAssignVendor reports rows ACTUALLY updated', async () => {
        const alive = await seedVendor('Assign Alive');
        const gone = await seedVendor('Assign Gone');
        await bulkDeleteVendor(ctxAs(Role.ADMIN, admin.userId), [gone]);

        const res = await bulkAssignVendor(
            ctxAs(Role.ADMIN, admin.userId),
            [alive, gone],
            admin.userId,
        );
        expect(res).toEqual({ updated: 1 });
    });

    it('an id from ANOTHER tenant is not counted', async () => {
        const mine = await seedVendor('Mine Co');
        // A real second tenant — Vendor.tenantId is an FK, so the row cannot
        // exist without one. Created here rather than in beforeAll so the rest
        // of the suite's fixture is unchanged.
        const otherTenant = `${TENANT_ID}-other`;
        await globalPrisma.tenant.upsert({
            where: { id: otherTenant },
            update: {},
            create: { id: otherTenant, name: `t ${SUITE} other`, slug: `${SUITE}-other` },
        });
        // Not routed through the usecase on purpose — this asserts the tenant
        // scoping in listByIds, so the row must exist without any tenant
        // context vouching for it.
        const foreign = await globalPrisma.vendor.create({
            data: {
                tenantId: otherTenant,
                name: 'Foreign Co',
                status: 'ONBOARDING',
                criticality: 'MEDIUM',
            },
            select: { id: true },
        });

        const res = await bulkDeleteVendor(ctxAs(Role.ADMIN, admin.userId), [mine, foreign.id]);
        expect(res).toEqual({ deleted: 1 });

        const stillThere = await globalPrisma.vendor.findUnique({ where: { id: foreign.id } });
        expect(stillThere).not.toBeNull();
    });
});
