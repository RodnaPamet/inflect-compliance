/**
 * RQ-4 — scenario simulation (DB-backed). create → simulate → compare,
 * status transition, scenario-tagged run, archived guard.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createScenario, simulateScenario, archiveScenario } from '@/app-layer/usecases/risk-scenario';
import { runSimulation, getLatestSimulation } from '@/app-layer/usecases/monte-carlo';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `scn-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let adminId = '';
let riskId = '';
let ctx: ReturnType<typeof makeRequestContext>;

describeFn('RQ-4 — scenario simulation (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        const email = `${TAG}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        adminId = u.id;
        await globalPrisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: adminId, role: Role.ADMIN, status: MembershipStatus.ACTIVE } });
        ctx = makeRequestContext('ADMIN', { userId: adminId, tenantId: TENANT_ID, tenantSlug: TAG });
        const risk = await globalPrisma.risk.create({
            data: { tenantId: TENANT_ID, title: 'SQL injection', threatEventFrequency: 10, vulnerabilityProbability: 0.6, primaryLossMagnitude: 100_000, fairAle: 600_000 },
        });
        riskId = risk.id;
    });

    afterAll(async () => {
        const t = { tenantId: TENANT_ID };
        for (const m of ['riskScenario', 'riskSimulationRun', 'risk', 'tenantMembership'] as const) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            try { await (globalPrisma as any)[m].deleteMany({ where: t }); } catch { /* best effort */ }
        }
        try { await globalPrisma.user.deleteMany({ where: { id: adminId } }); } catch { /* best effort */ }
        try { await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await globalPrisma.$disconnect();
    });

    it('simulating creates a scenario-tagged run, sets resultRunId, transitions to SIMULATED, lowers ALE', async () => {
        const scenario = await createScenario(ctx, {
            name: 'WAF', investmentCost: 50_000,
            overrides: [{ riskId, field: 'vulnerabilityProbability', newValue: 0.1, rationale: 'WAF blocks injection' }],
        });
        expect(scenario.status).toBe('DRAFT');

        const cmp = await simulateScenario(ctx, scenario.id);
        // vuln 0.6→0.1 cuts ALE; scenario mean < baseline mean.
        expect(cmp.scenario.portfolioAle.mean).toBeLessThan(cmp.baseline.portfolioAle.mean);
        expect(cmp.delta.meanAleDelta).toBeLessThan(0);
        expect(cmp.delta.roi).not.toBeNull();
        expect(cmp.perRiskDeltas.find((d) => d.riskId === riskId)?.deltaPercent).toBeLessThan(0);

        const reloaded = await globalPrisma.riskScenario.findUniqueOrThrow({ where: { id: scenario.id } });
        expect(reloaded.status).toBe('SIMULATED');
        expect(reloaded.resultRunId).toBeTruthy();

        const run = await globalPrisma.riskSimulationRun.findUniqueOrThrow({ where: { id: reloaded.resultRunId! } });
        expect(run.triggeredBy).toBe('scenario');
        expect(run.status).toBe('COMPLETED');
    });

    it('P2 — a scenario run never becomes the portfolio latest simulation', async () => {
        // Baseline (manual) run first, then a NEWER scenario run.
        const baseline = await runSimulation(ctx, { iterations: 500 });
        const scenario = await createScenario(ctx, {
            name: 'Scope', overrides: [{ riskId, field: 'primaryLossMagnitude', newValue: 10_000 }],
        });
        await simulateScenario(ctx, scenario.id);

        // The dashboard's latest simulation must be the BASELINE, never the
        // (newer) scenario run — running a what-if can't move the dashboard.
        const latest = await getLatestSimulation(ctx);
        expect(latest).not.toBeNull();
        expect(latest!.triggeredBy).not.toBe('scenario');
        expect(latest!.id).toBe(baseline.runId);
        expect(latest!.portfolioP80).not.toBeNull();

        // And the scenario run itself now persists P80 (belt-and-braces).
        const scnRun = await globalPrisma.riskSimulationRun.findFirstOrThrow({
            where: { tenantId: TENANT_ID, triggeredBy: 'scenario' },
            orderBy: { createdAt: 'desc' },
        });
        expect(scnRun.portfolioP80).not.toBeNull();
    });

    it('an archived scenario cannot be re-simulated', async () => {
        const scenario = await createScenario(ctx, { name: 'Archived', overrides: [] });
        await archiveScenario(ctx, scenario.id);
        await expect(simulateScenario(ctx, scenario.id)).rejects.toThrow();
    });
});
