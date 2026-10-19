/**
 * `/api/t/:slug/admin/agents/budget` — the per-tenant MONTHLY token budget for
 * agentic runs (#3777).
 *
 * The column, `TenantSecuritySettings.agentMonthlyTokenBudget`, had readers and
 * no writer: the budget gate at `startWorkflowRun`, the agentic reports, and
 * inbound A2A, which refuses `TENANT_CAPS_UNSET` until both this and the
 * concurrency cap are set (R13). The owner put it BESIDE the concurrency cap
 * (#3777): the sibling of `…/admin/agents/concurrency`, under the same key and
 * in the same shape, so the two capacity axes are read and set in one place.
 *
 * `admin.agent_registry`, for the reason the concurrency route gives: a budget
 * bounds how much NEW work may start and stops nothing already running, so it
 * is capacity planning, not the emergency stop the kill key carries.
 *
 * The gate is at the ROUTE (a denial writes `AUTHZ_DENIED`), and its rule sits
 * ABOVE the generic `admin/agents(/.*)?` entry in `ROUTE_PERMISSIONS`.
 *
 * PATCH with `budget: null` to CLEAR (unlimited) and `budget: 0` to refuse
 * every run, as the concurrency route does with its cap. The setter refuses a
 * budget above 0 and below one run's ceiling, which the gate would read as
 * "refuse every run" while it looked like a budget.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';

import { readMonthlyTokenBudget, setMonthlyTokenBudget, spentThisMonth } from '@/lib/agentic/monthly-budget-policy';
import { BUDGET_RUN_TOKEN_CEILING } from '@/lib/agentic/monthly-budget';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

const Body = z.object({
    /**
     * `null` clears the budget; `0` refuses every run. Shape only here: the
     * bounds, with the reason a budget below one run's ceiling is refused, are
     * `monthlyBudgetSettingRefusal`, which the setter applies.
     */
    budget: z.number().int().nullable(),
});

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, _routeArgs, ctx) => {
            const budget = await readMonthlyTokenBudget(ctx);
            // The REAL spend, and only where there is a budget to measure it
            // against: the gate's own verdict short-circuits to a false zero
            // with no budget configured, and an uncapped tenant has no
            // denominator for the figure.
            const spent = budget === null ? null : await spentThisMonth(ctx, new Date());
            return jsonResponse({ budget, spentThisMonth: spent, runTokenCeiling: BUDGET_RUN_TOKEN_CEILING });
        },
    ),
);

export const PATCH = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = Body.parse(await req.json());
            return jsonResponse(await setMonthlyTokenBudget(ctx, body.budget));
        },
    ),
);
