/**
 * GAP-18 — Plan-entitlement evaluation and enforcement.
 *
 * The full operator + developer runbook is in `docs/billing.md`.
 * This docblock is the inline summary; deviations from it should
 * be reflected in both places.
 *
 * Two responsibilities:
 *
 *   1. Decide what plan a tenant is currently entitled to. The
 *      decision branches on billing mode:
 *
 *        • SAAS mode      — STRIPE_SECRET_KEY is configured, so
 *                            the deployment is the hosted product.
 *                            The effective plan is read from
 *                            `BillingAccount.plan` (FREE/TRIAL/PRO/
 *                            ENTERPRISE). A tenant with no
 *                            BillingAccount row is treated as FREE
 *                            — that's the safe default for a SaaS
 *                            tenant that hasn't started a subscription.
 *
 *        • SELFHOSTED mode — STRIPE_SECRET_KEY is NOT configured,
 *                            so the deployment is on-prem / OSS.
 *                            Every tenant resolves to ENTERPRISE
 *                            (unlimited). Self-hosted customers
 *                            paid for the right to run the software;
 *                            they did not buy a SaaS subscription.
 *
 *      The mode decision is deterministic per process — read once
 *      at module load, no per-request env scan. There is no
 *      runtime flip; restart the process to change modes.
 *
 *   2. Enforce per-plan resource limits at the mutation boundary.
 *      `assertWithinLimit(ctx, resource)` throws a typed
 *      `forbidden(...)` error when the tenant has reached the
 *      cap for `resource` under its effective plan. Reusable —
 *      adding a new gated resource is one entry in `PLAN_LIMITS`,
 *      one `switch` arm in `getCurrentCount`, and one
 *      `assertWithinLimit` call at the create site.
 *
 * NON-GOALS in this module:
 *   • UI gating — the UI is welcome to render upgrade CTAs derived
 *     from the same evaluation, but enforcement must live behind
 *     the API. The UI is advisory; this layer is authoritative.
 *   • Stripe checkout / portal logic — that lives in `src/lib/stripe.ts`.
 *   • Subscription lifecycle hooks — those live in the webhook
 *     handler and write `BillingAccount.plan`. This module READS
 *     that value; it does not write it. Status (CANCELED, PAST_DUE,
 *     …) is also intentionally NOT factored in here — second-
 *     guessing the webhook would race with it and produce confusing
 *     user-facing failures.
 */
import type { RequestContext } from '@/app-layer/types';
import { runInTenantContext } from '@/lib/db-context';
import { forbidden } from '@/lib/errors/types';
import { recordPlanLimitHit } from '@/lib/observability/business-metrics';

// ─── Types ───────────────────────────────────────────────────────

/**
 * The four plans recognised by the codebase. Mirrors the Prisma
 * `BillingPlan` enum but expressed as a TypeScript string union so
 * the entitlement code does not need a runtime dependency on the
 * generated Prisma client (lets unit tests run without Prisma init).
 */
export type Plan = 'FREE' | 'TRIAL' | 'PRO' | 'ENTERPRISE';

/**
 * Operating modes — derived from environment, not stored.
 */
// The definition moved to `billing-mode.ts` so the SSRF egress guard can read
// it without pulling Prisma in (#3328). IMPORTED as well as re-exported:
// `export { x } from './y'` forwards the name to consumers but does NOT bind
// it locally, and this module CALLS it (see `getEffectivePlan`). Every
// existing caller still imports it from here and is unaffected.
import { getBillingMode, type BillingMode } from './billing-mode';

export { getBillingMode, type BillingMode };

/**
 * Resources that have a per-plan numeric cap. Adding a new entry
 * here implies (a) updating PLAN_LIMITS and (b) calling
 * `assertWithinLimit(ctx, '<resource>')` at the resource's create
 * site.
 */
export type GatedResource = 'control';

/**
 * Numeric cap by (plan, resource). `null` means unlimited.
 *
 * Numbers chosen to match the documented free-tier evaluation
 * surface: 10 controls is a meaningful "kick the tyres" budget
 * (enough to map a couple of policy areas) without enabling a
 * full ISO 27001 implementation, which is the upgrade trigger.
 *
 * TRIAL inherits PRO — a paying-customer-on-trial gets the full
 * working surface, not an artificially constrained one.
 */
const PLAN_LIMITS: Record<Plan, Record<GatedResource, number | null>> = {
    FREE: { control: 10 },
    TRIAL: { control: 100 },
    PRO: { control: 100 },
    ENTERPRISE: { control: null },
};

// ─── Mode decision ───────────────────────────────────────────────

// ─── Plan resolution ─────────────────────────────────────────────

/**
 * The effective plan for a tenant. Always one of the Plan values
 * — never null, never undefined.
 *
 *   • SELFHOSTED → ENTERPRISE (unlimited).
 *   • SAAS without a BillingAccount row → FREE (the tenant exists
 *     but has not started a paid subscription).
 *   • SAAS with a BillingAccount row → row's `plan`.
 *
 * Status (CANCELED, PAST_DUE, …) is INTENTIONALLY NOT YET ENFORCED
 * here — a CANCELED PRO tenant still resolves to PRO until the
 * subscription end date. The webhook handler is responsible for
 * downgrading the row to FREE when the period ends. Trying to
 * second-guess that here would race with the webhook and produce
 * confusing user-facing failures.
 */
export async function getEffectivePlan(ctx: RequestContext): Promise<Plan> {
    if (getBillingMode() === 'SELFHOSTED') return 'ENTERPRISE';

    return runInTenantContext(ctx, async (db) => {
        // BillingAccount is global (not RLS-scoped) so a runtime
        // tenant context is not strictly required — but using
        // runInTenantContext keeps the function signature uniform
        // with the rest of the data layer.

        const account = await db.billingAccount.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { plan: true },
        });
        return ((account?.plan ?? 'FREE') as Plan);
    });
}

// ─── Limit lookup ────────────────────────────────────────────────

export function getLimit(plan: Plan, resource: GatedResource): number | null {
    return PLAN_LIMITS[plan][resource];
}

/**
 * The current count of `resource` for the tenant — used by the
 * limit assertion. Soft-deleted rows are excluded so a tenant that
 * deleted some controls can immediately create new ones again.
 */
async function getCurrentCount(
    ctx: RequestContext,
    resource: GatedResource,
): Promise<number> {
    return runInTenantContext(ctx, async (db) => {
        if (resource === 'control') {
            return db.control.count({
                where: { tenantId: ctx.tenantId, deletedAt: null },
            });
        }
        // Exhaustive — TypeScript will flag any new GatedResource
        // value that isn't handled above.
        const _exhaustive: never = resource;
        return _exhaustive;
    });
}

// ─── Enforcement ─────────────────────────────────────────────────

/**
 * Throws `forbidden(...)` if the tenant cannot create one more
 * `resource` under its effective plan. Call BEFORE the
 * `db.<resource>.create({...})` line.
 *
 * The thrown error is the same `ForbiddenError` shape used by the
 * rest of the codebase, so `withApiErrorHandling` surfaces it as a
 * 403 without any new error-type plumbing. The message body
 * embeds `plan_limit_exceeded` + plan + resource + limit + current
 * so the billing UI can parse it into an "Upgrade" CTA.
 */
export async function assertWithinLimit(
    ctx: RequestContext,
    resource: GatedResource,
): Promise<void> {
    const plan = await getEffectivePlan(ctx);
    const limit = getLimit(plan, resource);
    if (limit === null) return; // unlimited

    const current = await getCurrentCount(ctx, resource);
    if (current >= limit) {
        // Business KPI — fires only when the cap is actually hit.
        recordPlanLimitHit({ resource: resource as 'control' });
        // Surface as `forbidden` so `withApiErrorHandling` returns
        // 403. The message embeds plan + resource + limit so the
        // billing UI can parse it into an "Upgrade" CTA without
        // adding a new error type / shape to the API contract.
        throw forbidden(
            `plan_limit_exceeded: ${plan} plan allows ${limit} ${resource}(s); ` +
                `tenant currently has ${current}. Upgrade to add more.`,
        );
    }
}
