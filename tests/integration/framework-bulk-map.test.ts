/**
 * bulkMapControls with a mapping that already exists (#5264), against a real
 * database. The defect only shows here: it caught each unique violation
 * INSIDE an interactive transaction, and Postgres aborts a transaction at the
 * first failed statement, so every later insert and the audit row failed with
 * "current transaction is aborted". One existing mapping failed the batch.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { bulkMapControls } from '@/app-layer/usecases/framework/install';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `bm-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const FW_KEY = `BULKMAP_${SUITE}`;
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE, userId: `u-${SUITE}` });

describeFn('bulkMapControls (real DB)', () => {
    let frameworkId: string | undefined;
    let controlId: string;
    let r1: string;
    let r2: string;

    beforeAll(async () => {
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: SUITE, slug: SUITE } });
        const email = `${SUITE}@example.test`;
        await prisma.user.upsert({ where: { id: ctx.userId }, update: {}, create: { id: ctx.userId, email, emailHash: hashForLookup(email) } });
        const fw = await prisma.framework.create({ data: { key: FW_KEY, name: 'Bulk map test', version: '1' } });
        frameworkId = fw.id;
        r1 = (await prisma.frameworkRequirement.create({ data: { frameworkId: fw.id, code: 'R-1', title: 'One' } })).id;
        r2 = (await prisma.frameworkRequirement.create({ data: { frameworkId: fw.id, code: 'R-2', title: 'Two' } })).id;
        controlId = (await prisma.control.create({ data: { tenantId: TENANT, name: 'C', code: 'C-1' } })).id;
        await prisma.controlRequirementLink.create({ data: { tenantId: TENANT, controlId, requirementId: r1 } });
    });

    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, TENANT);
        await prisma.controlRequirementLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.control.deleteMany({ where: { tenantId: TENANT } });
        if (frameworkId) {
            await prisma.frameworkRequirement.deleteMany({ where: { frameworkId } });
            await prisma.framework.deleteMany({ where: { id: frameworkId } });
        }
        await prisma.$disconnect();
    });

    it('maps the new pair, counts the existing one, and commits', async () => {
        const result = await bulkMapControls(ctx, FW_KEY, [{ controlId, requirementIds: [r1, r2] }]);

        expect(result).toEqual({ frameworkKey: FW_KEY, created: 1, existing: 1, total: 2 });
        const linked = await prisma.controlRequirementLink.findMany({ where: { tenantId: TENANT, controlId }, select: { requirementId: true } });
        expect(linked.map((l) => l.requirementId).sort()).toEqual([r1, r2].sort());
    });
});
