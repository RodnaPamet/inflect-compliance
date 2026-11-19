/**
 * `ProcessNodeControl` under two tenants: tenant B cannot link, read, look up
 * or learn anything about tenant A's control-node links, through the real
 * usecases and with RLS live (`runInTenantContext` binds B's tenant).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { createProcessMap, listMapsUsingControl, saveProcessMap } from '@/app-layer/usecases/process-map';
import { getProcessMapControlFacts } from '@/app-layer/usecases/process-map-control-facts';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `pnc2t-${randomUUID().slice(0, 8)}`;
const A = `t-${TAG}-a`;
const B = `t-${TAG}-b`;
let USER_A = '';
let USER_B = '';

const ctxOf = (tenantId: string, userId: string) =>
    makeRequestContext('OWNER', { tenantId, userId, role: 'OWNER' });
const controlNode = (nodeKey: string, controlId: string | null) => ({
    nodeKey, nodeType: 'control', label: nodeKey, subtitle: null, posX: 0, posY: 0,
    parentNodeKey: null, dataJson: null, controlId,
});

describeFn('ProcessNodeControl — tenant isolation', () => {
    let controlA = '';
    let mapA = '';
    let mapB = '';

    beforeAll(async () => {
        for (const id of [A, B]) {
            await globalPrisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
        }
        USER_A = (await globalPrisma.user.create({ data: { email: `${TAG}-a@example.test`, emailHash: `${TAG}-a` } })).id;
        USER_B = (await globalPrisma.user.create({ data: { email: `${TAG}-b@example.test`, emailHash: `${TAG}-b` } })).id;

        controlA = (await globalPrisma.control.create({ data: { tenantId: A, name: 'A secret control', code: 'A-1' } })).id;
        mapA = (await createProcessMap(ctxOf(A, USER_A), { name: `A ${TAG}` } as never)).id;
        mapB = (await createProcessMap(ctxOf(B, USER_B), { name: `B ${TAG}` } as never)).id;
        await saveProcessMap(ctxOf(A, USER_A), mapA, { nodes: [controlNode('gate', controlA)], edges: [] });
    });

    afterAll(async () => {
        if (USER_A) {
            await globalPrisma.processMap.deleteMany({ where: { tenantId: { in: [A, B] } } });
            await globalPrisma.control.deleteMany({ where: { tenantId: { in: [A, B] } } });
            await deleteAuditRowsForTenants(globalPrisma, A);
            await deleteAuditRowsForTenants(globalPrisma, B);
            await globalPrisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
            await globalPrisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
        }
        await globalPrisma.$disconnect();
    });

    it("tenant A's link exists (positive control)", async () => {
        const rows = await runInTenantContext(ctxOf(A, USER_A), (db) =>
            db.processNodeControl.findMany({ where: { processMapId: mapA }, select: { controlId: true } }),
        );
        expect(rows).toEqual([{ controlId: controlA }]);
    });

    it("B cannot link a node to A's control: the whole save is refused and nothing is written", async () => {
        await expect(
            saveProcessMap(ctxOf(B, USER_B), mapB, { nodes: [controlNode('gate', controlA)], edges: [] }),
        ).rejects.toThrow(/do not belong to this tenant/);
        expect(await globalPrisma.processNodeControl.count({ where: { tenantId: B } })).toBe(0);
    });

    it("B's RLS-bound read sees none of A's link rows, even naming A's map", async () => {
        const rows = await runInTenantContext(ctxOf(B, USER_B), (db) =>
            db.processNodeControl.findMany({ where: { processMapId: mapA } }),
        );
        expect(rows).toEqual([]);
    });

    it("B's facts read on its own map learns nothing about A's control", async () => {
        const facts = await getProcessMapControlFacts(ctxOf(B, USER_B), mapB, [controlA]);
        expect(facts.controls).toEqual({});
        expect(facts.missing).toEqual([controlA]);
    });

    it("B cannot read facts through A's map", async () => {
        await expect(getProcessMapControlFacts(ctxOf(B, USER_B), mapA, [controlA])).rejects.toThrow(/not found/i);
    });

    it("B's reverse lookup of A's control finds no placement", async () => {
        expect(await listMapsUsingControl(ctxOf(B, USER_B), controlA)).toEqual([]);
    });
});
