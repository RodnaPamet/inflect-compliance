/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic model cleanup loop. */
/**
 * RQ-2 — appetite breach record/dedupe/resolve (DB-backed). Exercises the
 * service functions the monitor job composes (checkPortfolioAppetite →
 * recordBreaches → resolveStaleBreaches).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    upsertAppetiteConfig,
    checkPortfolioAppetite,
    recordBreaches,
    resolveStaleBreaches,
    createBreachRemediationTask,
} from '@/app-layer/usecases/risk-appetite';

const globalPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `appetite-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
let adminId = '';
let ctx: ReturnType<typeof makeRequestContext>;

describeFn('RQ-2 — appetite monitor (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({ where: { id: TENANT_ID }, update: {}, create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        const email = `${TAG}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        adminId = u.id;
        await globalPrisma.tenantMembership.create({ data: { tenantId: TENANT_ID, userId: adminId, role: Role.ADMIN, status: MembershipStatus.ACTIVE } });
        ctx = makeRequestContext('ADMIN', { userId: adminId, tenantId: TENANT_ID, tenantSlug: TAG });
        // Two risks at $2M ALE each via legacy SLE×ARO = $4M portfolio.
        await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'R1', sleAmount: 1_000_000, aroAmount: 2 } });
        await globalPrisma.risk.create({ data: { tenantId: TENANT_ID, title: 'R2', sleAmount: 1_000_000, aroAmount: 2 } });
        await upsertAppetiteConfig(ctx, { totalAleThreshold: 2_500_000 });
    });

    afterAll(async () => {
        const t = { tenantId: TENANT_ID };
        for (const m of ['taskLink', 'task', 'riskSimulationRun', 'riskAppetiteBreach', 'riskAppetiteConfig', 'auditLog', 'risk', 'tenantMembership'] as const) {
            try { await (globalPrisma as any)[m].deleteMany({ where: t }); } catch { /* best effort */ }
        }
        try { await globalPrisma.user.deleteMany({ where: { id: adminId } }); } catch { /* best effort */ }
        try { await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }); } catch { /* best effort */ }
        await globalPrisma.$disconnect();
    });

    it('records a PORTFOLIO_ALE breach when the ceiling is exceeded', async () => {
        const result = await checkPortfolioAppetite(ctx);
        expect(result.portfolioAle).toBe(4_000_000);
        expect(result.breaches.some((b) => b.type === 'PORTFOLIO_ALE')).toBe(true);
        const created = await recordBreaches(ctx, result.breaches);
        expect(created).toBeGreaterThanOrEqual(1);
        const rows = await globalPrisma.riskAppetiteBreach.findMany({ where: { tenantId: TENANT_ID, breachType: 'PORTFOLIO_ALE', resolvedAt: null } });
        expect(rows).toHaveLength(1);
    });

    it('createBreachRemediationTask spawns a real RISK_MONITOR task (no 500 on invalid source)', async () => {
        const breach = await globalPrisma.riskAppetiteBreach.create({
            data: {
                tenantId: TENANT_ID,
                breachType: 'SINGLE_RISK_ALE',
                thresholdValue: 100,
                actualValue: 300,
            },
        });

        // Before the fix this threw a 500 (source:'risk_appetite_breach' is
        // not a TaskSource member, and the call was unguarded).
        const out = await createBreachRemediationTask(ctx, breach.id);
        expect(out.taskId).toBeTruthy();

        const task = await globalPrisma.task.findFirstOrThrow({ where: { id: out.taskId, tenantId: TENANT_ID } });
        expect(task.source).toBe('RISK_MONITOR');
        expect(task.key).toMatch(/^TSK-\d+$/);

        // The breach is pinned to its remediation task.
        const after = await globalPrisma.riskAppetiteBreach.findFirstOrThrow({ where: { id: breach.id } });
        expect(after.remediationTaskId).toBe(out.taskId);
    });

    it('does NOT create a duplicate breach on a second scan', async () => {
        const result = await checkPortfolioAppetite(ctx);
        await recordBreaches(ctx, result.breaches);
        const rows = await globalPrisma.riskAppetiteBreach.findMany({ where: { tenantId: TENANT_ID, breachType: 'PORTFOLIO_ALE', resolvedAt: null } });
        expect(rows).toHaveLength(1); // still one
    });

    it('resolves the breach when the portfolio drops under threshold', async () => {
        // Raise the ceiling so the portfolio is now within appetite.
        await upsertAppetiteConfig(ctx, { totalAleThreshold: 10_000_000 });
        const result = await checkPortfolioAppetite(ctx);
        expect(result.breaches.some((b) => b.type === 'PORTFOLIO_ALE')).toBe(false);
        const resolved = await resolveStaleBreaches(ctx, result.breaches);
        expect(resolved).toBeGreaterThanOrEqual(1);
        const open = await globalPrisma.riskAppetiteBreach.findMany({ where: { tenantId: TENANT_ID, resolvedAt: null } });
        expect(open).toHaveLength(0);
    });

    // ── RQ3-3 — the ceiling is tested at the configured percentile ──

    it('with a simulation, the check runs against portfolioP<NN>, not Σ of means', async () => {
        const { runSimulation } = await import('@/app-layer/usecases/monte-carlo');
        await runSimulation(ctx, { iterations: 2000, seed: 7 });
        const run = await globalPrisma.riskSimulationRun.findFirstOrThrow({
            where: { tenantId: TENANT_ID, status: 'COMPLETED' },
            orderBy: { createdAt: 'desc' },
        });

        await upsertAppetiteConfig(ctx, { totalAleThreshold: 10_000_000, testedPercentile: 95 });
        const result = await checkPortfolioAppetite(ctx);
        expect(result.portfolioTested.simulated).toBe(true);
        expect(result.portfolioTested.percentile).toBe(95);
        expect(result.portfolioTested.value).toBeCloseTo(run.portfolioP95!, 0);
        // Σ stays available for the subordinate line.
        expect(result.portfolioAle).toBe(4_000_000);
    });

    it('a tight ceiling breaches with the simulated percentile as the actual', async () => {
        await upsertAppetiteConfig(ctx, { totalAleThreshold: 1, testedPercentile: 95 });
        const result = await checkPortfolioAppetite(ctx);
        const breach = result.breaches.find((b) => b.type === 'PORTFOLIO_ALE');
        expect(breach).toBeDefined();
        expect(breach!.actual).toBeCloseTo(result.portfolioTested.value, 0);
        expect(result.portfolioTested.simulated).toBe(true);
        // Leave the tenant tidy for the cleanup hooks.
        await upsertAppetiteConfig(ctx, { totalAleThreshold: 10_000_000, testedPercentile: 80 });
        await globalPrisma.riskSimulationRun.deleteMany({ where: { tenantId: TENANT_ID } });
    });
});
