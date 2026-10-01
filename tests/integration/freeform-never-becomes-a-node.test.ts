/**
 * A drawing is not a process step.
 *
 * ═══ THE CLAIM ═══
 *
 * #2960 lets people use the canvas renderer's own tools — sticky notes,
 * freehand, loose text — alongside the typed process graph. Those shapes are
 * stored in `ProcessMap.freeformJson`, an opaque column, and the load-bearing
 * property is what does NOT happen to them: **a sticky note never becomes a
 * `ProcessNode` row.**
 *
 * That matters because `ProcessNode` is not a rendering detail. Coverage
 * queries it, traceability walks it, automation rules attach to it, and edges
 * link it to controls. A sticky note that reached those rows would appear in a
 * compliance report as a process step, be linkable to a control, and consume
 * the 500-node ceiling — and it would look entirely normal doing so.
 *
 * ═══ WHY THIS IS AN INTEGRATION TEST ═══
 *
 * The separation is a property of what the repository WRITES, not of what the
 * types allow. `freeformJson` is `unknown` on the way in and Json in the
 * database, so no type error stands between a well-meaning refactor and a
 * projection into nodes. Only a real write, followed by counting the rows,
 * decides it.
 *
 * ═══ THE MARKER, AND WHY IT IS SEARCHED FOR TWICE ═══
 *
 * Every assertion about "the marker is not in the node rows" is worthless if
 * the marker was never stored at all — a save that dropped the freeform blob
 * on the floor would satisfy it perfectly. So the suite asserts BOTH
 * directions: the marker is absent from every node row, AND present in
 * `freeformJson`. The second is the positive control for the first.
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

const SUITE_TAG = `ff-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;
let USER_ID = '';

/** Distinctive enough that finding it anywhere is meaningful. */
const MARKER = 'STICKY-NOT-A-NODE-7f3a91';

/** A plausible renderer blob: two sticky notes and a freehand stroke. */
const FREEFORM = {
    schemaVersion: 1,
    shapes: [
        { id: 'shape:note-1', type: 'note', x: 40, y: 40, props: { text: MARKER } },
        { id: 'shape:note-2', type: 'note', x: 90, y: 40, props: { text: 'second note' } },
        { id: 'shape:draw-1', type: 'draw', points: [[0, 0], [4, 9], [11, 2]] },
    ],
};

const NODES = [
    {
        nodeKey: 'n1',
        nodeType: 'processStep',
        label: 'Receive invoice',
        subtitle: null,
        posX: 0,
        posY: 0,
        parentNodeKey: null,
        dataJson: null,
    },
    {
        nodeKey: 'n2',
        nodeType: 'decision',
        label: 'Over threshold?',
        subtitle: null,
        posX: 200,
        posY: 0,
        parentNodeKey: null,
        dataJson: null,
    },
];

const ctx = () =>
    makeRequestContext('OWNER', { tenantId: TENANT_ID, userId: USER_ID, role: 'OWNER' });

/** Every node row of a map, serialised whole so no field escapes the search. */
async function nodeRowsAsText(mapId: string): Promise<string> {
    const rows = await globalPrisma.processNode.findMany({
        where: { processMapId: mapId, tenantId: TENANT_ID },
    });
    return JSON.stringify(rows);
}

describeFn('freeform shapes never become process nodes', () => {
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

        const c = ctx();
        const map = await runInTenantContext(c, (db) =>
            ProcessMapRepository.create(db, c, {
                name: `freeform map ${randomUUID().slice(0, 6)}`,
                description: null,
                createdByUserId: USER_ID,
            }),
        );
        mapId = map.id;
    });

    afterAll(async () => {
        await globalPrisma.processMapSnapshot.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.processMap.deleteMany({ where: { tenantId: TENANT_ID } });
        await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
        await globalPrisma.user.deleteMany({ where: { id: USER_ID } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('a save carrying freeform writes the typed nodes and NOTHING else', async () => {
        const c = ctx();
        await runInTenantContext(c, (db) =>
            ProcessMapRepository.replaceGraph(db, c, mapId, {
                nodes: NODES,
                edges: [],
                freeformJson: FREEFORM,
            }),
        );

        // THREE sticky/draw shapes went in alongside TWO typed nodes. If any
        // of them were projected, this count would be 3, 4 or 5.
        const count = await globalPrisma.processNode.count({
            where: { processMapId: mapId, tenantId: TENANT_ID },
        });
        expect(count).toBe(NODES.length);

        // And not merely the right COUNT — the right rows. A projection that
        // replaced a typed node rather than adding one would hold the count.
        const keys = (
            await globalPrisma.processNode.findMany({
                where: { processMapId: mapId, tenantId: TENANT_ID },
                select: { nodeKey: true },
                orderBy: { nodeKey: 'asc' },
            })
        ).map((r) => r.nodeKey);
        expect(keys).toEqual(['n1', 'n2']);
    });

    it('the marker appears in freeformJson and in NO node row', async () => {
        // Both directions, and the first is the positive control: without it,
        // a save that silently discarded the freeform blob would pass the
        // second assertion perfectly.
        const stored = await globalPrisma.processMap.findUniqueOrThrow({
            where: { id: mapId },
            select: { freeformJson: true },
        });
        expect(JSON.stringify(stored.freeformJson)).toContain(MARKER);

        expect(await nodeRowsAsText(mapId)).not.toContain(MARKER);
    });

    it('round-trips the blob byte-for-byte through the read path', async () => {
        const c = ctx();
        const read = await runInTenantContext(c, (db) =>
            ProcessMapRepository.getByIdWithGraph(db, c, mapId),
        );
        expect(read?.freeformJson).toEqual(FREEFORM);
    });

    it('a save that OMITS freeformJson leaves the stored layer alone', async () => {
        // The three-state contract. Every client that predates #2960 omits
        // this field, so if omission cleared it, one save from an old tab
        // would erase every sticky note on the map.
        const c = ctx();
        await runInTenantContext(c, (db) =>
            ProcessMapRepository.replaceGraph(db, c, mapId, { nodes: NODES, edges: [] }),
        );
        const after = await globalPrisma.processMap.findUniqueOrThrow({
            where: { id: mapId },
            select: { freeformJson: true },
        });
        expect(after.freeformJson).toEqual(FREEFORM);
    });

    it('an explicit null CLEARS it — the other half of the contract', async () => {
        const c = ctx();
        await runInTenantContext(c, (db) =>
            ProcessMapRepository.replaceGraph(db, c, mapId, {
                nodes: NODES,
                edges: [],
                freeformJson: null,
            }),
        );
        const after = await globalPrisma.processMap.findUniqueOrThrow({
            where: { id: mapId },
            select: { freeformJson: true },
        });
        expect(after.freeformJson).toBeNull();
    });

    it('a snapshot carries the freeform layer, so a restore is not data loss', async () => {
        const c = ctx();
        // Put it back, then read the snapshot that save produced.
        await runInTenantContext(c, (db) =>
            ProcessMapRepository.replaceGraph(db, c, mapId, {
                nodes: NODES,
                edges: [],
                freeformJson: FREEFORM,
            }),
        );
        const latest = await globalPrisma.processMapSnapshot.findFirst({
            where: { processMapId: mapId, tenantId: TENANT_ID },
            orderBy: { version: 'desc' },
        });
        expect(latest).not.toBeNull();
        // A snapshot that omitted this would restore a map with every sticky
        // note gone, and report success while doing it.
        expect(JSON.stringify(latest?.graphJson)).toContain(MARKER);
    });

    it('a save that OMITS freeform still snapshots the stored layer, not null', async () => {
        // The subtle half of the snapshot rule. An old client saves, omitting
        // freeform; the stored layer is correctly left alone — but if the
        // SNAPSHOT recorded what the request sent rather than what the map now
        // holds, that version would archive as empty and restoring to it would
        // erase the notes.
        const c = ctx();
        await runInTenantContext(c, (db) =>
            ProcessMapRepository.replaceGraph(db, c, mapId, { nodes: NODES, edges: [] }),
        );
        const latest = await globalPrisma.processMapSnapshot.findFirst({
            where: { processMapId: mapId, tenantId: TENANT_ID },
            orderBy: { version: 'desc' },
        });
        expect(JSON.stringify(latest?.graphJson)).toContain(MARKER);
    });
});
