/**
 * #5105 — a map gated by a control the tenant later deleted can still be saved.
 *
 * Control is soft-deleted, so its gate row on the edge survives, the canvas
 * sends it back on every save, and the ownership check read only live controls
 * and refused the save as naming a "foreign" control. A control from ANOTHER
 * tenant is still refused.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { ProcessMapRepository } from '@/app-layer/repositories/ProcessMapRepository';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `gate-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const OTHER_TENANT_ID = `t-${TAG}-other`;
let USER_ID = '';

const node = (nodeKey: string) => ({
    nodeKey, nodeType: 'processStep', label: nodeKey, subtitle: null, posX: 0, posY: 0, parentNodeKey: null, dataJson: null,
});
const graphGatedBy = (controlId: string) => ({
    nodes: [node('a'), node('b')],
    edges: [
        {
            edgeKey: 'e1', sourceKey: 'a', targetKey: 'b', edgeKind: 'flow', labelOverride: null, dataJson: null,
            controls: [{ controlKey: 'g1', label: 'Gate', controlId, dataJson: null }],
        },
    ],
});

describeFn('an edge gated by a soft-deleted control (#5105)', () => {
    beforeAll(async () => {
        for (const id of [TENANT_ID, OTHER_TENANT_ID]) {
            await globalPrisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
        }
        USER_ID = (await globalPrisma.user.create({ data: { email: `${TAG}@example.test`, emailHash: TAG } })).id;
    });

    afterAll(async () => {
        if (USER_ID) {
            await globalPrisma.processMap.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
            await globalPrisma.control.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
            await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
            await deleteAuditRowsForTenants(globalPrisma, OTHER_TENANT_ID);
            await globalPrisma.user.deleteMany({ where: { id: USER_ID } });
            await globalPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
        }
        await globalPrisma.$disconnect();
    });

    it('saves again after the gating control is deleted, and still refuses another tenant\'s control', async () => {
        const ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, userId: USER_ID, role: 'OWNER' });
        const control = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Change approval' } });
        const foreign = await globalPrisma.control.create({ data: { tenantId: OTHER_TENANT_ID, name: 'Not yours' } });
        const map = await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.create(db, ctx, { name: `gate ${TAG}`, description: null, createdByUserId: USER_ID }),
        );
        await runInTenantContext(ctx, (db) => ProcessMapRepository.replaceGraph(db, ctx, map.id, graphGatedBy(control.id)));

        await globalPrisma.control.update({ where: { id: control.id }, data: { deletedAt: new Date() } });

        await expect(
            runInTenantContext(ctx, (db) => ProcessMapRepository.replaceGraph(db, ctx, map.id, graphGatedBy(control.id))),
        ).resolves.toBeDefined();
        await expect(
            runInTenantContext(ctx, (db) => ProcessMapRepository.replaceGraph(db, ctx, map.id, graphGatedBy(foreign.id))),
        ).rejects.toThrow(/do not belong to this tenant/);
    });
});
