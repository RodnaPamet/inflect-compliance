/**
 * RQ-5 — hierarchy CRUD + aggregation (DB-backed). Unique constraint,
 * cascade delete, and a real recursive roll-up over linked risks.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createNode, deleteNode, linkRisk, aggregateByHierarchy, getTreemapData } from '@/app-layer/usecases/risk-hierarchy';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `hier-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let adminId = '';
let r1 = ''; let r2 = '';
let ctx: ReturnType<typeof makeRequestContext>;

describeFn('RQ-5 — hierarchy CRUD + aggregation (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        const email = `${TAG}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        adminId = u.id;
        await globalPrisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: adminId, role: Role.ADMIN, status: MembershipStatus.ACTIVE } });
        ctx = makeRequestContext('ADMIN', { userId: adminId, tenantId: TENANT_ID, tenantSlug: TAG });
        r1 = (await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'R1', fairAle: 100_000 } })).id;
        r2 = (await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'R2', sleAmount: 50_000, aroAmount: 1 } })).id;
    });

    afterAll(async () => {
        const t = { tenantId: TENANT_ID };
        for (const m of ['riskHierarchyLink', 'riskHierarchyNode', 'risk', 'tenantMembership'] as const) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try { await (globalPrisma as any)[m].deleteMany({ where: t }); } catch { /* best effort */ }
        }
        try { await globalPrisma.user.deleteMany({ where: { id: adminId } }); } catch { /* best effort */ }
        try { await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await globalPrisma.$disconnect();
    });

    it('rejects a duplicate (tenantId, type, name) node', async () => {
        await createNode(ctx, { name: 'Engineering', type: 'BUSINESS_UNIT' });
        await expect(createNode(ctx, { name: 'Engineering', type: 'BUSINESS_UNIT' })).rejects.toThrow();
    });

    it('aggregates ALE recursively across a parent and its children (deduped)', async () => {
        const parent = await createNode(ctx, { name: 'Eng', type: 'GEOGRAPHY' });
        const child = await createNode(ctx, { name: 'Platform', type: 'GEOGRAPHY', parentId: parent.id });
        await linkRisk(ctx, r1, child.id);   // 100k under child
        await linkRisk(ctx, r2, parent.id);  // 50k directly on parent
        await linkRisk(ctx, r1, parent.id);  // r1 also direct on parent → must dedup

        const agg = await aggregateByHierarchy(ctx, parent.id);
        expect(agg.totalAle).toBe(150_000); // 100k + 50k, r1 once
        expect(agg.riskCount).toBe(2);
        expect(agg.children.find((c) => c.nodeId === child.id)!.totalAle).toBe(100_000);

        const treemap = await getTreemapData(ctx, 'GEOGRAPHY');
        expect(treemap.find((n) => n.nodeId === parent.id)!.totalAle).toBe(150_000);
    });

    it('deleting a node cascades to its RiskHierarchyLink rows', async () => {
        const node = await createNode(ctx, { name: 'Temp', type: 'ASSET_CLASS' });
        await linkRisk(ctx, r1, node.id);
        expect(await globalPrisma.riskHierarchyLink.count({ where: { nodeId: node.id } })).toBe(1);
        await deleteNode(ctx, node.id);
        expect(await globalPrisma.riskHierarchyLink.count({ where: { nodeId: node.id } })).toBe(0);
    });
});
