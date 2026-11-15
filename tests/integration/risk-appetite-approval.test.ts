/**
 * #5313 item 11 — an approval of the risk appetite is bound to the version the
 * approver was shown (owner decision 2026-11-15). DB-backed, because what is
 * under test is what Postgres does with the conditional write and the row
 * lock, not what a mock was told to return.
 *
 * - A save made after the approver's page loaded moves `updatedAt`, so the
 *   approval's conditional write matches nothing: 409, and no stamp is stored.
 * - The stamp itself moves `updatedAt` (`@updatedAt`), so a second approval
 *   from a page that has not re-read is refused the same way.
 * - A save running while an approval is in flight cannot keep that approval
 *   on terms the approver never saw: the save locks the row before it reads
 *   it, waits for the approval, and then clears it.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { upsertAppetiteConfig, approveAppetiteConfig } from '@/app-layer/usecases/risk-appetite';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `appetite-approve-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let ownerId = '';
let adminId = '';
let ownerCtx: ReturnType<typeof makeRequestContext>;
let adminCtx: ReturnType<typeof makeRequestContext>;

/** What the approver's page loaded: the row's id and its `updatedAt`. */
async function view() {
    const row = await globalPrisma.riskAppetiteConfig.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
    return { configId: row.id, viewedUpdatedAt: row.updatedAt.toISOString() };
}

async function stored() {
    return globalPrisma.riskAppetiteConfig.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
}

async function approvalAuditRows() {
    return globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'RISK_APPETITE_APPROVED' } });
}

describeFn('risk appetite approval is bound to the version shown (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        for (const [role, set] of [[Role.OWNER, (id: string) => { ownerId = id; }], [Role.ADMIN, (id: string) => { adminId = id; }]] as const) {
            const email = `${role.toLowerCase()}-${TAG}@example.test`;
            const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            set(u.id);
            await globalPrisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE } });
        }
        ownerCtx = makeRequestContext('OWNER', { userId: ownerId, tenantId: TENANT_ID, tenantSlug: TAG });
        adminCtx = makeRequestContext('ADMIN', { userId: adminId, tenantId: TENANT_ID, tenantSlug: TAG });
    });

    beforeEach(async () => {
        await globalPrisma.riskAppetiteConfig.deleteMany({ where: { tenantId: TENANT_ID } });
        await upsertAppetiteConfig(adminCtx, { totalAleThreshold: 1_000_000, appetiteStatement: 'Moderate.' });
    });

    afterAll(async () => {
        // Only this suite's own row. The tenant, its users and memberships
        // stay: the tenant id is unique to this run, `resetDatabase`
        // truncates, and deleting them would fight the last-OWNER trigger and
        // the audit rows the usecases wrote (see
        // tests/guards/integration-suite-audit-teardown.test.ts).
        await globalPrisma.riskAppetiteConfig.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('a save made after the view makes the approval fail, and stores no stamp', async () => {
        const viewed = await view();
        const auditBefore = await approvalAuditRows();
        // Somebody saves new limits while the approver is reading the page.
        await upsertAppetiteConfig(adminCtx, { totalAleThreshold: 5_000_000, appetiteStatement: 'Moderate.' });

        await expect(approveAppetiteConfig(ownerCtx, viewed)).rejects.toMatchObject({
            status: 409,
            details: { reason: 'RISK_APPETITE_CHANGED_SINCE_VIEWED' },
        });
        const row = await stored();
        expect(row.totalAleThreshold).toBe(5_000_000);
        expect(row.approvedAt).toBeNull();
        expect(row.approvedByUserId).toBeNull();
        expect(await approvalAuditRows()).toBe(auditBefore);
    });

    it('an approval of the version shown stamps it; the stamp moves updatedAt, so a stale page cannot approve again', async () => {
        const viewed = await view();
        await approveAppetiteConfig(ownerCtx, viewed);
        const row = await stored();
        expect(row.approvedByUserId).toBe(ownerId);
        expect(row.approvedAt).not.toBeNull();
        expect(row.updatedAt.toISOString()).not.toBe(viewed.viewedUpdatedAt);

        await expect(approveAppetiteConfig(ownerCtx, viewed)).rejects.toMatchObject({ status: 409 });
        // The re-read version approves.
        await expect(approveAppetiteConfig(ownerCtx, await view())).resolves.toMatchObject({ approvedByUserId: ownerId });
    });

    it('an approval naming another row of the tenant is refused, even at the same updatedAt', async () => {
        const viewed = await view();
        await expect(approveAppetiteConfig(ownerCtx, { ...viewed, configId: 'not-this-row' }))
            .rejects.toMatchObject({ status: 409 });
        expect((await stored()).approvedAt).toBeNull();
    });

    it('a save that runs while an approval is in flight clears that approval once it lands', async () => {
        // An approval of the old terms, stamped but not yet committed: it
        // holds the row lock.
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        let stampedSignal!: () => void;
        const stamped = new Promise<void>((r) => { stampedSignal = r; });
        const approval = globalPrisma.$transaction(async (tx) => {
            await tx.riskAppetiteConfig.updateMany({
                where: { tenantId: TENANT_ID },
                data: { approvedByUserId: ownerId, approvedAt: new Date() },
            });
            stampedSignal();
            await gate;
        }, { timeout: 20_000, maxWait: 5_000 });
        await stamped;

        // A save of new limits starts while that approval is open. Without the
        // save's row lock it would read the row as unapproved, keep "no
        // approval to clear", and write the new limits under the stamp.
        const save = upsertAppetiteConfig(adminCtx, { totalAleThreshold: 7_000_000, appetiteStatement: 'Moderate.' });
        await new Promise((r) => setTimeout(r, 750));
        release();
        await approval;
        await save;

        const row = await stored();
        expect(row.totalAleThreshold).toBe(7_000_000);
        expect(row.approvedAt).toBeNull();
        expect(row.approvedByUserId).toBeNull();
    });
});
