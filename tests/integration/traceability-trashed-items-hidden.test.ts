/**
 * Every traceability list hides a link whose far side is in the trash (#5442,
 * owner decision 2026-11-12; #5376 did the risk page's controls).
 *
 * Risk, Control and Asset are all in `SOFT_DELETE_MODELS`. A soft delete keeps
 * the join row, and the soft-delete extension filters top-level reads only —
 * never a relation filter or a nested include — so each read below listed the
 * trashed item until it carried the predicate itself:
 *
 *   - `ControlRiskRepository.listByControl`    a control's risks
 *   - `AssetControlRepository.listByAsset`     an asset's controls
 *   - `AssetControlRepository.listByControl`   a control's assets
 *   - `AssetRiskRepository.listByAsset`        an asset's risks
 *   - `AssetRiskRepository.listByRisk`         a risk's assets
 *   - the policy view's controls and the risks and assets inherited through them
 *   - the asset detail read's controls, its Risks / Controls counts, and the
 *     asset list's Controls count
 *   - the risk list's Asset column (first asset and its count)
 *
 * Each list's anchor has one LIVE and one TRASHED item on the far side, and the
 * trashed link is created first, so an ordering accident cannot pass the test.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    listControlRisks,
    listAssetControls,
    listControlAssets,
    listAssetRisks,
    listRiskAssets,
    getControlTraceability,
    getRiskTraceability,
    getAssetTraceability,
    getPolicyTraceability,
    coverageSummary,
} from '@/app-layer/usecases/traceability';
import { getAsset, listAssets, listAssetsPaginated } from '@/app-layer/usecases/asset';
import { listRisks, listRisksPaginated } from '@/app-layer/usecases/risk';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `tti-${randomUUID().slice(0, 8)}`;
const A = `a-${SUITE}`;
const ctx = makeRequestContext('READER', { tenantId: A, tenantSlug: A });

// Anchors (live) and far-side items (one live, one trashed, per kind).
const id = { control: '', risk: '', asset: '', policy: '', liveControl: '', trashedControl: '', liveRisk: '', trashedRisk: '', liveAsset: '', trashedAsset: '', onlyViaTrashed: '' };

describeFn('traceability lists hide items in the trash (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: A, name: A, slug: A } });
        const control = (name: string) => prisma.control.create({ data: { tenantId: A, name: `${SUITE} ${name}` } }).then((r) => r.id);
        const risk = (title: string) => prisma.risk.create({ data: { tenantId: A, title: `${SUITE} ${title}`, score: 6, category: 'cat' } }).then((r) => r.id);
        const asset = (name: string) => prisma.asset.create({ data: { tenantId: A, name: `${SUITE} ${name}`, type: 'SYSTEM', status: 'ACTIVE' } }).then((r) => r.id);

        id.control = await control('anchor control');
        id.risk = await risk('anchor risk');
        id.asset = await asset('anchor asset');
        id.liveControl = await control('live control');
        id.trashedControl = await control('trashed control');
        id.liveRisk = await risk('live risk');
        id.trashedRisk = await risk('trashed risk');
        id.onlyViaTrashed = await risk('risk reached only through the trashed control');
        id.liveAsset = await asset('live asset');
        id.trashedAsset = await asset('trashed asset');
        id.policy = (await prisma.policy.create({ data: { tenantId: A, slug: `${SUITE}-policy`, title: `${SUITE} policy` } })).id;

        // Trashed links first, every time.
        for (const riskId of [id.trashedRisk, id.liveRisk]) await prisma.riskControl.create({ data: { tenantId: A, controlId: id.control, riskId } });
        for (const assetId of [id.trashedAsset, id.liveAsset]) await prisma.controlAsset.create({ data: { tenantId: A, controlId: id.control, assetId } });
        for (const controlId of [id.trashedControl, id.liveControl]) await prisma.controlAsset.create({ data: { tenantId: A, controlId, assetId: id.asset } });
        for (const riskId of [id.trashedRisk, id.liveRisk]) await prisma.assetRiskLink.create({ data: { tenantId: A, assetId: id.asset, riskId } });
        for (const assetId of [id.trashedAsset, id.liveAsset]) await prisma.assetRiskLink.create({ data: { tenantId: A, assetId, riskId: id.risk } });
        for (const controlId of [id.trashedControl, id.control]) await prisma.policyControlLink.create({ data: { tenantId: A, policyId: id.policy, controlId } });
        await prisma.riskControl.create({ data: { tenantId: A, controlId: id.trashedControl, riskId: id.onlyViaTrashed } });

        // The soft delete leaves every join row in place — only the reads can hide it.
        const now = new Date();
        await prisma.control.update({ where: { id: id.trashedControl }, data: { deletedAt: now } });
        await prisma.risk.update({ where: { id: id.trashedRisk }, data: { deletedAt: now } });
        await prisma.asset.update({ where: { id: id.trashedAsset }, data: { deletedAt: now } });
    });

    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, [A]);
        await prisma.riskControl.deleteMany({ where: { tenantId: A } });
        await prisma.controlAsset.deleteMany({ where: { tenantId: A } });
        await prisma.assetRiskLink.deleteMany({ where: { tenantId: A } });
        await prisma.policyControlLink.deleteMany({ where: { tenantId: A } });
        await prisma.policy.deleteMany({ where: { tenantId: A } });
        await prisma.control.deleteMany({ where: { tenantId: A } });
        await prisma.risk.deleteMany({ where: { tenantId: A } });
        await prisma.asset.deleteMany({ where: { tenantId: A } });
        await prisma.tenant.deleteMany({ where: { id: A } });
        await prisma.$disconnect();
    });

    it("a control's risks (ControlRiskRepository.listByControl)", async () => {
        expect((await listControlRisks(ctx, id.control)).map((l) => l.risk.id)).toEqual([id.liveRisk]);
        expect((await getControlTraceability(ctx, id.control)).risks.map((l) => l.risk.id)).toEqual([id.liveRisk]);
    });

    it("a control's assets (AssetControlRepository.listByControl)", async () => {
        expect((await listControlAssets(ctx, id.control)).map((l) => l.asset.id)).toEqual([id.liveAsset]);
        expect((await getControlTraceability(ctx, id.control)).assets.map((l) => l.asset.id)).toEqual([id.liveAsset]);
    });

    it("an asset's controls (AssetControlRepository.listByAsset)", async () => {
        expect((await listAssetControls(ctx, id.asset)).map((l) => l.control.id)).toEqual([id.liveControl]);
        expect((await getAssetTraceability(ctx, id.asset)).controls.map((l) => l.control.id)).toEqual([id.liveControl]);
    });

    it("an asset's risks (AssetRiskRepository.listByAsset)", async () => {
        expect((await listAssetRisks(ctx, id.asset)).map((l) => l.risk.id)).toEqual([id.liveRisk]);
        expect((await getAssetTraceability(ctx, id.asset)).risks.map((l) => l.risk.id)).toEqual([id.liveRisk]);
    });

    it("a risk's assets (AssetRiskRepository.listByRisk)", async () => {
        expect((await listRiskAssets(ctx, id.risk)).map((l) => l.asset.id)).toEqual([id.liveAsset]);
        expect((await getRiskTraceability(ctx, id.risk)).assets.map((l) => l.asset.id)).toEqual([id.liveAsset]);
    });

    it("a policy's controls, and what it inherits through them", async () => {
        const p = await getPolicyTraceability(ctx, id.policy);
        expect(p.controls.map((l) => l.control.id)).toEqual([id.control]);
        // A trashed control is no path: the risk reached only through it is gone.
        expect(p.risks.map((r) => r.id)).toEqual([id.liveRisk]);
        expect(p.assets.map((a) => a.id)).toEqual([id.liveAsset]);
    });

    it("the asset page's controls and counts, and the asset list's Controls count", async () => {
        const asset = await getAsset(ctx, id.asset);
        expect(asset.controls.map((l) => l.controlId)).toEqual([id.liveControl]);
        // The page's Risks and Controls counts.
        expect(asset.rollups.risks.count).toBe(1);
        expect(asset.rollups.controls.count).toBe(1);

        const row = (await listAssets(ctx)).find((a) => a.id === id.asset);
        expect(row?._count.controls).toBe(1);
        const page = await listAssetsPaginated(ctx, { limit: 50 });
        const paged = (page.items as Array<{ id: string; _count: { controls: number } }>).find((a) => a.id === id.asset);
        expect(paged?._count.controls).toBe(1);
    });

    it("the risk list's Asset column", async () => {
        const row = (await listRisks(ctx)).find((r) => r.id === id.risk);
        expect(row?.assetLinks.map((l) => l.asset.id)).toEqual([id.liveAsset]);
        expect(row?._count.assetLinks).toBe(1);

        const page = await listRisksPaginated(ctx, { limit: 50 });
        const paged = (page.items as unknown as Array<{ id: string; assetLinks: Array<{ asset: { id: string } }>; _count: { assetLinks: number } }>)
            .find((r) => r.id === id.risk);
        expect(paged?.assetLinks.map((l) => l.asset.id)).toEqual([id.liveAsset]);
        expect(paged?._count.assetLinks).toBe(1);
    });

    // A trashed control mitigates nothing: a risk whose only control is in the
    // trash is UNMAPPED on the coverage dashboard, and the trashed control is
    // never ranked among the hot controls (where it came back with a count and
    // no name).
    it('the coverage dashboard counts no link to an item in the trash', async () => {
        const summary = await coverageSummary(ctx);
        expect(summary.unmappedRisks.map((r) => r.id)).toContain(id.onlyViaTrashed);
        const hotIds = summary.hotControls.map((h) => (h as { id?: string }).id);
        expect(hotIds).not.toContain(id.trashedControl);
        expect(summary.hotControls.every((h) => typeof (h as { name?: string }).name === 'string')).toBe(true);
    });
});
