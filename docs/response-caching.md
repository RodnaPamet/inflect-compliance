# Response caching

Three Redis-backed caches sit in front of the hottest read paths. All are
**tenant/scope-scoped, version-invalidated, fail-open**, and bypass
cleanly when `REDIS_URL` is unset (dev/test behave as if uncached).

| Cache | Module | Caches | Key scope |
|-------|--------|--------|-----------|
| **List cache** | `src/lib/cache/list-cache.ts` (`cachedListRead`) | single-entity list reads (controls, risks, evidence, tasks) | tenant + entity-version + filter hash |
| **Aggregation cache** | `src/lib/cache/aggregation-cache.ts` (`cachedAggregationRead`) | cross-entity dashboard / metric aggregations | scope (tenant **or** org) + composed entity-versions + param hash |
| **SSR payload cache** | `src/lib/cache/ssr-cache.ts` (`cachedSsrPayload`) | server-component page data fetches (dashboard + entity list pages) | tenant + route + **tenant-wide** version |

This document is the source of truth for the **aggregation** and **SSR**
caches. The list cache is documented inline in its module.

## The aggregation registry

`src/lib/cache/aggregation-registry.ts` (`AGGREGATIONS`) is the canonical
reference for **what invalidates what**. Each entry maps an aggregation
to the entity version-counters it depends on and its staleness ceiling:

| Aggregation | Route | `dependsOn` | TTL | Scope |
|-------------|-------|-------------|-----|-------|
| `controls-dashboard` | `controls/dashboard` | control, evidence, test, task | 60s | tenant |
| `risks-dashboard` | `risks/dashboard` | risk | 60s | tenant |
| `tests-dashboard` | `tests/dashboard` | test | 60s | tenant |
| `vendors-metrics` | `vendors/metrics` | vendor | 60s | tenant |
| `tasks-metrics` | `tasks/metrics` | task | 60s | tenant |
| `issues-metrics` | `issues/metrics` | task | 60s | tenant |
| `audits-readiness-overview` | `audits/readiness/overview` | control, evidence, audit | 60s | tenant |
| `loss-events-aggregate` | `loss-events/aggregate` | lossEvent, risk | 120s | tenant |
| `org-dashboard-widgets` | `org/.../dashboard/widgets` | orgWidget | 300s | org |

`dependsOn` lists the **version counters** the aggregation keys on, not
necessarily one counter per table. Sub-entities roll up to a coarse
counter where the write path already bumps it — e.g. a control↔evidence
link bumps `evidence` (+ `control`), so `controls-dashboard` depending on
`control` + `evidence` covers `ControlEvidence` writes without a separate
counter.

## Staleness contract

- An aggregation is cached for at most its TTL (default 60s). A write to
  any `dependsOn` entity invalidates it **immediately** by bumping that
  entity's version counter — the composed cache key changes, so the next
  read recomputes.
- A user who creates a Control and then views the controls dashboard
  sees the new count: the create path calls
  `bumpEntityCacheVersion(ctx, 'control')`, which the dashboard key
  depends on.
- A **second** user (different session, same tenant) viewing the
  dashboard in the same second sees the bumped version too — the key is
  scope-scoped (tenant or org), **not** user-scoped.
- The one failure mode is a write that does not bump. The ratchet
  `tests/guardrails/aggregation-cache-coverage.test.ts` asserts every
  `dependsOn` entity is bumped by at least one usecase, so the obvious
  cases are caught. A raw `prisma.$executeRaw` write that mutates an
  entity without bumping is the residual gap — code review is the
  backstop. TTL bounds the worst case to `ttlSeconds`.

## Observability

`cachedAggregationRead` emits three OTel instruments (labelled by
`aggregation`, bounded cardinality), defined in
`src/lib/observability/metrics.ts`:

| Instrument | Type | Meaning |
|------------|------|---------|
| `cache.aggregation.hit` | Counter | served from cache |
| `cache.aggregation.miss` | Counter | recomputed |
| `cache.aggregation.compute_duration_ms` | Histogram | cost of a miss |

Watch the per-aggregation hit ratio in Grafana. A sustained low hit rate
means the invalidation graph is over-eager (a `dependsOn` entity churns
far more often than the dashboard is viewed) or the TTL is too short.

## How to add a cached aggregation

1. **Add it to the registry** (`aggregation-registry.ts`): the key, its
   `dependsOn` entities, a TTL ≤ `MAX_AGGREGATION_TTL_SECONDS` (600), and
   the scope. If you need a new entity, add it to the `AggregationEntity`
   union first.
2. **Wrap the route's compute** in `cachedAggregationRead({ scopeKey,
   aggregation, dependsOn, ttlSeconds, variant?, authorize, compute })`.
   Use `ctx.tenantId` for tenant scope, `ctx.organizationId` for org scope.
   Pass `variant` for any query arg that changes the result (period,
   filter id) — omitting it serves the wrong slice from cache.
   `authorize` is required and holds the read check the usecase makes
   (`assertCanRead…`): it runs first, on every call, before the cache is
   read. A check that lived only inside `compute` would be skipped on
   every cache hit (#5401).
3. **Verify the bumps cover `dependsOn`**: every entity must be bumped by
   the usecase(s) that mutate it (`bumpEntityCacheVersion(ctx, entity)`,
   or `bumpEntityCacheVersionForScope(scopeKey, entity)` for org scope).
   Add the call after the write commits if it's missing.
4. **Add the route to the ratchet** (`ROUTE_FILES` in
   `aggregation-cache-coverage.test.ts`) and run it.

## SSR payload cache (origin-tier)

`cachedSsrPayload({ tenantId, route, ttlSeconds, compute })`
(`src/lib/cache/ssr-cache.ts`) caches the **data** a server component
fetches before handing it to its client component — NOT the rendered
HTML. A hit skips the usecase + DB work; the React render still runs
fresh (cheap), so auth context / breadcrumbs stay correct. It cuts
server-side **TTFB**, not network round-trip (that's the CDN tier —
[`docs/cdn.md`](./cdn.md)).

| Property | Value |
|---|---|
| Key | `(tenantId, route, tenant-wide version)` — **not** user-scoped |
| Storage | Redis (the `getRedis()` singleton) |
| TTL | 60s (dashboard), 30s (entity lists); hard cap `MAX_SSR_TTL_SECONDS = 300` |
| Invalidation | **coarse** — `bumpEntityCacheVersion` bumps the tenant-wide counter (`tenantVersionKey`) on EVERY entity write, so any write invalidates ALL of the tenant's cached SSR payloads |

### Why coarse invalidation is right here

An SSR page aggregates across many entities (the dashboard shows control
counts AND risk figures; the risks page shows risk-coverage derived from
controls). A Control write should refresh the dashboard AND the risks
page — so a tenant-wide bump is the correct granularity, not a
per-entity one. The bump fires before the mutation's response returns, so
the staleness window is < 1s.

### Wired routes + the filter caveat

- **Dashboard** (`/t/<slug>/dashboard`) — always cached (`getExecutiveDashboard`
  is ~11 uncached COUNT queries; the real win). Tenant-pure (no per-user
  data), so a tenant key is safe.
- **Entity list pages** (risks, controls, assets, policies, tasks) —
  cached **only for the unfiltered load** (the common case). A filtered
  request (`?status=…`) bypasses `cachedSsrPayload` and computes directly,
  because (a) the cache key doesn't carry the filter, and (b) the
  filtered list data is already covered by the list cache. So the SSR
  cache's marginal win on list pages is the page-payload assembly, not
  the DB read.

### Opt-in

The cache is opt-in per route. Routes that must NOT cache — detail/edit
pages (`/risks/[id]/edit`), billing, anything reflecting the actor's own
in-flight edit at sub-second freshness — simply don't call
`cachedSsrPayload`. Observability: `cache.ssr.hit` / `.miss` /
`.duration` (by `route`); watch the per-route hit ratio in Grafana
(target > 70% for the dashboard in business hours — lower means the
tenant-wide bump is too eager or the TTL too short).

## When NOT to cache here

- **Per-user data.** This cache is scope-scoped, not user-scoped — two
  users in a tenant share an entry. A user-specific dashboard must use
  `cachedDashboardRead` (keys on userId) or no cache.
- **Strong-consistency reads.** Auth context, billing/entitlement state,
  permission checks — never serve these from a TTL cache.
- **Data the user is actively editing.** The bump covers "see your own
  write" at the cache layer; if the underlying repository read uses a
  lagging read replica, that is a separate concern this cache does not
  address.

## Out of scope

- CDN-level caching of `/api/*` (the CDN tier excludes `/api/*` by
  design — see [`docs/cdn.md`](./cdn.md)).
- Per-user aggregation caching.
- Postgres materialised views and scheduled pre-compute — complementary
  techniques, not part of this layer.
