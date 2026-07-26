# 2026-07-26 — Compliance-calendar backend hardening

**Commit:** `<sha>` fix(calendar): per-source authz + effective-due + read-context fan-out

## Design

The compliance calendar (`getComplianceCalendarEvents`) fans out across 17
deadline-bearing entity types. This pass closes a cross-entity permission
leak and a set of correctness/robustness bugs in the aggregation and the
scheduler jobs that feed it.

### Per-source authorization (the CRITICAL fix)

The aggregator gated on a single `assertCanRead(ctx)` — but `permissions.canRead`
is `level >= 1`, i.e. TRUE for every role, so a principal explicitly denied a
domain (custom-role JSON, or an API key scoped to something else) still read
that domain's deadlines: employee names (training), incident titles, vendor /
risk / policy / task due dates.

The fix moves authorization into a per-source `CALENDAR_SOURCES` table. Each
source declares the `PermissionKey` its own PAGE enforces; a loader runs only
if `hasPermission(ctx.appPermissions, src.permission)`. This one predicate
closes both amplifiers, because `appPermissions` is the single resolved set for
BOTH custom roles (`parsePermissionsJson`) and API keys (`scopesToPermissions`):

  - A custom role denying `incidents.view` now hides incident deadlines.
  - A `mcp:read`-only API key (no PermissionSet flags) sees nothing — and is
    denied the route outright by the `requireAnyPermission(CALENDAR_BASELINE_PERMISSIONS)`
    baseline, which also writes an `AUTHZ_DENIED` audit row.

Sources hidden by permission are reported in `response.omittedSources` so the
UI says "some sources hidden by your permissions" rather than silently
under-reporting. `finding` / `access-review` have no dedicated PermissionSet
domain, so they gate on `audits.view` (the closest attestation domain every
human role holds and the audits scope can grant).

### Read-context fan-out

The 17 loaders ran inside ONE `runInTenantContext` interactive transaction —
which pins a single connection and serialises, so `Promise.all` never
parallelised, and the shared 5 s tx timeout 500'd the whole calendar on a large
tenant. Each loader now runs in its OWN `runInTenantReadContext` (READ ONLY,
own pooled connection) under a bounded-concurrency pool, with a per-source
timeout so one slow source fails alone.

### Nearest-survives truncation

Two-date sources (vendor, risk, audit-cycle, test-plan) ordered `[a, b]` over an
OR predicate; Postgres sorts NULLs LAST, so a row matching only on `b`
truncated FIRST — imminent renewals lost before distant reviews. `fetchNearest`
queries each column's nearest-`limit` and unions them (provably complete for
min-ordering). Test plans additionally read `effectiveDueAt = min(nextDueAt,
nextRunAt)` per the scheduling-model-unify note — the MANUAL path advances only
`nextRunAt`, so reading `nextDueAt` alone rendered cron plans permanently overdue.

### Day-granularity status in tenant tz

`classifyStatus` compared instants, so UTC-midnight deadlines flipped to
`overdue` at 00:00:01 UTC — the previous afternoon for a westward tenant. It now
compares whole calendar days in `NOTIFICATIONS_TZ` (`urgencyFromDaysUntil` +
`daysUntilInTz`); same-day is `due_soon`, never `overdue`.

### Range + response

`CalendarQuerySchema` now rejects timezone-ambiguous datetimes and normalises
the day form to `[00:00:00.000Z, 23:59:59.999Z]` (an inclusive `lte: to` no
longer drops the `to` day), exposing parsed `fromDate`/`toDate`. The type/
category filter is pushed into source SELECTION so `truncation.sources` only
names sources that ran, and a `totalCap` bounds the serialized payload.

### Scheduler robustness (jobs feeding the calendar)

`schedule-trigger-sweep` gained per-rule/per-tenant fault isolation
(`Promise.allSettled`), a bounded catch-up window, an N+1→batched query, and
batched enqueues. `control-test-scheduler` advances from the missed instant
(not `now`), orders NULLS FIRST so bootstrap plans don't starve, rolls back a
claim whose enqueue failed (recoverable, not silently lost), and distinguishes
a bad-cron parse error from a benign no-tick. `calendar-deadlines` bounds its
three cross-tenant scans and logs cap hits.

## Files

| File | Role |
|---|---|
| `src/app-layer/usecases/compliance-calendar.ts` | Per-source authz table, read-context fan-out, `fetchNearest`, effective-due, tz classify, total cap |
| `src/app-layer/schemas/calendar.schemas.ts` | Range format validation + normalization; `omittedSources` / `totalCap` response fields |
| `src/app/api/t/[tenantSlug]/calendar/route.ts` | `requireAnyPermission` baseline; uses normalized range |
| `src/app/api/t/[tenantSlug]/calendar/upcoming-count/route.ts` | `tasks.view` gate; returns window + scope |
| `src/components/layout/use-calendar-badge.ts` | Throw-on-error so a failed refresh keeps the last count (failure ≠ zero) |
| `src/app-layer/jobs/schedule-trigger-sweep.ts` | Fault isolation, catch-up, N+1, batched enqueues |
| `src/app-layer/jobs/control-test-scheduler.ts` | Advance-from-missed, NULLS FIRST, enqueue-fail rollback, cron-error escalation |
| `src/app-layer/jobs/calendar-deadlines.ts` | Bounded cross-tenant scans + cap logging |

## Decisions

- **Gate on `appPermissions`, not a new coarse check.** It is the ONE resolved
  set that already encodes custom-role denials and API-key scopes, so per-source
  gating fixes the custom-role and API-key amplifiers for free — no separate
  scope-enforcement pass on the route is needed.
- **`requireAnyPermission` baseline, not a single key.** The calendar is
  cross-domain; requiring any one source-domain view denies a scopeless key
  while never over-restricting a human (every role holds all `.view`s).
- **`fetchNearest` union over a raw `LEAST(...)` order.** Prisma can't order by
  an expression; the two/three-query union is type-safe, correct, and keeps the
  loaders in the ORM.
- **Enqueue-fail rollback over throw (scheduler #4).** Throwing loses the run
  (retry re-scans and the claimed plan is no longer due); rolling the claim back
  makes the next tick re-claim and retry, and the deterministic jobId prevents a
  partially-delivered enqueue from double-firing.
