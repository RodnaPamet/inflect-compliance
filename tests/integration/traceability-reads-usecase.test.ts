/**
 * The traceability READS in `usecases/traceability.ts`, on real rows (#5376).
 *
 * Eight exported reads — the six `list*` panels and the risk/asset/control
 * `get*Traceability` views — had no behavioural test naming them. Two things
 * are pinned here:
 *
 *   1. TENANT ISOLATION. Each read filters the link table by `ctx.tenantId`
 *      under RLS, so another tenant's id comes back as EMPTY lists — not an
 *      error, and never the other tenant's rows.
 *
 *   2. THE GATE IS COARSE, AND THAT IS TODAY'S BEHAVIOUR, NOT AN ENDORSEMENT.
 *      Every one of these reads gates on `assertCanRead` alone. A custom role
 *      that withholds `risks.view` still reads a control's risks through
 *      `listControlRisks` / `getControlTraceability` / `listAssetRisks`, and one
 *      that withholds `assets.view` still reads a control's assets. The graph
 *      over the same links (`getTraceabilityGraph`) DOES honour the granular
 *      keys and drops those nodes for the same caller, so the two surfaces
 *      disagree. Whether these reads should honour the view keys is an owner
 *      question raised on #5376; this test records the current answer so a
 *      change to it is a visible, deliberate diff. When the owner decides,
 *      the "pinned" assertions below flip.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import {
    listControlRisks,
    listRiskControls,
    listAssetControls,
    listControlAssets,
    listAssetRisks,
    listRiskAssets,
    getControlTraceability,
    getRiskTraceability,
    getAssetTraceability,
} from '@/app-layer/usecases/traceability';
import { getTraceabilityGraph } from '@/app-layer/usecases/traceability-graph';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `trr-${randomUUID().slice(0, 8)}`;
const A = `a-${SUITE}`;
const B = `b-${SUITE}`;

const reader = makeRequestContext('READER', { tenantId: A, tenantSlug: A });
const otherTenant = makeRequestContext('ADMIN', { tenantId: B, tenantSlug: B });

/** A custom role on a READER base whose `permissionsJson` withholds some view keys. */
function customRole(mutate: (p: PermissionSet) => void): RequestContext {
    const appPermissions = structuredClone(getPermissionsForRole('READER'));
    mutate(appPermissions);
    return makeRequestContext('READER', { tenantId: A, tenantSlug: A, appPermissions });
}
const riskBlind = customRole((p) => {
    p.risks.view = false;
});
const assetBlind = customRole((p) => {
    p.assets.view = false;
});

let controlId = '';
let riskId = '';
let assetId = '';

describeFn('traceability reads (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        for (const t of [A, B]) await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
        controlId = (await prisma.control.create({ data: { tenantId: A, name: `${SUITE} control`, code: 'TR-1' } })).id;
        riskId = (await prisma.risk.create({ data: { tenantId: A, title: `${SUITE} risk`, score: 12, category: 'cat' } })).id;
        assetId = (await prisma.asset.create({ data: { tenantId: A, name: `${SUITE} asset`, type: 'SYSTEM', status: 'ACTIVE' } })).id;
        await prisma.riskControl.create({ data: { tenantId: A, riskId, controlId } });
        await prisma.controlAsset.create({ data: { tenantId: A, controlId, assetId } });
        await prisma.assetRiskLink.create({ data: { tenantId: A, assetId, riskId } });
        // Tenant B has its own linked rows, so "empty" below is isolation, not absence.
        const bc = await prisma.control.create({ data: { tenantId: B, name: 'B control' } });
        const br = await prisma.risk.create({ data: { tenantId: B, title: 'B risk', score: 3, category: 'cat' } });
        await prisma.riskControl.create({ data: { tenantId: B, riskId: br.id, controlId: bc.id } });
    });

    afterAll(async () => {
        // Audit rows first: `AuditLog` holds a foreign key to the tenant.
        await deleteAuditRowsForTenants(prisma, [A, B]);
        for (const t of [A, B]) {
            await prisma.riskControl.deleteMany({ where: { tenantId: t } });
            await prisma.controlAsset.deleteMany({ where: { tenantId: t } });
            await prisma.assetRiskLink.deleteMany({ where: { tenantId: t } });
            await prisma.control.deleteMany({ where: { tenantId: t } });
            await prisma.risk.deleteMany({ where: { tenantId: t } });
            await prisma.asset.deleteMany({ where: { tenantId: t } });
        }
        await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
        await prisma.$disconnect();
    });

    describe('a READER reads every panel and view of its own tenant', () => {
        it('the six list panels return the linked row', async () => {
            expect((await listControlRisks(reader, controlId)).map((l) => l.risk.id)).toEqual([riskId]);
            expect((await listRiskControls(reader, riskId)).map((l) => l.control.id)).toEqual([controlId]);
            expect((await listControlAssets(reader, controlId)).map((l) => l.asset.id)).toEqual([assetId]);
            expect((await listAssetControls(reader, assetId)).map((l) => l.control.id)).toEqual([controlId]);
            expect((await listAssetRisks(reader, assetId)).map((l) => l.risk.id)).toEqual([riskId]);
            expect((await listRiskAssets(reader, riskId)).map((l) => l.asset.id)).toEqual([assetId]);
        });

        it('the three views return both sides', async () => {
            const c = await getControlTraceability(reader, controlId);
            expect(c.controlId).toBe(controlId);
            expect(c.risks.map((l) => l.risk.id)).toEqual([riskId]);
            expect(c.assets.map((l) => l.asset.id)).toEqual([assetId]);

            const r = await getRiskTraceability(reader, riskId);
            expect(r.riskId).toBe(riskId);
            expect(r.controls.map((l) => l.control.id)).toEqual([controlId]);
            expect(r.assets.map((l) => l.asset.id)).toEqual([assetId]);
            expect(r.processMaps).toEqual([]);

            const a = await getAssetTraceability(reader, assetId);
            expect(a.assetId).toBe(assetId);
            expect(a.controls.map((l) => l.control.id)).toEqual([controlId]);
            expect(a.risks.map((l) => l.risk.id)).toEqual([riskId]);
            expect(a.processMaps).toEqual([]);
        });
    });

    describe('another tenant\'s id reads as empty, never as that tenant\'s rows', () => {
        it('every list panel', async () => {
            expect(await listControlRisks(otherTenant, controlId)).toEqual([]);
            expect(await listRiskControls(otherTenant, riskId)).toEqual([]);
            expect(await listControlAssets(otherTenant, controlId)).toEqual([]);
            expect(await listAssetControls(otherTenant, assetId)).toEqual([]);
            expect(await listAssetRisks(otherTenant, assetId)).toEqual([]);
            expect(await listRiskAssets(otherTenant, riskId)).toEqual([]);
        });

        it('every view', async () => {
            expect(await getControlTraceability(otherTenant, controlId)).toMatchObject({ risks: [], assets: [], processMaps: [] });
            expect(await getRiskTraceability(otherTenant, riskId)).toMatchObject({ controls: [], assets: [], processMaps: [] });
            expect(await getAssetTraceability(otherTenant, assetId)).toMatchObject({ controls: [], risks: [], processMaps: [] });
        });
    });

    describe('PINNED, today\'s behaviour: the reads gate on assertCanRead, not on the granular view keys', () => {
        it('a custom role without risks.view still reads a control\'s risks and an asset\'s risks', async () => {
            expect(riskBlind.appPermissions.risks.view).toBe(false);
            expect((await listControlRisks(riskBlind, controlId)).map((l) => l.risk.id)).toEqual([riskId]);
            expect((await listAssetRisks(riskBlind, assetId)).map((l) => l.risk.id)).toEqual([riskId]);
            expect((await getControlTraceability(riskBlind, controlId)).risks.map((l) => l.risk.title)).toEqual([`${SUITE} risk`]);
            // …and opens a risk's own traceability view.
            expect((await getRiskTraceability(riskBlind, riskId)).controls.map((l) => l.control.id)).toEqual([controlId]);
        });

        it('a custom role without assets.view still reads a control\'s assets and a risk\'s assets', async () => {
            expect(assetBlind.appPermissions.assets.view).toBe(false);
            expect((await listControlAssets(assetBlind, controlId)).map((l) => l.asset.id)).toEqual([assetId]);
            expect((await listRiskAssets(assetBlind, riskId)).map((l) => l.asset.id)).toEqual([assetId]);
            expect((await getAssetTraceability(assetBlind, assetId)).risks.map((l) => l.risk.id)).toEqual([riskId]);
        });

        it('…while the graph over the same links drops the risk for the same caller (the disagreement)', async () => {
            const graph = await getTraceabilityGraph(riskBlind);
            expect(graph.nodes.some((n) => n.kind === 'risk')).toBe(false);
            expect(graph.nodes.some((n) => n.kind === 'control')).toBe(true);
        });
    });
});
