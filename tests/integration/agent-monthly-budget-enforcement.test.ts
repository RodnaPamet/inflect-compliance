/**
 * The monthly budget against a real database — the parts the pure unit tests
 * cannot reach.
 *
 * `tests/unit/agent-monthly-budget.test.ts` proves the arithmetic. What it
 * cannot prove is that the arithmetic is fed the right numbers, and that is
 * where this axis can actually be wrong:
 *
 *   · the SUM has to be of this tenant's runs and no other tenant's;
 *   · the WINDOW has to start at the UTC month boundary — a run from last
 *     month must not count, and one from the first instant of this month must;
 *   · a tenant with no budget configured must short-circuit and never be
 *     refused, whatever it has spent.
 *
 * Each is a query-shaped mistake that reads perfectly in review and produces a
 * number that is simply wrong.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { evaluateMonthlyBudgetForRun } from '@/lib/agentic/monthly-budget-policy';
import { ENGINE_RUN_CAPS } from '@/lib/agentic/run-caps';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const MINE = 'budget-tenant-mine';
const OTHER = 'budget-tenant-other';

/** A fixed "now" so the window boundaries are arithmetic, not wall-clock luck. */
const NOW = new Date('2026-09-21T12:00:00.000Z');
const THIS_MONTH = new Date('2026-09-05T09:00:00.000Z');
const MONTH_FIRST_INSTANT = new Date('2026-09-01T00:00:00.000Z');
const LAST_MONTH = new Date('2026-08-31T23:59:59.000Z');

const ctxFor = (tenantId: string) => ({
    ...makeRequestContext('ADMIN'),
    tenantId,
});

async function seedRun(id: string, tenantId: string, startedAt: Date, costTokens: number) {
    await prisma.workflowRun.create({
        data: { id, tenantId, workflowKey: 'audit-prep', startedAt, costTokens },
    });
}

async function setBudget(tenantId: string, agentMonthlyTokenBudget: number | null) {
    await prisma.tenantSecuritySettings.upsert({
        where: { tenantId },
        create: { tenantId, agentMonthlyTokenBudget },
        update: { agentMonthlyTokenBudget },
    });
}

describeFn('the monthly budget reads the right numbers', () => {
    beforeAll(async () => {
        for (const t of [MINE, OTHER]) {
            await prisma.workflowRun.deleteMany({ where: { tenantId: t } });
            await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: t } });
            await prisma.tenant.deleteMany({ where: { id: t } });
            await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
        }

        // MINE: 300 this month (200 + 100), 9_000_000 last month, and the
        // other tenant spends a fortune this month.
        await seedRun('bud-run-1', MINE, THIS_MONTH, 200);
        await seedRun('bud-run-2', MINE, MONTH_FIRST_INSTANT, 100);
        await seedRun('bud-run-3', MINE, LAST_MONTH, 9_000_000);
        await seedRun('bud-run-4', OTHER, THIS_MONTH, 9_000_000);
    });

    afterAll(async () => {
        if (MINE && OTHER) {
            await prisma.workflowRun.deleteMany({ where: { tenantId: { in: [MINE, OTHER] } } });
            await prisma.tenantSecuritySettings.deleteMany({
                where: { tenantId: { in: [MINE, OTHER] } },
            });
            await prisma.tenant.deleteMany({ where: { id: { in: [MINE, OTHER] } } });
        }
        await prisma.$disconnect();
    });

    it('sums only THIS tenant and only THIS month', async () => {
        // 200 + 100 = 300 — not 9_000_300, which is what either a missing
        // month window or a missing tenant scope would produce.
        //
        // THE TWO HALVES ARE NOT DEFENDED BY THE SAME THING, and the mutation
        // proof is what established it rather than the code review. Deleting
        // the month window from the aggregate turns this red. Deleting the
        // `tenantId` filter does NOT — because `runInTenantContext` issues
        // `SET LOCAL ROLE app_user` inside the transaction, so the query runs
        // as a non-superuser under FORCE ROW LEVEL SECURITY and the database
        // scopes it whether or not the application asked. (Measured directly:
        // the same aggregate on a plain client returns 300 with the filter and
        // 9_000_300 without it; inside the tenant context both return 300.)
        //
        // So the explicit filter here is the documented defence-in-depth
        // second layer, exactly as docs/rls-tenant-isolation.md describes — not
        // the thing standing between tenants. Worth writing down, because a
        // reader who mutates that line, sees green, and concludes the filter is
        // dead code would be removing one of two layers and would never learn
        // it from this suite.
        await setBudget(MINE, 10_000_000);
        const v = await evaluateMonthlyBudgetForRun(ctxFor(MINE), NOW);
        expect(v.spentThisMonth).toBe(300);
    });

    it('counts a run started at the first instant of the month', async () => {
        // The boundary is inclusive. `bud-run-2` sits exactly on it and is part
        // of the 300 above; dropping it would make the window exclusive and the
        // first run of every month free.
        const row = await prisma.workflowRun.findUnique({ where: { id: 'bud-run-2' } });
        expect(row?.startedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('refuses when spend plus this run ceiling would cross the budget', async () => {
        // Budget set just below (300 + the run ceiling), so the refusal is
        // caused by the worst-case arithmetic rather than by spend alone —
        // spend is 300 and the budget is far larger than that.
        await setBudget(MINE, 300 + ENGINE_RUN_CAPS.TOKENS - 1);
        const v = await evaluateMonthlyBudgetForRun(ctxFor(MINE), NOW);
        expect({ allowed: v.allowed, reason: v.reason }).toEqual({
            allowed: false,
            reason: 'MONTHLY_TOKEN_BUDGET_EXCEEDED',
        });
    });

    it('admits when the budget covers spend plus the ceiling exactly', async () => {
        await setBudget(MINE, 300 + ENGINE_RUN_CAPS.TOKENS);
        const v = await evaluateMonthlyBudgetForRun(ctxFor(MINE), NOW);
        expect({ allowed: v.allowed, worstCaseTotal: v.worstCaseTotal }).toEqual({
            allowed: true,
            worstCaseTotal: 300 + ENGINE_RUN_CAPS.TOKENS,
        });
    });

    it('a tenant with NO budget is never refused, and never pays for the aggregate', async () => {
        // The short-circuit. `spentThisMonth` is reported as 0 not because the
        // tenant spent nothing — it spent 300 — but because with no budget the
        // sum cannot change the answer and is deliberately not run.
        await setBudget(MINE, null);
        const v = await evaluateMonthlyBudgetForRun(ctxFor(MINE), NOW);
        expect({ allowed: v.allowed, budgetTokens: v.budgetTokens, spentThisMonth: v.spentThisMonth })
            .toEqual({ allowed: true, budgetTokens: null, spentThisMonth: 0 });
    });

    it('a tenant with no settings row at all is never refused', async () => {
        // Distinct from a NULL column: no row whatsoever. Both mean "not
        // configured", and both must admit.
        const v = await evaluateMonthlyBudgetForRun(ctxFor(OTHER), NOW);
        expect({ allowed: v.allowed, budgetTokens: v.budgetTokens }).toEqual({
            allowed: true,
            budgetTokens: null,
        });
    });
});
