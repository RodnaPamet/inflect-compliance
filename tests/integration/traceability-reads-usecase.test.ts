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
 *   2. EACH SIDE OF A LINK ANSWERS TO ITS OWN VIEW KEY (owner decision,
 *      2026-11-12). A read whose ANCHOR — the entity in the URL — the caller
 *      may not view is REFUSED with a 403; the linked entities of a kind the
 *      caller may not view are OMITTED, not errored. So a custom role that
 *      withholds `risks.view` no longer reads risk titles through a control's
 *      traceability panel, and the reads now agree with the graph over the same
 *      links (`getTraceabilityGraph`), which already dropped those nodes. Every
 *      built-in role holds all four view keys, so no built-in role moves.
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
    getPolicyTraceability,
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
const controlBlind = customRole((p) => {
    p.controls.view = false;
});
const policyBlind = customRole((p) => {
    p.policies.view = false;
});

const BUILT_IN_ROLES = ['OWNER', 'ADMIN', 'EDITOR', 'READER', 'AUDITOR', 'AI_ADMIN'] as const;

const refused = { status: 403 };

let controlId = '';
let riskId = '';
let assetId = '';
let policyId = '';

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
        policyId = (await prisma.policy.create({ data: { tenantId: A, slug: `${SUITE}-policy`, title: `${SUITE} policy` } })).id;
        await prisma.policyControlLink.create({ data: { tenantId: A, policyId, controlId } });
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
            await prisma.policyControlLink.deleteMany({ where: { tenantId: t } });
            await prisma.policy.deleteMany({ where: { tenantId: t } });
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

    describe('each side of a link answers to its own view key', () => {
        it('every built-in role holds all four view keys, and reads every side', async () => {
            for (const role of BUILT_IN_ROLES) {
                const ctx = makeRequestContext(role, { tenantId: A, tenantSlug: A });
                for (const domain of ['controls', 'risks', 'assets', 'policies'] as const) {
                    expect([role, domain, ctx.appPermissions[domain].view]).toEqual([role, domain, true]);
                }
                const c = await getControlTraceability(ctx, controlId);
                expect([role, c.risks.length, c.assets.length]).toEqual([role, 1, 1]);
                const r = await getRiskTraceability(ctx, riskId);
                expect([role, r.controls.length, r.assets.length]).toEqual([role, 1, 1]);
                const a = await getAssetTraceability(ctx, assetId);
                expect([role, a.controls.length, a.risks.length]).toEqual([role, 1, 1]);
                const p = await getPolicyTraceability(ctx, policyId);
                expect([role, p.controls.length, p.risks.length, p.assets.length]).toEqual([role, 1, 1, 1]);
            }
        });

        it('without risks.view, a control\'s and an asset\'s risks are omitted — no risk title leaks', async () => {
            expect(riskBlind.appPermissions.risks.view).toBe(false);
            expect(await listControlRisks(riskBlind, controlId)).toEqual([]);
            expect(await listAssetRisks(riskBlind, assetId)).toEqual([]);

            const c = await getControlTraceability(riskBlind, controlId);
            expect(c.risks).toEqual([]);
            expect(JSON.stringify(c)).not.toContain(`${SUITE} risk`);
            // The sides the caller MAY view are still there.
            expect(c.assets.map((l) => l.asset.id)).toEqual([assetId]);

            const a = await getAssetTraceability(riskBlind, assetId);
            expect(a.risks).toEqual([]);
            expect(a.controls.map((l) => l.control.id)).toEqual([controlId]);

            const p = await getPolicyTraceability(riskBlind, policyId);
            expect(p.risks).toEqual([]);
            expect(JSON.stringify(p)).not.toContain(`${SUITE} risk`);
            expect(p.controls.map((l) => l.control.id)).toEqual([controlId]);
            expect(p.assets.map((l) => l.asset.id)).toEqual([assetId]);
        });

        it('without risks.view, a read anchored on a risk is refused', async () => {
            await expect(getRiskTraceability(riskBlind, riskId)).rejects.toMatchObject(refused);
            await expect(listRiskControls(riskBlind, riskId)).rejects.toMatchObject(refused);
            await expect(listRiskAssets(riskBlind, riskId)).rejects.toMatchObject(refused);
        });

        it('without assets.view, assets are omitted and an asset-anchored read is refused', async () => {
            expect(assetBlind.appPermissions.assets.view).toBe(false);
            expect(await listControlAssets(assetBlind, controlId)).toEqual([]);
            expect(await listRiskAssets(assetBlind, riskId)).toEqual([]);
            expect((await getControlTraceability(assetBlind, controlId)).assets).toEqual([]);
            const r = await getRiskTraceability(assetBlind, riskId);
            expect(r.assets).toEqual([]);
            expect(r.controls.map((l) => l.control.id)).toEqual([controlId]);
            expect((await getPolicyTraceability(assetBlind, policyId)).assets).toEqual([]);

            await expect(getAssetTraceability(assetBlind, assetId)).rejects.toMatchObject(refused);
            await expect(listAssetControls(assetBlind, assetId)).rejects.toMatchObject(refused);
            await expect(listAssetRisks(assetBlind, assetId)).rejects.toMatchObject(refused);
        });

        it('without controls.view, controls are omitted and a control-anchored read is refused', async () => {
            expect(controlBlind.appPermissions.controls.view).toBe(false);
            expect(await listRiskControls(controlBlind, riskId)).toEqual([]);
            expect(await listAssetControls(controlBlind, assetId)).toEqual([]);
            const r = await getRiskTraceability(controlBlind, riskId);
            expect(r.controls).toEqual([]);
            expect(r.assets.map((l) => l.asset.id)).toEqual([assetId]);
            expect((await getAssetTraceability(controlBlind, assetId)).controls).toEqual([]);
            expect((await getPolicyTraceability(controlBlind, policyId)).controls).toEqual([]);

            await expect(getControlTraceability(controlBlind, controlId)).rejects.toMatchObject(refused);
            await expect(listControlRisks(controlBlind, controlId)).rejects.toMatchObject(refused);
            await expect(listControlAssets(controlBlind, controlId)).rejects.toMatchObject(refused);
        });

        it('without policies.view, a policy\'s traceability is refused', async () => {
            await expect(getPolicyTraceability(policyBlind, policyId)).rejects.toMatchObject(refused);
        });

        it('the reads now agree with the graph over the same links', async () => {
            const graph = await getTraceabilityGraph(riskBlind);
            expect(graph.nodes.some((n) => n.kind === 'risk')).toBe(false);
            expect(graph.nodes.some((n) => n.kind === 'control')).toBe(true);
            expect((await getControlTraceability(riskBlind, controlId)).risks).toEqual([]);
        });
    });
});
