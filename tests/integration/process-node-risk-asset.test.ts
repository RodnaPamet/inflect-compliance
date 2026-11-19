/**
 * `risk` and `asset` nodes link to their records through `ProcessNodeRisk` and
 * `ProcessNodeAsset`, end to end against the real schema: save and load, the
 * rule that a node carries only its own kind's link, the cascades, the legacy
 * JSON link lifted on restore, the migration's backfill SQL, the live facts
 * (the tenant's matrix band, the mitigation on this map, an overdue review),
 * and the reverse lookups.
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
    listMapsUsingAsset,
    listMapsUsingRisk,
    restoreProcessMapSnapshot,
    saveProcessMap,
} from '@/app-layer/usecases/process-map';
import {
    getProcessMapAssetFacts,
    getProcessMapRiskFacts,
} from '@/app-layer/usecases/process-map-risk-asset-facts';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `pnra-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let USER_ID = '';

const MIGRATION_SQL = fs.readFileSync(
    path.resolve(__dirname, '../../prisma/migrations/20261119180000_process_node_risk_asset_links/migration.sql'),
    'utf8',
);
/** The migration's two backfill statements, exactly as they shipped. */
const BACKFILL_SQL = MIGRATION_SQL.match(/INSERT INTO "ProcessNode(?:Risk|Asset)"[\s\S]*?ON CONFLICT DO NOTHING/g) ?? [];

const node = (nodeKey: string, nodeType: string, over: Record<string, unknown> = {}) => ({
    nodeKey, nodeType, label: nodeKey, subtitle: null, posX: 0, posY: 0,
    parentNodeKey: null, dataJson: null, ...over,
});

const ctx = () => makeRequestContext('OWNER', { tenantId: TENANT_ID, userId: USER_ID, role: 'OWNER' });
const newMap = async (name: string) => createProcessMap(ctx(), { name: `${name} ${TAG}` } as never);
const newRisk = (over: Record<string, unknown> = {}) =>
    globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: `Risk ${randomUUID().slice(0, 6)}`, ...over } as never });
const newAsset = (over: Record<string, unknown> = {}) =>
    globalPrisma.asset.create({ data: { tenantId: TENANT_ID, name: `Asset ${randomUUID().slice(0, 6)}`, type: 'SYSTEM', ...over } as never });

const riskLinks = (mapId: string) =>
    globalPrisma.processNodeRisk.findMany({
        where: { tenantId: TENANT_ID, processMapId: mapId },
        select: { riskId: true, node: { select: { nodeKey: true } } },
    });
const assetLinks = (mapId: string) =>
    globalPrisma.processNodeAsset.findMany({
        where: { tenantId: TENANT_ID, processMapId: mapId },
        select: { assetId: true, node: { select: { nodeKey: true } } },
    });

describeFn('risk and asset nodes link to their records', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: TENANT_ID, slug: TENANT_ID } });
        USER_ID = (await globalPrisma.user.create({ data: { email: `${TAG}@example.test`, emailHash: TAG } })).id;
    });

    afterAll(async () => {
        if (USER_ID) {
            await globalPrisma.processMap.deleteMany({ where: { tenantId: TENANT_ID } });
            await globalPrisma.riskControl.deleteMany({ where: { tenantId: TENANT_ID } });
            await globalPrisma.risk.deleteMany({ where: { tenantId: TENANT_ID } });
            await globalPrisma.asset.deleteMany({ where: { tenantId: TENANT_ID } });
            await globalPrisma.control.deleteMany({ where: { tenantId: TENANT_ID } });
            await globalPrisma.riskMatrixConfig.deleteMany({ where: { tenantId: TENANT_ID } });
            await deleteAuditRowsForTenants(globalPrisma, TENANT_ID);
            await globalPrisma.user.deleteMany({ where: { id: USER_ID } });
            await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        }
        await globalPrisma.$disconnect();
    });

    it('saves and loads each kind into its own table, and unlinks', async () => {
        const risk = await newRisk();
        const asset = await newAsset();
        const map = await newMap('roundtrip');
        let saved = await saveProcessMap(ctx(), map.id, {
            nodes: [node('r', 'risk', { riskId: risk.id }), node('a', 'asset', { assetId: asset.id })],
            edges: [],
        });
        expect(await riskLinks(map.id)).toEqual([{ riskId: risk.id, node: { nodeKey: 'r' } }]);
        expect(await assetLinks(map.id)).toEqual([{ assetId: asset.id, node: { nodeKey: 'a' } }]);
        const loaded = await getProcessMap(ctx(), map.id);
        expect(loaded.nodes.find((n) => n.nodeKey === 'r')).toMatchObject({ riskId: risk.id, controlId: null, assetId: null });
        expect(loaded.nodes.find((n) => n.nodeKey === 'a')).toMatchObject({ assetId: asset.id, riskId: null });

        saved = await saveProcessMap(ctx(), map.id, {
            nodes: [node('r', 'risk', { riskId: null }), node('a', 'asset', { assetId: null })],
            edges: [],
            expectedVersion: saved.version,
        });
        expect(await riskLinks(map.id)).toEqual([]);
        expect(await assetLinks(map.id)).toEqual([]);
    });

    it("refuses a node carrying another kind's link", async () => {
        const risk = await newRisk();
        const map = await newMap('wrongkind');
        await expect(
            saveProcessMap(ctx(), map.id, { nodes: [node('a', 'asset', { riskId: risk.id })], edges: [] }),
        ).rejects.toThrow(/not a risk node/);
    });

    it('a hard-deleted risk or asset takes its link with it', async () => {
        const risk = await newRisk();
        const asset = await newAsset();
        const map = await newMap('cascade');
        await saveProcessMap(ctx(), map.id, {
            nodes: [node('r', 'risk', { riskId: risk.id }), node('a', 'asset', { assetId: asset.id })],
            edges: [],
        });
        await globalPrisma.risk.delete({ where: { id: risk.id } });
        await globalPrisma.asset.delete({ where: { id: asset.id } });
        expect(await riskLinks(map.id)).toEqual([]);
        expect(await assetLinks(map.id)).toEqual([]);
    });

    it('restoring a version from before the links lifts the JSON link, keeping only live same-tenant records', async () => {
        const risk = await newRisk();
        const map = await newMap('restore');
        const v = await saveProcessMap(ctx(), map.id, { nodes: [node('s', 'processStep')], edges: [] });
        await globalPrisma.processMapSnapshot.create({
            data: {
                tenantId: TENANT_ID, processMapId: map.id, version: 900, createdByUserId: USER_ID,
                graphJson: {
                    version: 900,
                    nodes: [
                        node('r', 'risk', { dataJson: { linkedEntityId: risk.id } }),
                        node('a', 'asset', { dataJson: { linkedEntityId: 'asset-never-existed' } }),
                    ],
                    edges: [],
                },
            },
        });
        const restored = await restoreProcessMapSnapshot(ctx(), map.id, 900, v.version);
        expect(await riskLinks(map.id)).toEqual([{ riskId: risk.id, node: { nodeKey: 'r' } }]);
        expect(await assetLinks(map.id)).toEqual([]);
        expect(restored.nodes.find((n) => n.nodeKey === 'r')?.dataJson).toEqual({});
    });

    it('the backfill migration copies same-tenant JSON links and drops the rest', async () => {
        const other = `${TENANT_ID}-other`;
        await globalPrisma.tenant.upsert({ where: { id: other }, update: {}, create: { id: other, name: other, slug: other } });
        try {
            const risk = await newRisk();
            const asset = await newAsset();
            const theirs = await globalPrisma.risk.create({ data: { tenantId: other, title: 'Not mine' } as never });
            const map = await newMap('backfill');
            await globalPrisma.processNode.createMany({
                data: [
                    { tenantId: TENANT_ID, processMapId: map.id, nodeKey: 'b1', nodeType: 'risk', label: 'b1', posX: 0, posY: 0, dataJson: { linkedEntityId: risk.id } },
                    { tenantId: TENANT_ID, processMapId: map.id, nodeKey: 'b2', nodeType: 'risk', label: 'b2', posX: 0, posY: 0, dataJson: { linkedEntityId: theirs.id } },
                    { tenantId: TENANT_ID, processMapId: map.id, nodeKey: 'b3', nodeType: 'asset', label: 'b3', posX: 0, posY: 0, dataJson: { linkedEntityId: asset.id } },
                    { tenantId: TENANT_ID, processMapId: map.id, nodeKey: 'b4', nodeType: 'control', label: 'b4', posX: 0, posY: 0, dataJson: { linkedEntityId: asset.id } },
                ],
            });
            expect(BACKFILL_SQL).toHaveLength(2);
            for (const sql of BACKFILL_SQL) await globalPrisma.$executeRawUnsafe(sql);
            expect(await riskLinks(map.id)).toEqual([{ riskId: risk.id, node: { nodeKey: 'b1' } }]);
            expect(await assetLinks(map.id)).toEqual([{ assetId: asset.id, node: { nodeKey: 'b3' } }]);
            // Idempotent.
            for (const sql of BACKFILL_SQL) await globalPrisma.$executeRawUnsafe(sql);
            expect(await riskLinks(map.id)).toHaveLength(1);
        } finally {
            await globalPrisma.risk.deleteMany({ where: { tenantId: other } });
            await globalPrisma.tenant.deleteMany({ where: { id: other } });
        }
    });

    it("risk facts: the tenant's band on residual-else-inherent, the mitigation on this map, and an overdue review", async () => {
        await globalPrisma.riskMatrixConfig.create({
            data: {
                tenantId: TENANT_ID,
                likelihoodLevels: 5,
                impactLevels: 5,
                bands: [
                    { name: 'Calm', minScore: 1, maxScore: 10, color: '#00aa00' },
                    { name: 'Storm', minScore: 11, maxScore: 25, color: '#aa0000' },
                ],
            },
        });
        const onMapControl = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'On the map' } });
        const offMapControl = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Elsewhere' } });
        const residual = await newRisk({
            key: 'R-1', inherentScore: 20, score: 20, residualScore: 8, status: 'MITIGATING', treatment: 'TREAT',
            nextReviewAt: new Date('2020-01-01T00:00:00Z'),
        });
        const inherentOnly = await newRisk({ inherentScore: 15, score: 15 });
        await globalPrisma.riskControl.createMany({
            data: [
                { tenantId: TENANT_ID, riskId: residual.id, controlId: onMapControl.id },
                { tenantId: TENANT_ID, riskId: residual.id, controlId: offMapControl.id },
            ],
        });
        const map = await newMap('facts');
        await saveProcessMap(ctx(), map.id, {
            nodes: [
                node('r1', 'risk', { riskId: residual.id }),
                node('r2', 'risk', { riskId: inherentOnly.id }),
                node('c', 'control', { controlId: onMapControl.id }),
            ],
            edges: [],
        });

        const facts = await getProcessMapRiskFacts(ctx(), map.id, [residual.id, inherentOnly.id, 'nope']);
        expect(facts.risks[residual.id]).toMatchObject({
            key: 'R-1', score: 8, scoreKind: 'RESIDUAL', inherentScore: 20,
            status: 'MITIGATING', treatment: 'TREAT', reviewOverdue: true,
            mitigation: { onMap: 1, total: 2 },
        });
        expect(facts.risks[inherentOnly.id]).toMatchObject({
            score: 15, scoreKind: 'INHERENT', mitigation: { onMap: 0, total: 0 }, reviewOverdue: false,
        });
        // The tenant's own bands, not the fixed-threshold levels: 8 is 'Calm'
        // (residual leads), 15 is 'Storm' (inherent, no residual).
        expect(facts.risks[residual.id].band).toEqual({ name: 'Calm', color: '#00aa00' });
        expect(facts.risks[inherentOnly.id].band).toEqual({ name: 'Storm', color: '#aa0000' });
        expect(facts.missing).toEqual(['nope']);
    });

    it('asset facts read live, and a trashed asset is missing', async () => {
        const live = await newAsset({ key: 'A-1', name: 'Payroll DB', type: 'DATA_STORE', criticality: 'HIGH' });
        const trashed = await newAsset({ deletedAt: new Date() });
        const map = await newMap('asset-facts');
        const facts = await getProcessMapAssetFacts(ctx(), map.id, [live.id, trashed.id]);
        expect(facts.assets[live.id]).toMatchObject({ key: 'A-1', name: 'Payroll DB', type: 'DATA_STORE', criticality: 'HIGH', status: 'ACTIVE' });
        expect(facts.missing).toEqual([trashed.id]);
    });

    it('the reverse lookups list the maps that place the record on a node', async () => {
        const risk = await newRisk();
        const asset = await newAsset();
        const map = await newMap('reverse');
        await saveProcessMap(ctx(), map.id, {
            nodes: [node('rr', 'risk', { riskId: risk.id }), node('aa', 'asset', { assetId: asset.id })],
            edges: [],
        });
        expect(await listMapsUsingRisk(ctx(), risk.id)).toEqual([
            expect.objectContaining({ mapId: map.id, nodeKey: 'rr' }),
        ]);
        expect(await listMapsUsingAsset(ctx(), asset.id)).toEqual([
            expect.objectContaining({ mapId: map.id, nodeKey: 'aa' }),
        ]);
    });
});
