/**
 * RQ-7 — bow-tie projection (DB-backed): real Risk + RiskControl + Control
 * read, barrier classification by mitigationType, tenant isolation.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { projectBowTie } from '@/app-layer/usecases/bowtie-projection';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `bt-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let adminId = '';
let riskId = '';
let bareRiskId = '';
let ctx: ReturnType<typeof makeRequestContext>;

describeFn('RQ-7 — bow-tie projection (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        const email = `${TAG}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        adminId = u.id;
        await globalPrisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: adminId, role: Role.ADMIN, status: MembershipStatus.ACTIVE } });
        ctx = makeRequestContext('ADMIN', { userId: adminId, tenantId: TENANT_ID, tenantSlug: TAG });

        const risk = await globalPrisma.risk.create({
            data: { tenantId: TENANT_ID, title: 'SQL Injection', threat: 'External attacker; Insider', productivityLoss: 100_000, fairAle: 200_000, score: 16 },
        });
        riskId = risk.id;
        bareRiskId = (await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'No controls' } })).id;

        const prev = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'WAF', mitigationType: 'PREVENTIVE' } });
        const det = await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: 'Monitoring', mitigationType: 'DETECTIVE' } });
        await globalPrisma.riskControl.create({ data: { tenantId: TENANT_ID, riskId, controlId: prev.id } });
        await globalPrisma.riskControl.create({ data: { tenantId: TENANT_ID, riskId, controlId: det.id } });
    });

    afterAll(async () => {
        const t = { tenantId: TENANT_ID };
        for (const m of ['riskControl', 'control', 'risk', 'tenantMembership'] as const) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try { await (globalPrisma as any)[m].deleteMany({ where: t }); } catch { /* best effort */ }
        }
        try { await globalPrisma.user.deleteMany({ where: { id: adminId } }); } catch { /* best effort */ }
        try { await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await globalPrisma.$disconnect();
    });

    it('projects barriers by mitigationType + decomposes consequences', async () => {
        const p = await projectBowTie(ctx, riskId);
        expect(p.event.riskId).toBe(riskId);
        expect(p.preventiveBarriers.map((b) => b.title)).toContain('WAF');
        expect(p.mitigatingBarriers.map((b) => b.title)).toContain('Monitoring');
        expect(p.threats.length).toBe(2); // split narrative
        expect(p.consequences.some((c) => c.label === 'Productivity loss')).toBe(true);
    });

    it('a risk with no controls → empty barrier arrays', async () => {
        const p = await projectBowTie(ctx, bareRiskId);
        expect(p.preventiveBarriers).toHaveLength(0);
        expect(p.mitigatingBarriers).toHaveLength(0);
    });

    it('a risk in another tenant → not found (RLS)', async () => {
        const otherCtx = makeRequestContext('ADMIN', { userId: adminId, tenantId: `t-other-${TAG}`, tenantSlug: `other-${TAG}` });
        await expect(projectBowTie(otherCtx, riskId)).rejects.toThrow();
    });
});
