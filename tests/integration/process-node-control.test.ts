/**
 * A `control` node links to its Control record through `ProcessNodeControl`,
 * end to end against the real schema: save, load, unlink, the cascades, the
 * legacy JSON link lifted on restore, the backfill migration's own SQL, the
 * live facts read, and the traceability reverse lookup.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import {
    createProcessMap,
    getProcessMap,
    listMapsUsingControl,
    restoreProcessMapSnapshot,
    saveProcessMap,
} from '@/app-layer/usecases/process-map';
import { getProcessMapControlFacts } from '@/app-layer/usecases/process-map-control-facts';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `pnc-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let USER_ID = '';

const MIGRATION_SQL = fs.readFileSync(
    path.resolve(__dirname, '../../prisma/migrations/20261119120000_process_node_control_link/migration.sql'),
    'utf8',
);
/** The migration's backfill statement, exactly as it shipped. */
const BACKFILL_SQL = MIGRATION_SQL.slice(MIGRATION_SQL.indexOf('INSERT INTO "ProcessNodeControl"'));

const step = (nodeKey: string, over: Record<string, unknown> = {}) => ({
    nodeKey, nodeType: 'processStep', label: nodeKey, subtitle: null, posX: 0, posY: 0,
    parentNodeKey: null, dataJson: null, ...over,
});
const controlNode = (nodeKey: string, controlId: string | null | undefined, dataJson: unknown = null) => ({
    ...step(nodeKey, { nodeType: 'control', dataJson }),
    ...(controlId === undefined ? {} : { controlId }),
});

function ctx() {
    return makeRequestContext('OWNER', { tenantId: TENANT_ID, userId: USER_ID, role: 'OWNER' });
}

async function newMap(name: string) {
    return createProcessMap(ctx(), { name: `${name} ${TAG}` } as never);
}

const linksOf = (mapId: string) =>
    globalPrisma.processNodeControl.findMany({
        where: { tenantId: TENANT_ID, processMapId: mapId },
        select: { controlId: true, node: { select: { nodeKey: true } } },
        orderBy: { createdAt: 'asc' },
    });

describeFn('a control node links to its Control record', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: TENANT_ID, slug: TENANT_ID } });
        USER_ID = (await globalPrisma.user.create({ data: { email: `${TAG}@example.test`, emailHash: TAG } })).id;
    });

    afterAll(async () => {
        if (USER_ID) {
            await globalPrisma.processMap.deleteMany({ where: { tenantId: TENANT_ID } });
            await globalPrisma.control.deleteMany({ where: { tenantId: TENANT_ID } });
            await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
            await globalPrisma.user.deleteMany({ where: { id: USER_ID } });
            await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        }
        await globalPrisma.$disconnect();
    });

    it('saves, loads, relinks and unlinks a control node, and survives an unchanged re-save', async () => {
        const a = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Access review', code: 'A.5.18' } });
        const b = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Change approval' } });
        const map = await newMap('roundtrip');

        let saved = await saveProcessMap(ctx(), map.id, { nodes: [controlNode('c1', a.id), step('s1')], edges: [] });
        expect(saved.nodes.find((n) => n.nodeKey === 'c1')?.controlId).toBe(a.id);
        expect(saved.nodes.find((n) => n.nodeKey === 's1')?.controlId).toBeNull();
        expect(await linksOf(map.id)).toEqual([{ controlId: a.id, node: { nodeKey: 'c1' } }]);

        // The same graph again (an autosave): one link, still a.
        saved = await saveProcessMap(ctx(), map.id, { nodes: [controlNode('c1', a.id), step('s1')], edges: [], expectedVersion: saved.version });
        expect(await linksOf(map.id)).toEqual([{ controlId: a.id, node: { nodeKey: 'c1' } }]);

        saved = await saveProcessMap(ctx(), map.id, { nodes: [controlNode('c1', b.id)], edges: [], expectedVersion: saved.version });
        expect((await getProcessMap(ctx(), map.id)).nodes[0].controlId).toBe(b.id);

        // Unlinked is a legal, saved state: a draft placeholder.
        await saveProcessMap(ctx(), map.id, { nodes: [controlNode('c1', null)], edges: [], expectedVersion: saved.version });
        expect(await linksOf(map.id)).toEqual([]);
        expect((await getProcessMap(ctx(), map.id)).nodes[0].controlId).toBeNull();
    });

    it('refuses a link on a node that is not a control node', async () => {
        const a = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Logging' } });
        const map = await newMap('wrongkind');
        await expect(
            saveProcessMap(ctx(), map.id, { nodes: [step('s1', { controlId: a.id })], edges: [] }),
        ).rejects.toThrow(/not a control node/);
    });

    it('a deleted node, or a hard-deleted control, takes its link with it', async () => {
        const keep = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Keep' } });
        const drop = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Drop' } });
        const map = await newMap('cascade');
        const saved = await saveProcessMap(ctx(), map.id, {
            nodes: [controlNode('c1', keep.id), controlNode('c2', drop.id)], edges: [],
        });
        await globalPrisma.control.delete({ where: { id: drop.id } });
        expect((await linksOf(map.id)).map((l) => l.controlId)).toEqual([keep.id]);

        await saveProcessMap(ctx(), map.id, { nodes: [controlNode('c2', null)], edges: [], expectedVersion: saved.version });
        expect(await linksOf(map.id)).toEqual([]);
    });

    it('restoring a version stored before the link existed lifts its legacy JSON link, and strips the JSON copy', async () => {
        const mine = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Legacy-linked' } });
        const map = await newMap('restore');
        const v2 = await saveProcessMap(ctx(), map.id, { nodes: [step('s1')], edges: [] });
        // A snapshot as a build before this change wrote it: the link only in
        // dataJson, no controlId at all, plus a dead id on a second node.
        await globalPrisma.processMapSnapshot.create({
            data: {
                tenantId: TENANT_ID, processMapId: map.id, version: 900, createdByUserId: USER_ID,
                graphJson: {
                    version: 900,
                    nodes: [
                        { ...step('c1', { nodeType: 'control' }), dataJson: { linkedEntityId: mine.id, size: 'lg' } },
                        { ...step('c2', { nodeType: 'control' }), dataJson: { linkedEntityId: 'ctl-never-existed' } },
                    ],
                    edges: [],
                },
            },
        });

        const restored = await restoreProcessMapSnapshot(ctx(), map.id, 900, v2.version);
        expect(await linksOf(map.id)).toEqual([{ controlId: mine.id, node: { nodeKey: 'c1' } }]);
        const c1 = restored.nodes.find((n) => n.nodeKey === 'c1');
        expect(c1?.controlId).toBe(mine.id);
        expect(c1?.dataJson).toEqual({ size: 'lg' });
        expect(restored.nodes.find((n) => n.nodeKey === 'c2')?.controlId).toBeNull();
    });

    it("the backfill migration copies a same-tenant JSON link and drops another tenant's or a dead one", async () => {
        const otherTenant = `${TENANT_ID}-other`;
        await globalPrisma.tenant.upsert({ where: { id: otherTenant }, update: {}, create: { id: otherTenant, name: otherTenant, slug: otherTenant } });
        try {
            const mine = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Backfilled' } });
            const theirs = await globalPrisma.control.create({ data: { tenantId: otherTenant, name: 'Not mine' } });
            const map = await newMap('backfill');
            // Rows exactly as the pre-link save path wrote them.
            await globalPrisma.processNode.createMany({
                data: [
                    { tenantId: TENANT_ID, processMapId: map.id, nodeKey: 'b1', nodeType: 'control', label: 'b1', posX: 0, posY: 0, dataJson: { linkedEntityId: mine.id } },
                    { tenantId: TENANT_ID, processMapId: map.id, nodeKey: 'b2', nodeType: 'control', label: 'b2', posX: 0, posY: 0, dataJson: { linkedEntityId: theirs.id } },
                    { tenantId: TENANT_ID, processMapId: map.id, nodeKey: 'b3', nodeType: 'control', label: 'b3', posX: 0, posY: 0, dataJson: { linkedEntityId: 'gone' } },
                    { tenantId: TENANT_ID, processMapId: map.id, nodeKey: 'b4', nodeType: 'risk', label: 'b4', posX: 0, posY: 0, dataJson: { linkedEntityId: mine.id } },
                ],
            });
            await globalPrisma.$executeRawUnsafe(BACKFILL_SQL);
            expect(await linksOf(map.id)).toEqual([{ controlId: mine.id, node: { nodeKey: 'b1' } }]);
            // Idempotent: a second run inserts nothing new.
            await globalPrisma.$executeRawUnsafe(BACKFILL_SQL);
            expect(await linksOf(map.id)).toHaveLength(1);
        } finally {
            await globalPrisma.control.deleteMany({ where: { tenantId: otherTenant } });
            await globalPrisma.tenant.deleteMany({ where: { id: otherTenant } });
        }
    });

    it('the facts read returns live facts for live controls and names the missing ones', async () => {
        const live = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, name: 'Encryption at rest', code: 'A.8.24', status: 'IMPLEMENTED', effectiveness: 80 },
        });
        const trashed = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Trashed', deletedAt: new Date() } });
        const map = await newMap('facts');

        const facts = await getProcessMapControlFacts(ctx(), map.id, [live.id, trashed.id, 'never-a-control']);
        expect(facts.restricted).toBe(false);
        expect(facts.controls[live.id]).toMatchObject({ code: 'A.8.24', name: 'Encryption at rest', status: 'IMPLEMENTED', effectiveness: 80, lastTested: null });
        expect(facts.missing.sort()).toEqual([trashed.id, 'never-a-control'].sort());

        // Renamed elsewhere: the next read says the new name. Nothing was copied.
        await globalPrisma.control.update({ where: { id: live.id }, data: { name: 'Encryption at rest (v2)' } });
        expect((await getProcessMapControlFacts(ctx(), map.id, [live.id])).controls[live.id].name).toBe('Encryption at rest (v2)');
    });

    it('the reverse lookup lists the map that places the control on a node', async () => {
        const c = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Segregation of duties' } });
        const map = await newMap('reverse');
        await saveProcessMap(ctx(), map.id, { nodes: [controlNode('gate', c.id)], edges: [] });
        const placements = await listMapsUsingControl(ctx(), c.id);
        expect(placements).toEqual([
            expect.objectContaining({ mapId: map.id, via: 'node', locationKey: 'gate', label: 'gate' }),
        ]);
    });
});
