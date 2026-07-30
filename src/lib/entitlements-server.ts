import prisma from '@/lib/prisma';
import { hasFeature, getRequiredPlan, FEATURE_LABELS, type FeatureKey } from './entitlements';
import type { BillingPlan } from '@prisma/client';

/**
 * Typed error thrown when a tenant's plan doesn't include a requested
 * feature. Replaces the previous pattern of mutating `Error` with
 * untyped `(error as { code?: string }).code = …` assignments. The route-layer
 * error mapper can now `instanceof EntitlementError` and pull the
 * fields type-safely.
 */
export class EntitlementError extends Error {
    readonly code = 'PLAN_REQUIRED' as const;
    readonly status = 403 as const;
    readonly requiredPlan: BillingPlan;
    readonly feature: FeatureKey;

    constructor(args: {
        message: string;
        requiredPlan: BillingPlan;
        feature: FeatureKey;
    }) {
        super(args.message);
        this.name = 'EntitlementError';
        this.requiredPlan = args.requiredPlan;
        this.feature = args.feature;
    }
}

// ─── Server-side tenant plan resolver ───

/**
 * Look up the current billing plan for a tenant.
 * Returns null if no billing account exists (billing not configured → ungated).
 * Returns the plan string if a billing account exists.
 */
export async function getTenantPlan(tenantId: string): Promise<BillingPlan | null> {
    const billingAccount = await prisma.billingAccount.findUnique({
        where: { tenantId },
        select: { plan: true },
    });
    return billingAccount?.plan ?? null;
}

/**
 * Server-side entitlement check.
 * If no billing account exists (plan is null), feature is ungated.
 * Throws an EntitlementError if the tenant's plan doesn't include the feature.
 */
export async function requireFeature(tenantId: string, feature: FeatureKey): Promise<void> {
    const plan = await getTenantPlan(tenantId);
    // No billing configured → all features available
    if (!plan) return;
    if (!hasFeature(plan, feature)) {
        const requiredPlan = getRequiredPlan(feature);
        throw new EntitlementError({
            message: `Feature "${FEATURE_LABELS[feature]}" requires the ${requiredPlan} plan or higher. Current plan: ${plan}.`,
            requiredPlan,
            feature,
        });
    }
}

/**
 * Boolean form of `requireFeature`, for callers that must BRANCH rather than
 * throw — a server component deciding whether to render or redirect.
 *
 * Same semantics: no billing account configured means every feature is
 * available (self-hosted mode), so this returns true.
 */
export async function hasFeatureForTenant(tenantId: string, feature: FeatureKey): Promise<boolean> {
    const plan = await getTenantPlan(tenantId);
    if (!plan) return true;
    return hasFeature(plan, feature);
}

/**
 * List recent billing events for a tenant.
 * Server-side only — delegates the Prisma call away from route handlers.
 */
export async function listBillingEvents(tenantId: string, limit = 20) {
    return prisma.billingEvent.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
            id: true,
            type: true,
            stripeEventId: true,
            createdAt: true,
        },
    });
}
