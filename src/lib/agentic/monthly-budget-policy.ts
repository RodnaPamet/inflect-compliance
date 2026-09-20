/**
 * The server half of the monthly token budget: read the ceiling, sum the
 * month's spend, and refuse a run at the door.
 *
 * Split from `monthly-budget.ts` so that module stays pure and free of server
 * imports — the same split `agent-driver.ts` / `agent-driver-policy.ts` carries,
 * and for the same reason: the decision is worth testing without a database.
 *
 * ## Why the run's bound is the ENGINE ceiling and not a card-narrowed one
 *
 * Checked rather than assumed. `resolveRunCaps` narrows exactly one axis by the
 * policy card — `TOOL_CALLS`, from `maxActionsPerRun` — and returns
 * `engineCap('TOKENS')` unconditionally. So a run's token ceiling is
 * `ENGINE_RUN_CAPS.TOKENS` whatever card is in force, and reading the card here
 * would be a database round trip that cannot change the answer.
 *
 * If a future card ever gains a token term, this is the line that has to move,
 * and `tests/unit/agent-monthly-budget.test.ts` asserts the equality that makes
 * the omission safe today — so it fails here rather than silently over-charging
 * a narrowed run.
 */
import prisma from '@/lib/prisma';
import { logger } from '@/lib/observability/logger';
import { runInTenantContext } from '@/lib/db/rls-middleware';
import { forbidden } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

import { ENGINE_RUN_CAPS } from './run-caps';
import {
    evaluateMonthlyBudget,
    monthStartUtc,
    monthlyBudgetRefusalMessage,
    type MonthlyBudgetVerdict,
} from './monthly-budget';

/**
 * Sum the tokens this tenant's runs have already charged this UTC month.
 *
 * Reads through `runInTenantContext`, so the sum is RLS-scoped like every other
 * tenant read — a budget computed with the tenant filter applied only in the
 * WHERE clause would be one `app_user` misconfiguration away from summing the
 * whole table.
 *
 * `costTokens` is `@default(0)` and non-null, so a run that has charged nothing
 * contributes zero rather than dropping out of the sum.
 */
async function spentThisMonth(ctx: RequestContext, now: Date): Promise<number> {
    const since = monthStartUtc(now);
    const agg = await runInTenantContext(ctx, (tx) =>
        tx.workflowRun.aggregate({
            _sum: { costTokens: true },
            where: { tenantId: ctx.tenantId, startedAt: { gte: since } },
        }),
    );
    return agg._sum.costTokens ?? 0;
}

/**
 * Evaluate the budget for one prospective run. Never throws — the enforcing
 * wrapper is `assertWithinMonthlyBudget`.
 *
 * The `evaluate` / `assert` split is the one `agent-registration-gate.ts` draws,
 * and it exists so an operator surface can REPORT a tenant's headroom without a
 * refusal as a side effect.
 *
 * A failed settings read resolves to NO BUDGET (allowed) and logs at WARN. That
 * is the same direction as the column's own NULL: this bounds something already
 * authorised, so an unreadable row must not become an outage. The log line is
 * what keeps that from being silent.
 */
export async function evaluateMonthlyBudgetForRun(
    ctx: RequestContext,
    now: Date = new Date(),
): Promise<MonthlyBudgetVerdict> {
    let budgetTokens: number | null = null;
    try {
        const row = await prisma.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { agentMonthlyTokenBudget: true },
        });
        budgetTokens = row?.agentMonthlyTokenBudget ?? null;
    } catch (err) {
        logger.warn('monthly-budget: settings read failed, treating as no budget', {
            tenantId: ctx.tenantId,
            requestId: ctx.requestId,
            error: err instanceof Error ? err.message : String(err),
        });
        return evaluateMonthlyBudget({
            budgetTokens: null,
            spentThisMonth: 0,
            runTokenCap: ENGINE_RUN_CAPS.TOKENS,
        });
    }

    // Short-circuit BEFORE the aggregate. With no budget configured the sum
    // cannot change the answer, so reading it would be an aggregate over every
    // run this tenant started this month, on the hot path of every run start,
    // for every tenant that has not opted in — which is all of them today.
    if (budgetTokens === null) {
        return evaluateMonthlyBudget({
            budgetTokens: null,
            spentThisMonth: 0,
            runTokenCap: ENGINE_RUN_CAPS.TOKENS,
        });
    }

    return evaluateMonthlyBudget({
        budgetTokens,
        spentThisMonth: await spentThisMonth(ctx, now),
        runTokenCap: ENGINE_RUN_CAPS.TOKENS,
    });
}

/**
 * Enforce the budget. Throws a typed `forbidden` carrying both numbers.
 *
 * Call this BEFORE the run row is written. A refusal that happens after
 * `createSealedRun` leaves a RUNNING row nothing will ever advance, which the
 * `agentic-run-settlement` sweep would later have to reap as a crashed
 * executor — a refusal disguised as an outage.
 */
export async function assertWithinMonthlyBudget(
    ctx: RequestContext,
    now: Date = new Date(),
): Promise<MonthlyBudgetVerdict> {
    const verdict = await evaluateMonthlyBudgetForRun(ctx, now);
    if (!verdict.allowed) {
        logger.warn('monthly-budget: run refused at the door', {
            tenantId: ctx.tenantId,
            requestId: ctx.requestId,
            spentThisMonth: verdict.spentThisMonth,
            budgetTokens: verdict.budgetTokens,
            runTokenCap: verdict.runTokenCap,
        });
        throw forbidden(monthlyBudgetRefusalMessage(verdict));
    }
    return verdict;
}
