/**
 * RQ-9 — snapshot capture (DB-backed): per-risk + portfolio rows,
 * per-day idempotency, soft-delete exclusion, retention cleanup.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { takeSnapshot, cleanupSnapshots } from '@/app-layer/usecases/risk-snapshot';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `snap-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let adminId = '';

describeFn('RQ-9 — risk snapshot (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        const email = `${TAG}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        adminId = u.id;
        await globalPrisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: adminId, role: Role.ADMIN, status: MembershipStatus.ACTIVE } });
        await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'R1', fairAle: 200_000, score: 12 } });
        await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'R2', sleAmount: 50_000, aroAmount: 1, score: 8 } });
        await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'Deleted', score: 9, deletedAt: new Date() } });
    });

    afterAll(async () => {
        const t = { tenantId: TENANT_ID };
        for (const m of ['riskSnapshot', 'portfolioSnapshot', 'risk', 'tenantMembership'] as const) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try { await (globalPrisma as any)[m].deleteMany({ where: t }); } catch { /* best effort */ }
        }
        try { await globalPrisma.user.deleteMany({ where: { id: adminId } }); } catch { /* best effort */ }
        try { await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await globalPrisma.$disconnect();
    });

    it('captures one snapshot per ACTIVE risk + one portfolio row; idempotent per day', async () => {
        const r1 = await takeSnapshot(globalPrisma, TENANT_ID);
        expect(r1.riskSnapshots).toBe(2); // soft-deleted excluded
        expect(r1.portfolioSnapshot).toBe(true);

        const riskRows = await globalPrisma.riskSnapshot.count({ where: { tenantId: TENANT_ID } });
        const portRows = await globalPrisma.portfolioSnapshot.count({ where: { tenantId: TENANT_ID } });
        expect(riskRows).toBe(2);
        expect(portRows).toBe(1);

        const portfolio = await globalPrisma.portfolioSnapshot.findFirstOrThrow({ where: { tenantId: TENANT_ID } });
        expect(portfolio.totalRiskCount).toBe(2);
        expect(portfolio.quantifiedCount).toBe(2);
        expect(portfolio.totalAle).toBe(250_000); // 200k + 50k

        // Second run same UTC day → no new rows.
        const r2 = await takeSnapshot(globalPrisma, TENANT_ID);
        expect(r2.portfolioSnapshot).toBe(false);
        expect(await globalPrisma.portfolioSnapshot.count({ where: { tenantId: TENANT_ID } })).toBe(1);
    });

    it('cleanup removes snapshots older than the retention window', async () => {
        // Insert an old snapshot 800 days back.
        const old = new Date(Date.now() - 800 * 86400000);
        await globalPrisma.portfolioSnapshot.create({ data: { tenantId: TENANT_ID, totalRiskCount: 0, openRiskCount: 0, quantifiedCount: 0, totalScore: 0, avgScore: 0, snapshotAt: old } });
        const removed = await cleanupSnapshots(globalPrisma, TENANT_ID, 730);
        expect(removed).toBeGreaterThanOrEqual(1);
        expect(await globalPrisma.portfolioSnapshot.count({ where: { tenantId: TENANT_ID, snapshotAt: old } })).toBe(0);
    });
});
