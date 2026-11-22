/**
 * A bulk control delete leaves a control with kept records in place (#5763).
 *
 * `deleteControl` refuses a control that still has test runs, test plans or
 * exceptions (#5083): they sit behind an ON DELETE RESTRICT key and are kept
 * as evidence, so a soft-deleted control holding them would park in the trash
 * until the 90-day purge failed on it. `bulkDeleteControl` soft-deleted the
 * same control anyway. This drives the real usecase against Postgres, through
 * the production client composition (soft-delete extension, RLS tenant
 * context), and reads the rows back with a raw client that sees deleted rows.
 *
 * The negative half is the second control in the same batch: it has nothing
 * holding it, and IS deleted — so the kept control is the check, not a batch
 * that silently did nothing.
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { bulkDeleteControl } from '@/app-layer/usecases/control';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

/** Raw client — no soft-delete extension, so deleted rows are visible. */
const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `cbdk-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let adminUserId = '';

jest.setTimeout(120_000);

async function makeControl(name: string): Promise<string> {
    const c = await globalPrisma.control.create({
        data: { tenantId: TENANT_ID, name: `${SUITE_TAG} ${name}` },
    });
    return c.id;
}

async function deletedAtOf(id: string): Promise<Date | null> {
    const rows = await globalPrisma.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
        `SELECT "deletedAt" FROM "Control" WHERE "id" = $1`,
        id,
    );
    if (rows.length === 0) throw new Error(`control ${id} is gone`);
    return rows[0].deletedAt;
}

function ctxAsAdmin() {
    return makeRequestContext(Role.ADMIN, {
        userId: adminUserId,
        tenantId: TENANT_ID,
        tenantSlug: SUITE_TAG,
    });
}

describeFn('bulkDeleteControl — a control with a test plan is kept (#5763)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.create({
            data: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        const email = `${SUITE_TAG}-admin@example.test`;
        const u = await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        adminUserId = u.id;
        await globalPrisma.tenantMembership.create({
            data: {
                tenantId: TENANT_ID,
                userId: adminUserId,
                role: Role.ADMIN,
                status: MembershipStatus.ACTIVE,
            },
        });
    });

    afterAll(async () => {
        // Raw, and test plans before controls: `controlId` is RESTRICT.
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "ControlTestPlan" WHERE "tenantId" = $1`,
            TENANT_ID,
        );
        await globalPrisma.$executeRawUnsafe(
            `DELETE FROM "Control" WHERE "tenantId" = $1`,
            TENANT_ID,
        );
        await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } });
        await deleteAuditRowsForTenants(globalPrisma, [TENANT_ID]);
        if (adminUserId) await globalPrisma.user.deleteMany({ where: { id: adminUserId } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('soft-deletes the free control, keeps the one with a test plan, and says why', async () => {
        const planned = await makeControl('has a test plan');
        const free = await makeControl('nothing holds it');
        await globalPrisma.controlTestPlan.create({
            data: {
                tenantId: TENANT_ID,
                controlId: planned,
                name: `${SUITE_TAG} quarterly review`,
                createdByUserId: adminUserId,
            },
        });

        const out = await bulkDeleteControl(ctxAsAdmin(), [planned, free]);

        expect(out.results).toEqual([
            {
                id: planned,
                status: 'blocked',
                reason: 'CONTROL_HAS_KEPT_RECORDS',
                blockedBy: ['ControlTestPlan'],
            },
            { id: free, status: 'ok' },
        ]);
        expect(out.deleted).toBe(1);

        // THE REGRESSION: before #5763 this control was soft-deleted.
        expect(await deletedAtOf(planned)).toBeNull();
        expect(await deletedAtOf(free)).not.toBeNull();

        // Its test plan is untouched.
        const plans = await globalPrisma.controlTestPlan.count({
            where: { controlId: planned, deletedAt: null },
        });
        expect(plans).toBe(1);

        // One SOFT_DELETE audit row, for the control that was deleted.
        const audited = await globalPrisma.auditLog.findMany({
            where: { tenantId: TENANT_ID, action: 'SOFT_DELETE', entity: 'Control' },
            select: { entityId: true },
        });
        expect(audited.map((a) => a.entityId)).toEqual([free]);
    });
});
