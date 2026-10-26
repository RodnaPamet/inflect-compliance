/**
 * RQ-8 — correlation persistence + its effect on the Monte Carlo (DB-backed).
 * setCorrelation normalises the pair; getCorrelationMatrix builds the NxN;
 * a positively-correlated portfolio simulates a WIDER loss distribution.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { setCorrelation, getCorrelationMatrix } from '@/app-layer/usecases/risk-correlation';
import { simulatePortfolio, runSimulation, type SimRisk } from '@/app-layer/usecases/monte-carlo';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `corr-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let adminId = '';
let rA = ''; let rB = '';
let ctx: ReturnType<typeof makeRequestContext>;

describeFn('RQ-8 — correlation + simulation (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        const email = `${TAG}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        adminId = u.id;
        await globalPrisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: adminId, role: Role.ADMIN, status: MembershipStatus.ACTIVE } });
        ctx = makeRequestContext('ADMIN', { userId: adminId, tenantId: TENANT_ID, tenantSlug: TAG });
        rA = (await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'A', fairAle: 500_000 } })).id;
        rB = (await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'B', fairAle: 500_000 } })).id;
    });

    afterAll(async () => {
        const t = { tenantId: TENANT_ID };
        for (const m of ['riskSimulationRun', 'riskCorrelation', 'risk', 'tenantMembership'] as const) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try { await (globalPrisma as any)[m].deleteMany({ where: t }); } catch { /* best effort */ }
        }
        try { await globalPrisma.user.deleteMany({ where: { id: adminId } }); } catch { /* best effort */ }
        try { await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await globalPrisma.$disconnect();
    });

    it('setCorrelation normalises the pair + getCorrelationMatrix builds a PSD NxN', async () => {
        // Pass the pair "reversed" — service normalises to riskAId < riskBId.
        await setCorrelation(ctx, { riskAId: rB, riskBId: rA, coefficient: 0.8, rationale: 'shared actor' });
        const rows = await globalPrisma.riskCorrelation.findMany({ where: { tenantId: TENANT_ID } });
        expect(rows).toHaveLength(1);
        const [a, b] = rA < rB ? [rA, rB] : [rB, rA];
        expect(rows[0].riskAId).toBe(a);
        expect(rows[0].riskBId).toBe(b);

        const m = await getCorrelationMatrix(ctx);
        expect(m.riskIds).toHaveLength(2);
        expect(m.isPositiveSemiDefinite).toBe(true);
        // diagonal 1, off-diagonal 0.8
        const i = m.riskIds.indexOf(rA); const j = m.riskIds.indexOf(rB);
        expect(m.matrix[i][i]).toBe(1);
        expect(m.matrix[i][j]).toBeCloseTo(0.8, 6);
    });

    it('a positively-correlated portfolio simulates a wider loss distribution', async () => {
        const m = await getCorrelationMatrix(ctx);
        const risks: SimRisk[] = m.riskIds.map((id, k) => ({ id, title: m.riskTitles[k], pointAle: 500_000 }));
        const independent = simulatePortfolio(risks, { iterations: 8000, seed: 5 });
        const correlated = simulatePortfolio(risks, { iterations: 8000, seed: 5, correlationMatrix: m.matrix });
        // Correlated risks co-materialise → fatter tail → larger stdDev.
        expect(correlated.portfolioAle.stdDev).toBeGreaterThan(independent.portfolioAle.stdDev);
    });

    // ── RQ3-3 — stored correlations apply on the DEFAULT path ─────

    it('runSimulation applies stored correlations without an explicit matrix', async () => {
        // Same seed, default path (loads the ρ=0.8 pair from the DB)
        // vs. an explicit-identity run: the correlated default must
        // produce the wider distribution.
        const withStored = await runSimulation(ctx, { iterations: 8000, seed: 5 });
        const identity = await runSimulation(ctx, {
            iterations: 8000,
            seed: 5,
            correlationMatrix: [
                [1, 0],
                [0, 1],
            ],
        });
        expect(withStored.portfolioAle.stdDev).toBeGreaterThan(identity.portfolioAle.stdDev);
    });
});
