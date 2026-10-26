/**
 * RQ-3 — Monte Carlo run persistence (DB-backed). `runSimulation` loads the
 * portfolio, simulates, and persists a COMPLETED RiskSimulationRun.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { runSimulation, getLatestSimulation, getPerRiskPercentiles } from '@/app-layer/usecases/monte-carlo';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `mc-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let adminId = '';
let ctx: ReturnType<typeof makeRequestContext>;

describeFn('RQ-3 — Monte Carlo run (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        const email = `${TAG}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        adminId = u.id;
        await globalPrisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: adminId, role: Role.ADMIN, status: MembershipStatus.ACTIVE } });
        ctx = makeRequestContext('ADMIN', { userId: adminId, tenantId: TENANT_ID, tenantSlug: TAG });
        await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'R1', sleAmount: 200_000, aroAmount: 2 } });
        await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'R2', sleAmount: 100_000, aroAmount: 1 } });
    });

    afterAll(async () => {
        const t = { tenantId: TENANT_ID };
        for (const m of ['riskSimulationRun', 'risk', 'tenantMembership'] as const) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try { await (globalPrisma as any)[m].deleteMany({ where: t }); } catch { /* best effort */ }
        }
        try { await globalPrisma.user.deleteMany({ where: { id: adminId } }); } catch { /* best effort */ }
        try { await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await globalPrisma.$disconnect();
    });

    it('persists a COMPLETED run with results + executionMs', async () => {
        const result = await runSimulation(ctx, { iterations: 2000, seed: 42 });
        expect(result.runId).toBeTruthy();
        expect(result.portfolioAle.mean).toBeGreaterThan(0);

        const run = await globalPrisma.riskSimulationRun.findUniqueOrThrow({ where: { id: result.runId } });
        expect(run.status).toBe('COMPLETED');
        expect(run.portfolioMean).toBeGreaterThan(0);
        expect(run.portfolioP95).toBeGreaterThanOrEqual(run.portfolioP50!);
        // RQ3-1 — VaR-80 persists between the existing percentiles.
        expect(run.portfolioP80).toBeGreaterThanOrEqual(run.portfolioP50!);
        expect(run.portfolioP90).toBeGreaterThanOrEqual(run.portfolioP80!);
        expect(Array.isArray(run.lecPointsJson)).toBe(true);
        expect(Array.isArray(run.perRiskResultsJson)).toBe(true);
        // RQ3-1 — the per-risk tail trio is cached on the run.
        for (const entry of run.perRiskResultsJson as Array<Record<string, number>>) {
            expect(entry.aleP50).toBeGreaterThan(0);
            expect(entry.aleP90).toBeGreaterThanOrEqual(entry.aleP50);
            expect(entry.aleP95).toBeGreaterThanOrEqual(entry.aleP90);
        }
        expect(run.executionMs).toBeGreaterThanOrEqual(0);
    });

    it('getLatestSimulation returns the most recent COMPLETED run', async () => {
        await runSimulation(ctx, { iterations: 1000, seed: 1 });
        const latest = await getLatestSimulation(ctx);
        expect(latest?.status).toBe('COMPLETED');
    });

    it('RQ3-1 — getPerRiskPercentiles retrieves the cached tail trio per risk', async () => {
        const snapshot = await getPerRiskPercentiles(ctx);
        expect(snapshot).not.toBeNull();
        expect(snapshot!.runId).toBeTruthy();
        const risks = await globalPrisma.risk.findMany({ where: { tenantId: TENANT_ID } });
        for (const r of risks) {
            const tails = snapshot!.byRisk[r.id];
            expect(tails).toBeDefined();
            expect(tails.aleP50).toBeLessThanOrEqual(tails.aleP90);
            expect(tails.aleP90).toBeLessThanOrEqual(tails.aleP95);
            expect(tails.contribution).toBeGreaterThan(0);
        }
    });
});
