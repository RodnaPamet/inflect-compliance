# 2026-08-21 — the rescan sweep reaches the distribution ledger (#129)

**Commit:** `(this branch) fix(av-rescan): assess exposure for a file the sweep condemns`

## Design

`assessExposureOnInfection` — the distribution ledger from #119 — answers *what
already left*: which audit pack, which SharePoint export, which still-live signed
URL carried these bytes before we knew they were bad.

It was called from **two sites, both in `av-webhook/route.ts`**. `jobs/av-rescan.ts`
never called it. So a verdict discovered by the SWEEP bypassed the ledger entirely —
and the sweep is the path that walks the whole PENDING backlog, i.e. exactly the
files that have been servable the longest.

The call now sits in the job's INFECTED branch, **after the audit row and before the
circuit breaker**. Both positions are deliberate:

- **After the audit**, mirroring the webhook: the verdict must be durable before
  anything reports on it, or a failed report could describe a row that was never
  condemned. The test asserts the ORDER, not merely that both ran.
- **Before the breaker**, because a row the run has already condemned is precisely
  the one an operator needs an exposure report for. It should get one even if the
  infected ratio then halts the run.

Defensively wrapped even though `assessExposureOnInfection` is already internally
fail-safe. The verdict has committed and stands on its own; a reporting failure must
never cost the sweep a row it correctly condemned.

## Why this was worth filing rather than folding into #90 or #119

Neither lane could have done it. #119 built the ledger before the rescan job existed
in its merged form; #90's brief explicitly forbade it from touching anything outside
its own file. The gap only became visible when the two were read together — while
answering a production question about what would happen if the rescan condemned one
of four files that had been servable under `AV_SCAN_MODE=permissive` since May.

## Files

| file | role |
|---|---|
| `src/app-layer/jobs/av-rescan.ts` | the two calls, their placement, and why |
| `src/app-layer/services/file-distribution.ts` | split into `buildFileExposureReport` (reads) + `recordFileExposureReport` (write); `client` made required |
| `src/app/api/storage/av-webhook/route.ts` | now names its client explicitly — see below |
| `tests/unit/av-rescan-job.test.ts` | three cases plus the scope-depth assertion that locks the split |

## Decisions

- **The reads are bound; the write is not — and that split is the diff.** #2085
  landed after this branch was written and wrapped the job's DB work in
  `runInTenantJobContext`. Threading that binding into the ledger call looked like
  one line — wrap the whole call — but `assessExposureOnInfection` ends in
  `appendAuditEntry`, which opens its own `pg_advisory_xact_lock` transaction. The
  repo already has a precedent against nesting that (#123: *read in one transaction,
  audit outside any, transition in a second*), and the cost is concrete: two pooled
  connections and a per-tenant advisory lock **per condemned file**, on the one code
  path whose bad day is thousands of condemned files at once.

  So the service was split at the seam it already had — `buildFileExposureReport`
  was public. The job binds the reads and records outside; the webhook still calls
  the combined `assessExposureOnInfection`.

- **The test measures scope depth, not call order.** Relative index would pass
  against the naive "wrap both" threading, which is precisely the regression. The
  test counts `tx:start` minus `tx:end` before each call: `> 0` at the build, `0` at
  the record. Mutation-proved — wrapping both flips the second to 1 and the test
  fails on that line.

- **`client` is required, with no fall-back.** It was optional, defaulting to the
  module-level client, so an unbound caller was indistinguishable from a bound one
  at the call site. Making it required moved that choice into the diff; it also made
  the `prisma` import in `file-distribution.ts` dead, which is the honest signal that
  the service no longer reaches for a connection nobody chose.

- **The webhook passes the global client, and that is not a fix.** `av-webhook/route.ts`
  binds no tenant context anywhere, so there is no bound connection to hand it. It now
  says `client: prisma` explicitly. Reads there stay correct because they filter on
  `tenantId` — that filter, not RLS, is what scopes them. **Binding the webhook is a
  separate, unfiled gap**; the explicit argument surfaces it rather than closing it,
  and should not be read as handled.

- **Order asserted, not co-occurrence.** `expect(order.indexOf('exposure:build')).toBeGreaterThan(order.indexOf('audit'))` — "both were called" would pass against the inverted sequence, which is the bug worth preventing.
- **The CLEAN case leads with a positive.** `not.toHaveBeenCalled()` alone passes just as well when the job never ran, so that test first asserts the run completed and wrote a CLEAN verdict.
- **No new counter on `AvRescanResult`.** Tempting, but the ledger already writes its own audit row per assessment (including a zero-distribution one), so a count in the job summary would be a second, driftable record of the same fact.
