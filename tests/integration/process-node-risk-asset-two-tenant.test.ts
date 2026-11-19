/**
 * `ProcessNodeRisk` and `ProcessNodeAsset` under two tenants: tenant B cannot
 * link, read, look up or learn anything about tenant A's risk- and asset-node
 * links, through the real usecases and with RLS live (`runInTenantContext`
 * binds B's tenant).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import {
    createProcessMap,
    listMapsUsingAsset,
    listMapsUsingRisk,
    saveProcessMap,
} from '@/app-layer/usecases/process-map';
import {
    getProcessMapAssetFacts,
    getProcessMapRiskFacts,
} from '@/app-layer/usecases/process-map-risk-asset-facts';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `pnra2t-${randomUUID().slice(0, 8)}`;
const A = `t-${TAG}-a`;
const B = `t-${TAG}-b`;
let USER_A = '';
let USER_B = '';

const ctxOf = (tenantId: string, userId: string) =>
    makeRequestContext('OWNER', { tenantId, userId, role: 'OWNER' });
const node = (nodeKey: string, nodeType: string, link: Record<string, string | null>) => ({
    nodeKey, nodeType, label: nodeKey, subtitle: null, posX: 0, posY: 0,
    parentNodeKey: null, dataJson: null, ...link,
});

describeFn('ProcessNodeRisk / ProcessNodeAsset — tenant isolation', () => {
    let riskA = '';
    let assetA = '';
    let mapA = '';
    let mapB = '';

    beforeAll(async () => {
        for (const id of [A, B]) {
            await globalPrisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
        }
        USER_A = (await globalPrisma.user.create({ data: { email: `${TAG}-a@example.test`, emailHash: `${TAG}-a` } })).id;
        USER_B = (await globalPrisma.user.create({ data: { email: `${TAG}-b@example.test`, emailHash: `${TAG}-b` } })).id;
        riskA = (await globalPrisma.risk.create({ data: { tenantId: A, title: 'A secret risk' } as never })).id;
        assetA = (await globalPrisma.asset.create({ data: { tenantId: A, name: 'A secret asset', type: 'SYSTEM' } as never })).id;
        mapA = (await createProcessMap(ctxOf(A, USER_A), { name: `A ${TAG}` } as never)).id;
        mapB = (await createProcessMap(ctxOf(B, USER_B), { name: `B ${TAG}` } as never)).id;
        await saveProcessMap(ctxOf(A, USER_A), mapA, {
            nodes: [node('r', 'risk', { riskId: riskA }), node('a', 'asset', { assetId: assetA })],
            edges: [],
        });
    });

    afterAll(async () => {
        if (USER_A) {
            await globalPrisma.processMap.deleteMany({ where: { tenantId: { in: [A, B] } } });
            await globalPrisma.risk.deleteMany({ where: { tenantId: { in: [A, B] } } });
            await globalPrisma.asset.deleteMany({ where: { tenantId: { in: [A, B] } } });
            await deleteAuditRowsForTenants(globalPrisma, A);
            await deleteAuditRowsForTenants(globalPrisma, B);
            await globalPrisma.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
            await globalPrisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
        }
        await globalPrisma.$disconnect();
    });

    it("tenant A's links exist (positive control)", async () => {
        const [risks, assets] = await runInTenantContext(ctxOf(A, USER_A), (db) =>
            Promise.all([
                db.processNodeRisk.findMany({ where: { processMapId: mapA }, select: { riskId: true } }),
                db.processNodeAsset.findMany({ where: { processMapId: mapA }, select: { assetId: true } }),
            ]),
        );
        expect(risks).toEqual([{ riskId: riskA }]);
        expect(assets).toEqual([{ assetId: assetA }]);
    });

    it.each([
        ['risk', () => ({ riskId: riskA })],
        ['asset', () => ({ assetId: assetA })],
    ])("B cannot link a %s node to A's record: the whole save is refused", async (kind, link) => {
        await expect(
            saveProcessMap(ctxOf(B, USER_B), mapB, { nodes: [node('x', kind, link())], edges: [] }),
        ).rejects.toThrow(/do not belong to this tenant/);
        expect(await globalPrisma.processNodeRisk.count({ where: { tenantId: B } })).toBe(0);
        expect(await globalPrisma.processNodeAsset.count({ where: { tenantId: B } })).toBe(0);
    });

    it("B's RLS-bound reads see none of A's link rows, even naming A's map", async () => {
        const [risks, assets] = await runInTenantContext(ctxOf(B, USER_B), (db) =>
            Promise.all([
                db.processNodeRisk.findMany({ where: { processMapId: mapA } }),
                db.processNodeAsset.findMany({ where: { processMapId: mapA } }),
            ]),
        );
        expect(risks).toEqual([]);
        expect(assets).toEqual([]);
    });

    it("B's facts reads on its own map learn nothing about A's records", async () => {
        const risks = await getProcessMapRiskFacts(ctxOf(B, USER_B), mapB, [riskA]);
        expect(risks.risks).toEqual({});
        expect(risks.missing).toEqual([riskA]);
        const assets = await getProcessMapAssetFacts(ctxOf(B, USER_B), mapB, [assetA]);
        expect(assets.assets).toEqual({});
        expect(assets.missing).toEqual([assetA]);
    });

    it("B cannot read facts through A's map", async () => {
        await expect(getProcessMapRiskFacts(ctxOf(B, USER_B), mapA, [riskA])).rejects.toThrow(/not found/i);
        await expect(getProcessMapAssetFacts(ctxOf(B, USER_B), mapA, [assetA])).rejects.toThrow(/not found/i);
    });

    it("B's reverse lookups of A's records find no placement", async () => {
        expect(await listMapsUsingRisk(ctxOf(B, USER_B), riskA)).toEqual([]);
        expect(await listMapsUsingAsset(ctxOf(B, USER_B), assetA)).toEqual([]);
    });
});
