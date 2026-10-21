/**
 * AI Risk Assessment — Feature Gate
 *
 * Controls access to AI features based on:
 * 1. Global feature flag (env: AI_RISK_ENABLED) — master kill switch
 * 2. Per-feature enable flag (GAP-2) — disable one feature in isolation
 * 3. Role-based access (admin/editor only)
 * 4. Optional plan-based gating (env: AI_RISK_PLAN_REQUIRED)
 *
 * Gates 1-3 are synchronous (env + role). Gate 4 needs the tenant's
 * effective billing plan, which is a DB read — so the AUTHORITATIVE
 * entry point is the Promise-returning `enforceFeatureGate`.
 * `checkFeatureGate` remains synchronous and evaluates gates 1-3 only;
 * it is an advisory pre-check, never the enforcement seam.
 */
import { forbidden } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';
import { env } from '@/env';
import { runInTenantContext } from '@/lib/db-context';
import { AI_MASTER_COLUMN, columnForFeature } from './tenant-toggle-columns';
import { logger } from '@/lib/observability/logger';

// ─── Configuration ───

/** Global kill switch for ALL AI features. Set to 'false' to disable. */
const AI_RISK_ENABLED = (env.AI_RISK_ENABLED ?? 'true').toLowerCase() !== 'false';

const isOn = (raw: string | undefined) => (raw ?? 'true').toLowerCase() !== 'false';

/**
 * The AI features that carry an independent enable flag. Each flag is
 * ANDed with the global `AI_RISK_ENABLED` master switch, so an operator
 * can turn off (say) the assistant while leaving risk suggestions on.
 */
export type AiFeature = 'risk' | 'assistant' | 'questionnaire';

/** Per-feature enable flags (GAP-2). Each defaults ON. */
const FEATURE_ENABLED: Readonly<Record<AiFeature, boolean>> = {
    risk: isOn(env.AI_RISK_SUGGESTIONS_ENABLED),
    assistant: isOn(env.AI_ASSISTANT_ENABLED),
    questionnaire: isOn(env.AI_QUESTIONNAIRE_ENABLED),
};

const FEATURE_LABEL: Readonly<Record<AiFeature, string>> = {
    risk: 'AI risk assessment',
    assistant: 'the AI assistant',
    questionnaire: 'AI questionnaire autofill',
};

/**
 * If set, the AI features require this plan tier or higher.
 * Values: 'free' | 'trial' | 'pro' | 'enterprise', or empty (no plan gating).
 *
 * Empty (the default) short-circuits the plan gate entirely — no DB read,
 * no behaviour change for any deployment that has not opted in.
 */
const AI_RISK_PLAN_REQUIRED = (env.AI_RISK_PLAN_REQUIRED ?? '').trim();

/**
 * Plan ladder, mirroring `PLAN_LEVEL` in `src/lib/entitlements.ts`.
 * A tenant is entitled when its own level is >= the required level.
 */
const PLAN_LEVEL: Readonly<Record<string, number>> = {
    FREE: 0,
    TRIAL: 1,
    PRO: 2,
    ENTERPRISE: 3,
};

/** Required level, resolved once. `null` = the env value names no known plan. */
const REQUIRED_PLAN_LEVEL: number | null = AI_RISK_PLAN_REQUIRED
    ? (PLAN_LEVEL[AI_RISK_PLAN_REQUIRED.toUpperCase()] ?? null)
    : null;

// ─── Feature Gate ───

export interface FeatureGateResult {
    allowed: boolean;
    reason?: string;
}

/**
 * Check whether AI risk assessment is available for this context.
 * Returns { allowed: true } if all gates pass, or { allowed: false, reason } if blocked.
 */

/**
 * AISVS C5.2.1 (L2) — DEFAULT-DENY ALLOW-LIST.
 *
 * Access to the AI resource is denied by default and granted ONLY when EVERY
 * allow-list predicate below passes (logical AND). Adding a capability requires
 * adding a predicate here — there is no implicit-allow path. Each predicate
 * returns a deny `reason` when it fails; reaching the end of the list is the
 * only way to `allowed: true`.
 */
const AI_ACCESS_ALLOWLIST: ReadonlyArray<(ctx: RequestContext, feature: AiFeature) => FeatureGateResult> = [
    // 1. Global master switch must be on (kill switch for ALL AI features).
    () =>
        AI_RISK_ENABLED
            ? { allowed: true }
            : { allowed: false, reason: 'AI features are currently disabled' },
    // 2. The specific feature's enable flag must be on (GAP-2).
    (_ctx, feature) =>
        FEATURE_ENABLED[feature]
            ? { allowed: true }
            : { allowed: false, reason: `${FEATURE_LABEL[feature]} is currently disabled` },
    // 3. Caller must hold the write capability (Editor / Admin / Owner).
    (ctx) =>
        ctx.permissions.canWrite
            ? { allowed: true }
            : { allowed: false, reason: 'AI features require Editor or Admin role' },
    // Gate 4 (plan entitlement) is NOT in this list: it needs an async
    // plan resolution. It runs in `checkFeatureGateWithPlan` /
    // `enforceFeatureGate`, AFTER every predicate here has passed.
];

/**
 * Is this feature's ENV kill switch on?
 *
 * Distinct from `checkFeatureGate`, which also weighs the tenant's plan and
 * the access allowlist and therefore needs a `RequestContext`. A layout
 * deciding whether to render a button has no context to spare — resolving one
 * would mean a database round trip on every page render.
 *
 * The split is deliberate rather than a shortcut, and it decides two
 * different questions:
 *   - KILL SWITCH OFF → the surface should not exist. Rendering a button that
 *     always errors is worse than no button.
 *   - PLAN-GATED → the surface exists and the refusal explains why. Hiding it
 *     would leave the user unable to discover a feature they could buy, and
 *     the refusal path already states its reason (#3849).
 */
export function isAiFeatureEnabled(feature: AiFeature): boolean {
    return FEATURE_ENABLED[feature];
}

export function checkFeatureGate(ctx: RequestContext, feature: AiFeature = 'risk'): FeatureGateResult {
    // Default-deny: return the FIRST failing predicate's reason; reaching the
    // end (every predicate passed) is the only allow path.
    for (const predicate of AI_ACCESS_ALLOWLIST) {
        const result = predicate(ctx, feature);
        if (!result.allowed) return result;
    }
    return { allowed: true };
}

/**
 * The full gate: the synchronous predicates above PLUS the plan
 * entitlement (gate 4), which needs a DB-backed plan resolution.
 *
 * When `AI_RISK_PLAN_REQUIRED` is empty — the default — this is exactly
 * `checkFeatureGate` with no additional work and no DB read.
 */
/**
 * The PER-TENANT half of the gate — the part an admin can flip from the UI.
 *
 * ═══ WHY THIS IS AND-ED WITH THE ENV, NEVER INSTEAD OF IT ═══
 *
 *   effective = env_global AND env_feature AND tenant_master AND tenant_feature
 *
 * The env flags stay able to force OFF because they are the kill switch: a
 * tenant row that could override an env `false` would leave an operator no way
 * to stop AI without a deploy. So this function can only ever REFUSE something
 * the env already allowed.
 *
 * ═══ IT FAILS CLOSED, AND THAT IS THE UNUSUAL CHOICE ═══
 *
 * `resolveModeForTenant` in `ai/guard` defaults to `balanced` when its read
 * fails, because a guard that cannot read its mode should still guard. This
 * refuses instead, and the asymmetry is deliberate: the two answer different
 * questions.
 *
 * A tenant turns AI off for reasons that are frequently contractual — no model
 * processing of their data at all. Running a model for them because a row was
 * briefly unreadable is a governance breach that cannot be undone; refusing for
 * the same moment is a feature that looks down. Of the two, the recoverable one
 * is the right failure.
 *
 * It is also the only direction consistent with the allowlist above, which is
 * default-deny by construction — "every predicate must pass" cannot mean "or
 * error".
 */
async function checkTenantToggle(
    ctx: RequestContext,
    feature: AiFeature,
): Promise<FeatureGateResult> {
    const column = columnForFeature(feature);
    try {
        const row = await runInTenantContext(ctx, (db) =>
            db.tenantSecuritySettings.findUnique({
                where: { tenantId: ctx.tenantId },
                select: { [AI_MASTER_COLUMN]: true, [column]: true } as Record<string, true>,
            }),
        );
        // NO ROW is not a refusal. A tenant that has never opened the settings
        // page has no row, and the schema defaults are all `true` — so the
        // absence means "inherits whatever env allows", which is what the
        // column defaults say.
        if (row === null) return { allowed: true };

        const settings = row as unknown as Record<string, boolean>;
        if (settings[AI_MASTER_COLUMN] === false) {
            return { allowed: false, reason: 'AI features are turned off for this workspace' };
        }
        if (settings[column] === false) {
            return {
                allowed: false,
                reason: `${FEATURE_LABEL[feature]} is turned off for this workspace`,
            };
        }
        return { allowed: true };
    } catch (err) {
        logger.warn('ai-feature-gate: tenant toggle read failed, refusing', {
            requestId: ctx.requestId,
            tenantId: ctx.tenantId,
            feature,
            error: err instanceof Error ? err.message : String(err),
        });
        return {
            allowed: false,
            reason: 'AI availability could not be confirmed for this workspace',
        };
    }
}

export async function checkFeatureGateWithPlan(
    ctx: RequestContext,
    feature: AiFeature = 'risk',
): Promise<FeatureGateResult> {
    const sync = checkFeatureGate(ctx, feature);
    if (!sync.allowed) return sync;
    // The per-tenant toggles, which run ALWAYS — unlike the plan gate, they are
    // not conditional on an env opt-in.
    const tenant = await checkTenantToggle(ctx, feature);
    if (!tenant.allowed) return tenant;
    if (!AI_RISK_PLAN_REQUIRED) return { allowed: true };
    return checkPlanEntitlement(ctx);
}

/**
 * Enforce the feature gate — rejects with `forbidden` if not allowed.
 *
 * @param feature — which AI feature is being gated (defaults to 'risk'
 *   for backward compatibility). Each feature carries an independent
 *   enable flag ANDed with the global master switch.
 *
 * Deliberately NOT an `async function`. The synchronous gates (flag +
 * role) throw SYNCHRONOUSLY, so a caller that forgets `await` still gets
 * exactly the enforcement this function had before the plan gate
 * existed — a missing `await` can never make the gate weaker than it
 * was. Only the plan gate rides on the returned Promise.
 */
export async function enforceFeatureGate(
    ctx: RequestContext,
    feature: AiFeature = 'risk',
): Promise<void> {
    // `async` now rather than a hand-rolled promise chain: the per-tenant
    // toggle below is a database read that runs on EVERY call, so the
    // `Promise.resolve()` fast path this used to take no longer exists.
    const result = await checkFeatureGateWithPlan(ctx, feature);
    if (!result.allowed) {
        throw forbidden(result.reason ?? 'This AI feature is not available');
    }
}

/**
 * Gate 4 — plan entitlement for the tenant.
 *
 * Only reached when the operator set `AI_RISK_PLAN_REQUIRED`. It resolves
 * the tenant's effective plan through the SAME seam the rest of billing
 * uses (`getEffectivePlan` in `@/lib/billing/entitlements`), so the two
 * documented modes carry through unchanged (see `docs/billing.md`):
 *
 *   • SELF-HOSTED (`STRIPE_SECRET_KEY` unset) — every tenant resolves to
 *     ENTERPRISE with no DB read, so this gate ALWAYS allows. Turning on
 *     `AI_RISK_PLAN_REQUIRED` on a self-hosted deployment must not start
 *     refusing anybody.
 *   • SAAS (`STRIPE_SECRET_KEY` set) — the plan comes from
 *     `BillingAccount.plan`, defaulting to FREE for a tenant with no row.
 *
 * FAIL-CLOSED in two places, because this is an entitlement check and the
 * wrong default for one is "allow":
 *   1. the env var names no known plan (operator typo) — refuse rather
 *      than silently ignore the setting;
 *   2. plan resolution throws (DB down, import failure) — refuse.
 *
 * The billing module is imported lazily so a deployment that has NOT
 * opted into plan gating pays no import cost and pulls no DB client into
 * the AI path.
 */
async function checkPlanEntitlement(ctx: RequestContext): Promise<FeatureGateResult> {
    if (REQUIRED_PLAN_LEVEL === null) {
        // Fail closed: the operator asked for gating we cannot interpret.
        return {
            allowed: false,
            reason: 'AI features are gated by plan, but the required plan is misconfigured',
        };
    }

    let plan: string;
    try {
        const { getEffectivePlan } = await import('@/lib/billing/entitlements');
        plan = await getEffectivePlan(ctx);
    } catch {
        // Fail closed: an entitlement check that cannot resolve must refuse.
        return {
            allowed: false,
            reason: 'AI features are unavailable while the plan could not be verified',
        };
    }

    const level = PLAN_LEVEL[plan.toUpperCase()] ?? -1;
    if (level < REQUIRED_PLAN_LEVEL) {
        return {
            allowed: false,
            reason: `AI features require the ${AI_RISK_PLAN_REQUIRED.toUpperCase()} plan or higher (current plan: ${plan})`,
        };
    }
    return { allowed: true };
}

/**
 * Check if AI risk assessment is enabled globally.
 * Useful for UI to conditionally show/hide entry points.
 */
export function isAIRiskEnabled(): boolean {
    return AI_RISK_ENABLED;
}

/**
 * Get the required plan for AI risk features (empty if no plan required).
 */
export function getRequiredPlan(): string {
    return AI_RISK_PLAN_REQUIRED;
}
