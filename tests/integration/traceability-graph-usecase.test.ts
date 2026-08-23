/**
 * Integration coverage for `src/app-layer/usecases/traceability-graph.ts`.
 *
 * DB-backed: seeds Controls/Risks/Assets + the three link tables, then
 * runs the usecase through runInTenantContext (prisma singleton).
 *
 * Branches:
 *   - no viewable kind at all → forbidden.
 *   - per-kind permission skipping (2026-08-24): a custom role without
 *     `<domain>.view` loses that kind's nodes AND every edge touching them,
 *     while the other kinds still render.
 *   - no kinds filter → all three node kinds fetched + every link.
 *   - kinds filter excluding a kind → that kind's findMany short-circuits
 *     to [] (the Promise.resolve arm).
 *   - link assembly tags mitigates/protects/exposes.
 *   - nodeCap override path.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole, type PermissionSet } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';
import { getTraceabilityGraph } from '@/app-layer/usecases/traceability-graph';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `tg-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE });

/** The five `PermissionSet` domains the graph reads. */
const GRAPH_DOMAINS = ['controls', 'risks', 'assets', 'frameworks', 'policies'] as const;

/**
 * A `TenantCustomRole`-shaped context: a real base role whose
 * `permissionsJson` zeroes some flags. That is the only population this gate
 * can refuse — every built-in role carries `view: true` on all five.
 */
function customRole(mutate: (p: PermissionSet) => void): RequestContext {
    const appPermissions = structuredClone(getPermissionsForRole('READER'));
    mutate(appPermissions);
    return makeRequestContext('READER', {
        tenantId: TENANT,
        tenantSlug: SUITE,
        appPermissions,
    });
}

let controlId: string;
let riskId: string;
let assetId: string;

describeFn('getTraceabilityGraph (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: SUITE, slug: SUITE } });
        const control = await prisma.control.create({ data: { tenantId: TENANT, name: 'Ctrl', code: 'C-1' } });
        controlId = control.id;
        const risk = await prisma.risk.create({ data: { tenantId: TENANT, title: 'Risk', score: 12, category: 'cat' } });
        riskId = risk.id;
        const asset = await prisma.asset.create({ data: { tenantId: TENANT, name: 'Asset', type: 'SYSTEM', status: 'ACTIVE' } });
        assetId = asset.id;
        await prisma.riskControl.create({ data: { tenantId: TENANT, riskId, controlId } });
        await prisma.controlAsset.create({ data: { tenantId: TENANT, controlId, assetId } });
        await prisma.assetRiskLink.create({ data: { tenantId: TENANT, assetId, riskId } });
    });

    afterAll(async () => {
        await prisma.riskControl.deleteMany({ where: { tenantId: TENANT } });
        await prisma.controlAsset.deleteMany({ where: { tenantId: TENANT } });
        await prisma.assetRiskLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.control.deleteMany({ where: { tenantId: TENANT } });
        await prisma.risk.deleteMany({ where: { tenantId: TENANT } });
        await prisma.asset.deleteMany({ where: { tenantId: TENANT } });
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    it('throws forbidden when the caller can view none of the graph kinds', async () => {
        // Replaces an `if (!ctx.role)` assertion. That branch was unreachable
        // — `getTenantCtx` always populates the role — so the old test proved
        // only that a context no caller produces was refused. This one has a
        // populated role and is refused on the permissions.
        const blind = customRole((p) => {
            for (const domain of GRAPH_DOMAINS) p[domain].view = false;
        });
        expect(blind.role).toBeTruthy();
        await expect(getTraceabilityGraph(blind)).rejects.toThrow(
            /permission to view any entities in the traceability graph/i,
        );
    });

    it('a READER — the least-privileged built-in role — still gets the full graph', async () => {
        // The load-bearing positive companion. A READER reaches every one of
        // these rows through the list pages already; a gate that refused them
        // here would be a regression dressed as a fix.
        const reader = makeRequestContext('READER', { tenantId: TENANT, tenantSlug: SUITE });
        const graph = await getTraceabilityGraph(reader);
        const kinds = new Set(graph.nodes.map((n) => n.kind));
        expect(kinds.has('control')).toBe(true);
        expect(kinds.has('risk')).toBe(true);
        expect(kinds.has('asset')).toBe(true);
        expect(new Set(graph.edges.map((e) => e.relation)).has('mitigates')).toBe(true);
    });

    it('drops a denied kind, its edges and its category — other kinds survive', async () => {
        const noRisks = customRole((p) => {
            p.risks.view = false;
        });
        const graph = await getTraceabilityGraph(noRisks);
        const kinds = new Set(graph.nodes.map((n) => n.kind));

        expect(kinds.has('risk')).toBe(false);
        // Edges are filtered to surviving endpoints, so both relations that
        // touch a risk go with it.
        const relations = new Set(graph.edges.map((e) => e.relation));
        expect(relations.has('mitigates')).toBe(false);
        expect(relations.has('exposes')).toBe(false);
        // `categories` counts come from the final node list, so the legend
        // does not advertise a kind the payload withheld.
        expect(graph.categories.map((c) => c.kind)).not.toContain('risk');

        // Skipping, not refusing: control + asset and the edge between them
        // are all still there.
        expect(kinds.has('control')).toBe(true);
        expect(kinds.has('asset')).toBe(true);
        expect(relations.has('protects')).toBe(true);
    });

    it('builds a full graph (all kinds + every link relation) by default', async () => {
        const graph = await getTraceabilityGraph(ctx);
        const kinds = new Set(graph.nodes.map((n) => n.kind));
        expect(kinds.has('control')).toBe(true);
        expect(kinds.has('risk')).toBe(true);
        expect(kinds.has('asset')).toBe(true);
        const relations = new Set(graph.edges.map((e) => e.relation));
        expect(relations.has('mitigates')).toBe(true);
        expect(relations.has('protects')).toBe(true);
        expect(relations.has('exposes')).toBe(true);
    });

    it('short-circuits excluded kinds when a kinds filter is supplied', async () => {
        const graph = await getTraceabilityGraph(ctx, { filters: { kinds: ['control'] } });
        const kinds = new Set(graph.nodes.map((n) => n.kind));
        expect(kinds.has('control')).toBe(true);
        // risk + asset nodes excluded — their findMany resolved to [].
        expect(kinds.has('risk')).toBe(false);
        expect(kinds.has('asset')).toBe(false);
    });

    it('honours a nodeCap override without error', async () => {
        const graph = await getTraceabilityGraph(ctx, { nodeCap: 1 });
        expect(graph.nodes.length).toBeGreaterThanOrEqual(1);
    });
});
