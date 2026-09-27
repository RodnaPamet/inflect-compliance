/**
 * Does a BIA's link to a process node survive saving the map?
 *
 * WHY THIS IS AN INTEGRATION TEST AND NOT A UNIT ONE. The mechanism is a
 * FOREIGN KEY ACTION — `BusinessImpactAnalysis_processNodeId_tenantId_fkey` is
 * declared `ON DELETE SET NULL ("processNodeId")`. No amount of reading the
 * TypeScript shows what Postgres does when `replaceGraph` deletes the node
 * rows; only a real database does.
 *
 * The derivation that prompted it:
 *   1. `replaceGraph` deletes EVERY ProcessNode for the map on every save and
 *      recreates them with `createMany`, supplying no `id` — so each save mints
 *      new cuids.
 *   2. `BusinessImpactAnalysis.processNodeId` references `ProcessNode.id`, the
 *      cuid, not `nodeKey`.
 *   3. The FK is ON DELETE SET NULL.
 *   4. Nothing in `replaceGraph` or `usecases/process-map.ts` mentions BIA, and
 *      `processNodeId` is written only where a BIA is created.
 *
 * If that chain holds, saving a map silently orphans every BIA attached to one
 * of its nodes. This test decides it either way.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { ProcessMapRepository } from '@/app-layer/repositories/ProcessMapRepository';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `bia-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;
let USER_ID = '';

const NODE = {
    nodeKey: 'node-1',
    nodeType: 'processStep',
    label: 'Payroll run',
    subtitle: null,
    posX: 10,
    posY: 20,
    parentNodeKey: null,
    dataJson: null,
};

describeFn('a BIA linked to a process node, across a save of that map', () => {
    let mapId = '';

    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        const u = await globalPrisma.user.create({
            data: { email: `${SUITE_TAG}@example.test`, emailHash: SUITE_TAG },
        });
        USER_ID = u.id;
    });

    afterAll(async () => {
        await globalPrisma.businessImpactAnalysis.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.processMap.deleteMany({ where: { tenantId: TENANT_ID } });
        await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
        await globalPrisma.user.deleteMany({ where: { id: USER_ID } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('keeps its processNodeId when the map is saved again', async () => {
        const ctx = makeRequestContext('OWNER', {
            tenantId: TENANT_ID,
            userId: USER_ID,
            role: 'OWNER',
        });

        const map = await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.create(db, ctx, {
                name: `BIA map ${randomUUID().slice(0, 6)}`,
                description: null,
                createdByUserId: USER_ID,
            }),
        );
        mapId = map.id;

        // First save puts one node on the map.
        await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.replaceGraph(db, ctx, mapId, { nodes: [NODE], edges: [] }),
        );

        const node = await globalPrisma.processNode.findFirstOrThrow({
            where: { processMapId: mapId, tenantId: TENANT_ID, nodeKey: NODE.nodeKey },
        });

        // A BIA attached to that node — the shape NewBiaModal creates when a
        // user adds a BIA from the canvas.
        const bia = await globalPrisma.businessImpactAnalysis.create({
            data: {
                tenantId: TENANT_ID,
                name: 'Payroll BIA',
                criticality: 'HIGH',
                processNodeId: node.id,
            },
        });
        expect(bia.processNodeId).toBe(node.id);

        // THE SAVE. Identical graph, no user edit — the most innocuous save
        // there is, and the one autosave performs constantly.
        await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.replaceGraph(db, ctx, mapId, { nodes: [NODE], edges: [] }),
        );

        const after = await globalPrisma.businessImpactAnalysis.findUniqueOrThrow({
            where: { id: bia.id },
        });
        const nodeAfter = await globalPrisma.processNode.findFirstOrThrow({
            where: { processMapId: mapId, tenantId: TENANT_ID, nodeKey: NODE.nodeKey },
        });

        // Diagnostic first: whichever way this goes, the numbers say why.
        expect({
            nodeIdChanged: nodeAfter.id !== node.id,
            biaStillLinked: after.processNodeId !== null,
            biaPointsAtCurrentNode: after.processNodeId === nodeAfter.id,
        }).toEqual({
            nodeIdChanged: false,
            biaStillLinked: true,
            biaPointsAtCurrentNode: true,
        });
    });

    it('a node REMOVED from the payload is still deleted — the other half of the scoped delete', async () => {
        // The fix narrowed the delete to `nodeKey notIn <payload>`. Get that
        // predicate wrong in the permissive direction and nodes accumulate
        // forever with nothing failing: the map keeps rendering, the row count
        // climbs, and deletions silently stop working. This is the assertion
        // that would notice.
        const ctx = makeRequestContext('OWNER', {
            tenantId: TENANT_ID,
            userId: USER_ID,
            role: 'OWNER',
        });
        const map = await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.create(db, ctx, {
                name: `remove ${randomUUID().slice(0, 6)}`,
                description: null,
                createdByUserId: USER_ID,
            }),
        );

        const second = { ...NODE, nodeKey: 'node-2', label: 'Second' };
        await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.replaceGraph(db, ctx, map.id, {
                nodes: [NODE, second],
                edges: [],
            }),
        );
        expect(
            await globalPrisma.processNode.count({
                where: { processMapId: map.id, tenantId: TENANT_ID },
            }),
        ).toBe(2);

        // Save without node-2.
        await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.replaceGraph(db, ctx, map.id, { nodes: [NODE], edges: [] }),
        );

        const remaining = await globalPrisma.processNode.findMany({
            where: { processMapId: map.id, tenantId: TENANT_ID },
        });
        expect(remaining.map((n) => n.nodeKey)).toEqual(['node-1']);
    });

    it('an EMPTY payload clears the map — the case `notIn: []` would not cover', async () => {
        // `notIn: []` excludes nothing, so it matches every row and would be
        // correct here by accident. The implementation drops the predicate
        // entirely when the payload is empty rather than relying on that, and
        // this pins the behaviour either way.
        const ctx = makeRequestContext('OWNER', {
            tenantId: TENANT_ID,
            userId: USER_ID,
            role: 'OWNER',
        });
        const map = await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.create(db, ctx, {
                name: `clear ${randomUUID().slice(0, 6)}`,
                description: null,
                createdByUserId: USER_ID,
            }),
        );
        await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.replaceGraph(db, ctx, map.id, { nodes: [NODE], edges: [] }),
        );
        await runInTenantContext(ctx, (db) =>
            ProcessMapRepository.replaceGraph(db, ctx, map.id, { nodes: [], edges: [] }),
        );
        expect(
            await globalPrisma.processNode.count({
                where: { processMapId: map.id, tenantId: TENANT_ID },
            }),
        ).toBe(0);
    });
});
