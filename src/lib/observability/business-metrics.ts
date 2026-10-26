/**
 * Business-level KPI metrics.
 *
 * Where `metrics.ts` emits INFRASTRUCTURE signals (HTTP rates, repo
 * durations, job counters, audit-stream delivery), this module emits
 * PRODUCT signals — tenant growth, onboarding funnel, feature adoption,
 * plan mix. It answers "how many tenants signed up this week?", "what %
 * of new tenants finished onboarding?", "which features get traction?".
 *
 * It reuses the SAME single meter (`inflect-compliance`) as `metrics.ts`
 * — no new instrumentation surface. Each metric is lazily created on
 * first record (so importing this module is free) and recorded ONCE at
 * the owning usecase boundary, AFTER the mutation commits (mirroring the
 * audit-log write — a rolled-back mutation must not emit the metric).
 *
 * ─── CARDINALITY DISCIPLINE (load-bearing) ───────────────────────────
 *   - `tenant.id` is NEVER a label. Inherited from the Epic OI-3
 *     repo-tracing convention (see `metrics.ts`). Per-tenant detail is
 *     the admin panel's job, not Grafana's.
 *   - `plan` IS a label — 4 bounded enum values (FREE/TRIAL/PRO/
 *     ENTERPRISE).
 *   - `signupSource`, `step`, `frameworkKey`, `resource`, `method`,
 *     `source`, `reason` are all bounded enums — fine.
 *   - Duration labels are PRE-ROUNDED bucket strings
 *     (`lt_1h`/`lt_1d`/`lt_1w`/`gt_1w`) via {@link bucketTimeTo} —
 *     NEVER raw durations.
 *
 * See docs/observability/06-business-kpis.md for the canonical
 * catalogue, the DAU/MAU definition, and how to add a new metric.
 *
 * @module lib/observability/business-metrics
 */
import { metrics } from '@opentelemetry/api';
import { bindObservable } from './observable-registry';

/** Reuse the app's single meter — no new instrumentation surface. */
const METER_NAME = 'inflect-compliance';
function getMeter() {
    return metrics.getMeter(METER_NAME);
}

/**
 * Canonical list of every business metric name. The coverage ratchet
 * (`tests/guardrails/business-metrics-coverage.test.ts`) imports this
 * as the single source of truth — adding a metric means adding it here
 * AND wiring + dashboard + doc, in that order.
 */
export const BUSINESS_METRIC_NAMES = [
    // Tenant growth
    'business.tenant.created',
    'business.tenant.deleted',
    'business.tenant.active.daily',
    'business.tenant.active.monthly',
    // Membership / users
    'business.user.signup',
    'business.invite.sent',
    'business.invite.redeemed',
    'business.user.mfa.enrolled',
    // Onboarding funnel
    'business.onboarding.step.completed',
    'business.onboarding.completed',
    'business.onboarding.abandoned',
    // Feature adoption
    'business.framework.installed',
    'business.policy.published',
    'business.audit.cycle.started',
    'business.audit.pack.shared',
    'business.risk.created',
    'business.control.created',
    'business.automation.rule.created',
    // Billing
    'business.plan.upgraded',
    'business.plan.downgraded',
    'business.plan.limit.hit',
] as const;

// ─── Bounded enum types (documentation + compile-time guard) ──────────

export type Plan = 'FREE' | 'TRIAL' | 'PRO' | 'ENTERPRISE';
export type SignupSource =
    | 'oauth_google'
    | 'oauth_microsoft'
    | 'saml'
    | 'credentials'
    | 'invite';
export type RiskSource = 'manual' | 'imported' | 'ai_generated';
export type ControlSource = 'manual' | 'library' | 'framework_install';
export type MfaMethod = 'totp' | 'webauthn';
export type LimitResource = 'control' | 'risk' | 'user' | 'automation_rule';

/** Pre-rounded duration buckets — the ONLY allowed time-label values. */
export type TimeBucket = 'lt_1h' | 'lt_1d' | 'lt_1w' | 'gt_1w';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * Round a raw duration (ms) into a bounded bucket string. This is the
 * ONLY way a duration ever becomes a metric label — raw durations would
 * explode cardinality.
 */
export function bucketTimeTo(ms: number): TimeBucket {
    if (ms < HOUR_MS) return 'lt_1h';
    if (ms < DAY_MS) return 'lt_1d';
    if (ms < WEEK_MS) return 'lt_1w';
    return 'gt_1w';
}

// ════════════════════════════════════════════════════════════════════
// COUNTERS — lazy singletons + a record* function each.
// ════════════════════════════════════════════════════════════════════

type Counter = ReturnType<ReturnType<typeof getMeter>['createCounter']>;
const _counters = new Map<string, Counter>();

/** Lazily create (once) and return the named counter. */
function counter(name: string, description: string): Counter {
    let c = _counters.get(name);
    if (!c) {
        c = getMeter().createCounter(name, { description, unit: '1' });
        _counters.set(name, c);
    }
    return c;
}

// ─── Tenant growth ───

export function recordTenantCreated(attrs: { plan: Plan; signupSource: string }): void {
    counter('business.tenant.created', 'Tenants created').add(1, {
        plan: attrs.plan,
        'signup.source': attrs.signupSource,
    });
}

export function recordTenantDeleted(attrs: { plan: Plan; reason: string }): void {
    counter('business.tenant.deleted', 'Tenants deleted').add(1, {
        plan: attrs.plan,
        reason: attrs.reason,
    });
}

// ─── Membership / users ───

export function recordUserSignup(attrs: { signupSource: SignupSource }): void {
    counter('business.user.signup', 'User signups').add(1, {
        'signup.source': attrs.signupSource,
    });
}

export function recordInviteSent(): void {
    counter('business.invite.sent', 'Invites sent').add(1);
}

export function recordInviteRedeemed(attrs: { timeToAcceptMs: number }): void {
    counter('business.invite.redeemed', 'Invites redeemed').add(1, {
        'time_to_accept.bucket': bucketTimeTo(attrs.timeToAcceptMs),
    });
}

export function recordMfaEnrolled(attrs: { method: MfaMethod }): void {
    counter('business.user.mfa.enrolled', 'MFA enrolments').add(1, {
        method: attrs.method,
    });
}

// ─── Onboarding funnel ───

export function recordOnboardingStepCompleted(attrs: { step: string }): void {
    counter('business.onboarding.step.completed', 'Onboarding steps completed').add(1, {
        step: attrs.step,
    });
}

export function recordOnboardingCompleted(attrs: { timeToCompleteMs: number }): void {
    counter('business.onboarding.completed', 'Onboardings completed').add(1, {
        'time_to_complete.bucket': bucketTimeTo(attrs.timeToCompleteMs),
    });
}

export function recordOnboardingAbandoned(attrs: { lastStepReached: string }): void {
    counter('business.onboarding.abandoned', 'Onboardings abandoned').add(1, {
        'last_step_reached': attrs.lastStepReached,
    });
}

// ─── Feature adoption ───

export function recordFrameworkInstalled(attrs: { frameworkKey: string; plan: Plan }): void {
    counter('business.framework.installed', 'Frameworks installed').add(1, {
        'framework.key': attrs.frameworkKey,
        plan: attrs.plan,
    });
}

export function recordPolicyPublished(): void {
    counter('business.policy.published', 'Policies published').add(1);
}

export function recordAuditCycleStarted(): void {
    counter('business.audit.cycle.started', 'Audit cycles started').add(1);
}

export function recordAuditPackShared(): void {
    counter('business.audit.pack.shared', 'Audit packs shared').add(1);
}

export function recordRiskCreated(attrs: { source: RiskSource }): void {
    counter('business.risk.created', 'Risks created').add(1, {
        source: attrs.source,
    });
}

export function recordControlCreated(attrs: { source: ControlSource }): void {
    counter('business.control.created', 'Controls created').add(1, {
        source: attrs.source,
    });
}

export function recordAutomationRuleCreated(): void {
    counter('business.automation.rule.created', 'Automation rules created').add(1);
}

// ─── Billing ───

export function recordPlanUpgraded(attrs: { fromPlan: Plan; toPlan: Plan }): void {
    counter('business.plan.upgraded', 'Plan upgrades').add(1, {
        'from.plan': attrs.fromPlan,
        'to.plan': attrs.toPlan,
    });
}

export function recordPlanDowngraded(attrs: { fromPlan: Plan; toPlan: Plan }): void {
    counter('business.plan.downgraded', 'Plan downgrades').add(1, {
        'from.plan': attrs.fromPlan,
        'to.plan': attrs.toPlan,
    });
}

export function recordPlanLimitHit(attrs: { resource: LimitResource }): void {
    counter('business.plan.limit.hit', 'Plan-limit hits').add(1, {
        resource: attrs.resource,
    });
}

// ════════════════════════════════════════════════════════════════════
// OBSERVABLE GAUGES — active users (DAU / MAU), grouped by plan.
//
// The metric names are `business.tenant.active.{daily,monthly}`; the
// VALUE is the count of DISTINCT users who made ≥1 audit-logged action
// in the rolling window (24h daily / 30d monthly), grouped by their
// tenant's plan. See docs/observability/06-business-kpis.md for the
// precise provenance definition.
//
// The expensive DISTINCT aggregation runs on a 5-minute cadence in the
// `dau-mau-aggregator` job, which calls `setActiveUserSnapshot(...)`.
// The observable-gauge callbacks read that cached snapshot at scrape
// time — decoupling the DB cost (5-min) from the scrape cadence.
// ════════════════════════════════════════════════════════════════════

export interface ActiveUserSnapshot {
    /** plan → distinct active users in the last 24h. */
    daily: Record<string, number>;
    /** plan → distinct active users in the last 30d. */
    monthly: Record<string, number>;
    /** epoch ms of the last refresh (0 = never). */
    updatedAt: number;
}

let _activeSnapshot: ActiveUserSnapshot = { daily: {}, monthly: {}, updatedAt: 0 };

/** Replace the active-user snapshot the gauges report (called by the job). */
export function setActiveUserSnapshot(snapshot: ActiveUserSnapshot): void {
    _activeSnapshot = snapshot;
}

/** Read the latest snapshot (for the job's diffing / tests). */
export function getActiveUserSnapshot(): ActiveUserSnapshot {
    return _activeSnapshot;
}

let _gaugesStarted = false;

/**
 * Register the DAU / MAU observable gauges. Call once from the
 * worker/scheduler entrypoint (alongside `startQueueDepthReporting`).
 * Idempotent. The callbacks read the cached snapshot, so they are cheap
 * even under frequent scraping.
 */
export function startActiveUserGauges(): void {
    if (_gaugesStarted) return;
    _gaugesStarted = true;

    bindObservable(() => {
        const daily = getMeter().createObservableGauge('business.tenant.active.daily', {
            description: 'Distinct active users in the last 24h, by plan',
            unit: '1',
        });
        daily.addCallback((result) => {
            for (const [plan, count] of Object.entries(_activeSnapshot.daily)) {
                result.observe(count, { plan });
            }
        });

        const monthly = getMeter().createObservableGauge('business.tenant.active.monthly', {
            description: 'Distinct active users in the last 30d, by plan',
            unit: '1',
        });
        monthly.addCallback((result) => {
            for (const [plan, count] of Object.entries(_activeSnapshot.monthly)) {
                result.observe(count, { plan });
            }
        });
    });
}

/** Reset gauge + snapshot state (testing only). @internal */
export function _resetBusinessMetricsForTesting(): void {
    _gaugesStarted = false;
    _activeSnapshot = { daily: {}, monthly: {}, updatedAt: 0 };
    _counters.clear();
}
