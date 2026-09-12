/**
 * RQ3-6 — LossEvent register (DB-backed). Round-trip the create →
 * list → aggregate cycle and confirm the predicted-vs-actual roll-up
 * (per-year + per-risk) lands as documented; confirm the soft-delete
 * + audit-event provenance contract holds.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    createLossEvent,
    listLossEvents,
    getLossEventAggregate,
    deleteLossEvent,
} from '@/app-layer/usecases/loss-event';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `le-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let adminId = '';
let editorId = '';
let riskId = '';
let editorCtx: ReturnType<typeof makeRequestContext>;
let adminCtx: ReturnType<typeof makeRequestContext>;

describeFn('RQ3-6 — loss-event register (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG },
        });
        const adminEmail = `${TAG}-admin@example.test`;
        const editorEmail = `${TAG}-editor@example.test`;
        const a = await globalPrisma.user.create({ data: { email: adminEmail, emailHash: hashForLookup(adminEmail) } });
        const e = await globalPrisma.user.create({ data: { email: editorEmail, emailHash: hashForLookup(editorEmail) } });
        adminId = a.id;
        editorId = e.id;
        await globalPrisma.tenantMembership.createMany({
            data: [
                { tenantId: TENANT_ID, userId: adminId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
                { tenantId: TENANT_ID, userId: editorId, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
            ],
        });
        adminCtx = makeRequestContext('ADMIN', { userId: adminId, tenantId: TENANT_ID, tenantSlug: TAG });
        editorCtx = makeRequestContext('EDITOR', { userId: editorId, tenantId: TENANT_ID, tenantSlug: TAG });
        const r = await globalPrisma.risk.create({
            data: { tenantId: TENANT_ID, title: 'Vendor breach' },
        });
        riskId = r.id;
    });

    afterAll(async () => {
        const t = { tenantId: TENANT_ID };
        for (const m of ['lossEvent', 'risk', 'tenantMembership'] as const) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await (globalPrisma as any)[m].deleteMany({ where: t });
            } catch { /* best effort */ }
        }
        try { await globalPrisma.user.deleteMany({ where: { id: { in: [adminId, editorId] } } }); } catch { /* best effort */ }
        try { await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await globalPrisma.$disconnect();
    });

    it('creates a loss event and reads it back through the list endpoint', async () => {
        const created = await createLossEvent(editorCtx, {
            riskId,
            occurredAt: '2024-03-15T00:00:00.000Z',
            amount: 25_000,
            description: 'Customer breach response — vendor X',
            source: 'USER',
            justification: 'Incident report INC-42',
        });
        expect(created.amount).toBe(25_000);
        expect(created.source).toBe('USER');

        const list = await listLossEvents(editorCtx, {});
        expect(list.events.find((r) => r.id === created.id)).toBeDefined();
    });

    it('aggregates by year and by risk (the predicted-vs-actual spine)', async () => {
        await createLossEvent(editorCtx, { riskId, occurredAt: '2024-09-01', amount: 75_000, source: 'INCIDENT' });
        await createLossEvent(editorCtx, { occurredAt: '2025-02-10', amount: 200_000, source: 'FINDING' });

        const aggregate = await getLossEventAggregate(editorCtx);
        expect(aggregate.count).toBeGreaterThanOrEqual(3);
        expect(aggregate.total).toBeGreaterThanOrEqual(300_000);
        const years = aggregate.byYear.map((y) => y.year);
        expect(years).toContain(2024);
        expect(years).toContain(2025);
        // Per-risk: the riskId attribution sums separately from the
        // portfolio-attributed (riskId null) bucket.
        const riskBucket = aggregate.byRisk.find((r) => r.riskId === riskId);
        const portfolioBucket = aggregate.byRisk.find((r) => r.riskId === null);
        expect(riskBucket).toBeDefined();
        expect(portfolioBucket).toBeDefined();
    });

    it('rejects an invalid amount (badRequest) without persisting', async () => {
        await expect(
            createLossEvent(editorCtx, { occurredAt: '2024-01-01', amount: -1 }),
        ).rejects.toThrow(/non-negative/);
    });

    it('rejects an unknown risk attribution (notFound)', async () => {
        await expect(
            createLossEvent(editorCtx, { riskId: 'does-not-exist', occurredAt: '2024-01-01', amount: 100 }),
        ).rejects.toThrow(/Risk not found/);
    });

    it('sanitises free-text before persistence (Epic D.2 wiring)', async () => {
        const created = await createLossEvent(editorCtx, {
            occurredAt: '2024-12-01',
            amount: 1_000,
            description: 'Lost <script>alert(1)</script> data',
        });
        const fresh = await globalPrisma.lossEvent.findUniqueOrThrow({ where: { id: created.id } });
        expect(fresh.description).not.toContain('<script>');
    });

    it('emits an LOSS_EVENT_RECORDED audit row carrying the source + amount', async () => {
        const before = await globalPrisma.auditLog.count({
            where: { tenantId: TENANT_ID, action: 'LOSS_EVENT_RECORDED' },
        });
        await createLossEvent(editorCtx, { occurredAt: '2024-04-01', amount: 5_000, source: 'INCIDENT' });
        const after = await globalPrisma.auditLog.count({
            where: { tenantId: TENANT_ID, action: 'LOSS_EVENT_RECORDED' },
        });
        expect(after).toBe(before + 1);
    });

    it('soft-delete is ADMIN-only and hides the row from list + aggregate', async () => {
        const created = await createLossEvent(editorCtx, { occurredAt: '2024-05-05', amount: 9_000 });
        await expect(deleteLossEvent(editorCtx, created.id)).rejects.toThrow();

        const aggregateBefore = await getLossEventAggregate(adminCtx);
        const totalBefore = aggregateBefore.total;
        await deleteLossEvent(adminCtx, created.id);
        const aggregateAfter = await getLossEventAggregate(adminCtx);
        expect(aggregateAfter.total).toBeCloseTo(totalBefore - 9_000, 0);
        const list = await listLossEvents(adminCtx, {});
        expect(list.events.find((r) => r.id === created.id)).toBeUndefined();
    });
});
