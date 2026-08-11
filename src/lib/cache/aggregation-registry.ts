/**
 * Aggregation cache registry — the single source of truth for which
 * entities invalidate which dashboard/metric aggregation, and how long
 * each may go stale.
 *
 * Background. List reads are cached by `cachedListRead` keyed on a
 * single entity's version (`src/lib/cache/list-cache.ts`). Dashboards
 * are a different problem: each aggregates ACROSS several entities, so a
 * write to ANY of them must invalidate the cached aggregate. This
 * registry names that dependency graph; `cachedAggregationRead` composes
 * the version counters of every entity in `dependsOn` into one cache key,
 * so a `bumpEntityCacheVersion(ctx, <entity>)` on any dependency makes
 * the next aggregate read recompute.
 *
 * Invalidation correctness (the load-bearing invariant): every entity
 * listed in any `dependsOn` MUST be bumped by at least one usecase after
 * it mutates — otherwise the aggregate never refreshes when that entity
 * changes, except via the TTL safety net. The ratchet
 * `tests/guardrails/aggregation-cache-coverage.test.ts` enforces this.
 *
 * Entity names are the lowercase version-counter identifiers shared with
 * the list cache (a Control write bumps `'control'`, which invalidates
 * BOTH the controls list cache AND every aggregation that depends on
 * `'control'`). Sub-entities roll up to a coarse counter where the write
 * path already bumps it — e.g. a control↔evidence link bumps `'evidence'`
 * + `'control'`, so `controls-dashboard` depending on `'control'` +
 * `'evidence'` covers `ControlEvidence` writes without a separate counter.
 */

/** Version-counter identifiers an aggregation can depend on. */
export type AggregationEntity =
    | 'control'
    | 'risk'
    | 'evidence'
    | 'task'
    | 'test'
    | 'vendor'
    | 'audit'
    | 'lossEvent'
    | 'orgWidget';

export interface AggregationSpec {
    /** Entities whose version counters key this aggregation. A write to any invalidates it. */
    readonly dependsOn: ReadonlyArray<AggregationEntity>;
    /** Hard staleness cap. Even with no invalidating write, the entry expires after this. */
    readonly ttlSeconds: number;
    /**
     * Scope of the version counters + cache key. `'tenant'` keys on
     * `ctx.tenantId` (the common case); `'org'` keys on
     * `ctx.organizationId` (org-portfolio aggregations that span tenants).
     */
    readonly scope: 'tenant' | 'org';
}

/** Upper bound on any aggregation's TTL — a 10-minute-stale dashboard is the ceiling. */
export const MAX_AGGREGATION_TTL_SECONDS = 600;

/**
 * The aggregation registry. One entry per cached dashboard/metric route.
 * Keep `dependsOn` honest: list exactly the version counters that, when
 * bumped, must refresh this aggregate.
 */
export const AGGREGATIONS = {
    'controls-dashboard': {
        // getControlDashboard joins Control + ControlEvidence + ControlTest + Task.
        // ControlEvidence writes bump 'evidence' (+ 'control'); ControlTest writes bump 'test'.
        dependsOn: ['control', 'evidence', 'test', 'task'],
        ttlSeconds: 60,
        scope: 'tenant',
    },
    'risks-dashboard': {
        // getRiskDashboard reads Risk + its treatments/residuals/KRIs, all mutated via risk.ts (bumps 'risk').
        dependsOn: ['risk'],
        ttlSeconds: 60,
        scope: 'tenant',
    },
    'tests-dashboard': {
        // Test plans + runs + run-evidence — all mutated via the control-test / test-scheduling usecases (bump 'test').
        dependsOn: ['test'],
        ttlSeconds: 60,
        scope: 'tenant',
    },
    'vendors-metrics': {
        dependsOn: ['vendor'],
        ttlSeconds: 60,
        scope: 'tenant',
    },
    'tasks-metrics': {
        dependsOn: ['task'],
        ttlSeconds: 60,
        scope: 'tenant',
    },
    'audits-readiness-overview': {
        // getReadinessOverview aggregates control coverage + evidence + audit cycles/packs.
        dependsOn: ['control', 'evidence', 'audit'],
        ttlSeconds: 60,
        scope: 'tenant',
    },
    'loss-events-aggregate': {
        // Per-year / per-risk roll-up of LossEvent rows, sliced by risk.
        dependsOn: ['lossEvent', 'risk'],
        ttlSeconds: 120,
        scope: 'tenant',
    },
    'org-dashboard-widgets': {
        // User-configured widgets change rarely — longer TTL, single dependency, org-scoped.
        dependsOn: ['orgWidget'],
        ttlSeconds: 300,
        scope: 'org',
    },
} as const satisfies Record<string, AggregationSpec>;

export type AggregationName = keyof typeof AGGREGATIONS;
