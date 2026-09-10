# 2026-09-10 — Posture freshness: what counts as a "last success" (#2252)

**Commit:** _(pending)_ `fix(integrations): a FAILED posture benchmark is a collection, for freshness`

## Design

A cloud-posture collection that runs perfectly and finds non-compliance
persists `IntegrationExecution.status = 'FAILED'`. That is not a broken
connector: the collector authenticated, reached the account, read it, and the
account is not compliant. The collectors already encode exactly this
distinction — `aws-posture.ts` and `cloud-posture.ts` call `clearAuthFailure`
on FAILED as well as PASSED.

Both freshness surfaces disagreed with them. Each computed "last success" as
`status: 'PASSED'` alone:

| Surface | Consequence |
| --- | --- |
| `getEnabledConnectionFreshness` (OTel gauge `integration.connection.freshness_seconds`) | anchors on `createdAt`, so the gauge climbs without bound past `CONNECTION_STALE_AFTER_SECONDS` (48 h) on a connector that has run cleanly every night |
| `getConnectionsHealth` (admin health view) | `hasEverSucceeded: false` → the panel reads "Never succeeded", permanently |

The fix widens the status allowlist to `['PASSED', 'FAILED']` **for cloud-posture
providers only**.

```
posture connections   → status in (PASSED, FAILED)   ┐
                                                      ├─ ONE grouped query (an OR)
every other provider  → status in (PASSED)           ┘
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/integrations/posture-providers.ts` | NEW — `POSTURE_PROVIDER_IDS` + `isPostureProvider`, the single answer to "is this a posture collector?" |
| `src/lib/observability/connection-freshness.ts` | Gauge query: provider-split allowlist; docstring, field comments and metric description corrected |
| `src/app-layer/usecases/integrations.ts` | `getConnectionsHealth`: the same split, same predicate |
| `src/app-layer/jobs/cloud-posture-collect-dispatch.ts` | `POSTURE_JOB_BY_PROVIDER` re-keyed on `PostureProviderId` so the two lists cannot drift |
| `tests/helpers/execution-status-groupby.ts` | NEW — a fake `groupBy` that EVALUATES the caller's `where`, shared by both suites |

## Decisions

- **Posture-only, not fleet-wide.** `github` and `servicenow` also emit FAILED
  for "the check ran and found a gap", so widening everywhere is superficially
  consistent. It was rejected: for those connectors a FAILED run is far more
  often a genuinely broken one, and a dead connector would then read fresh for
  up to 48 h longer than it should. The asymmetry is deliberate and both
  directions are pinned by tests — the load-bearing assertion is the NEGATIVE
  one (a github connection whose only run is FAILED still reads
  never-succeeded), because that is what proves the scoping holds.

- **An explicit allowlist, never `{ not: 'ERROR' }`.** `IntegrationExecutionStatus`
  has seven values. NOT-ERROR would admit `RUNNING`, and every posture run
  inserts a RUNNING row at its start (`aws-posture.ts:87`) — an orphaned one
  from a killed worker would then reset the freshness clock on a job that never
  finished. It would also admit `PENDING` and `NOT_APPLICABLE`; the latter is
  excluded on purpose, per the 2026-07-09 GAP-3 note ("ran clean but no data" is
  not verification). Tests cover RUNNING, PENDING, ERROR and NOT_APPLICABLE.

- **One helper, three callers.** The posture family was already named twice, in
  two private places that could not be reused: `POSTURE_JOB_BY_PROVIDER` (which
  collect job services each provider) and the `'cloud'` rows of
  `PROVIDER_CATEGORY` (which hub group they render in). Rather than hardcode a
  third list, `posture-providers.ts` holds it once, and the dispatch map is
  re-keyed on the exported union so adding a fourth cloud to one without the
  other is a compile error in both directions.

- **Still one grouped query per surface, not one per provider.** The connection
  set is partitioned in memory and the two `(id-set, allowlist)` pairs go into a
  single `OR`. The "two bounded queries, never a query in a loop" promise both
  modules make in their docstrings is preserved.

- **`lastSuccessAt` / `hasEverSucceeded` keep their names.** The semantics
  widen, the field names do not — renaming would ripple through the health
  route, the panel, and the gauge's series for no gain. The docstrings and the
  gauge's `description` were corrected instead, since the old text ("last
  SUCCESSFUL (PASSED)") is now a false present-tense claim about what the
  number means.

- **Nothing in the collectors changed.** The legibility half of #2252 (making a
  wholly-errored collection legible) shipped separately in #2397. This change
  reads what they already persist; it writes no `authFailedAt` and calls
  `markAuthFailure` from nowhere new.

## Supersedes

The 2026-07-09 GAP-3 note records the decision "**`PASSED` is the only
'success'**". That is no longer true for cloud-posture providers. It remains
true for every other provider, and its stated reason — that `NOT_APPLICABLE`
must not count — is unchanged and still enforced.
