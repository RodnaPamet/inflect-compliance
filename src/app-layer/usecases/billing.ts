/**
 * Billing — administrative plan changes.
 *
 * `changeTenantPlan` is the manual path that mutates `BillingAccount.plan`;
 * the Stripe webhook (`src/lib/stripe.ts`) is the other. Its only caller is
 * the PLATFORM-admin route, through `setTenantPlanAsPlatform` in
 * `tenant-lifecycle.ts`: a plan
 * decides a tenant's entitlements, so a tenant's own OWNER must not set it
 * (owner decision 2026-11-12). It emits `business.plan.upgraded` /
 * `business.plan.downgraded` by comparing the plan RANK before/after
 * the change — the canonical wiring point for those two KPIs.
 *
 * SAAS-mode only: under SELFHOSTED every tenant resolves to ENTERPRISE
 * and a plan change is meaningless (throws `forbidden`).
 *
 * @module app-layer/usecases/billing
 */
import { runInTenantContext } from '@/lib/db/rls-middleware';
import type { RequestContext } from '@/app-layer/types';
import { logEvent } from '@/app-layer/events/audit';
import { getBillingMode, type Plan } from '@/lib/billing/entitlements';
import {
    recordPlanUpgraded,
    recordPlanDowngraded,
} from '@/lib/observability/business-metrics';
import { traceUsecase } from '@/lib/observability';
import { ValidationError, forbidden } from '@/lib/errors/types';

/** Monotonic plan rank — fixes the upgrade/downgrade direction. */
const PLAN_RANK: Record<Plan, number> = {
    FREE: 0,
    TRIAL: 1,
    PRO: 2,
    ENTERPRISE: 3,
};

export interface ChangeTenantPlanResult {
    fromPlan: Plan;
    toPlan: Plan;
    direction: 'upgraded' | 'downgraded' | 'unchanged';
}

/**
 * Change a tenant's billing plan. Reads the current plan, writes the
 * new one (read-modify-write in one transaction), audits, and records
 * the upgrade/downgrade KPI — AFTER the commit, so a rolled-back change
 * never emits the metric.
 */
export async function changeTenantPlan(
    ctx: RequestContext,
    newPlan: Plan,
): Promise<ChangeTenantPlanResult> {
    return traceUsecase('billing.changeTenantPlan', ctx, async () => {
        if (getBillingMode() !== 'SAAS') {
            throw forbidden(
                'Plan changes are unavailable in self-hosted mode (every tenant is ENTERPRISE).',
            );
        }
        if (!(newPlan in PLAN_RANK)) {
            throw new ValidationError(`Unknown billing plan: ${newPlan}`);
        }

        // BillingAccount is global (not RLS-scoped) but we go through
        // runInTenantContext for uniformity with the rest of the data
        // layer (mirrors getEffectivePlan). Read-modify-write is
        // sequential — acceptable for a rare operator action.
        const { fromPlan, direction } = await runInTenantContext(ctx, async (db) => {
            const existing = await db.billingAccount.findUnique({
                where: { tenantId: ctx.tenantId },
                select: { plan: true },
            });
            const current = (existing?.plan ?? 'FREE') as Plan;

            await db.billingAccount.upsert({
                where: { tenantId: ctx.tenantId },
                update: { plan: newPlan },
                create: {
                    tenantId: ctx.tenantId,
                    plan: newPlan,
                    // No Stripe in this deployment — a tenant that never
                    // went through checkout has no real customer id. Mint a
                    // unique sentinel so the (required, @unique) column is
                    // satisfied and the row is clearly non-Stripe-originated.
                    stripeCustomerId: `manual:${ctx.tenantId}`,
                },
            });

            const dir: ChangeTenantPlanResult['direction'] =
                PLAN_RANK[newPlan] > PLAN_RANK[current]
                    ? 'upgraded'
                    : PLAN_RANK[newPlan] < PLAN_RANK[current]
                      ? 'downgraded'
                      : 'unchanged';

            await logEvent(db, ctx, {
                action: 'TENANT_PLAN_CHANGED',
                entityType: 'BillingAccount',
                entityId: ctx.tenantId,
                details: `Plan ${dir}: ${current} → ${newPlan}`,
                detailsJson: {
                    category: 'status_change',
                    entityName: 'BillingAccount',
                    operation: 'plan_changed',
                    before: { plan: current },
                    after: { plan: newPlan },
                    direction: dir,
                    summary: `Plan ${dir}: ${current} → ${newPlan}`,
                },
            });

            return { fromPlan: current, direction: dir };
        });

        // Business KPI — only the directional changes (an idempotent
        // "set to same plan" is not a growth/churn signal).
        if (direction === 'upgraded') {
            recordPlanUpgraded({ fromPlan, toPlan: newPlan });
        } else if (direction === 'downgraded') {
            recordPlanDowngraded({ fromPlan, toPlan: newPlan });
        }

        return { fromPlan, toPlan: newPlan, direction };
    });
}
