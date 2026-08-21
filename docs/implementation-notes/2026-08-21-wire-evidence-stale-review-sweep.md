# 2026-08-21 — the stale-review sweep is reachable

**Commit:** `(this branch) feat(jobs): schedule the evidence stale-review sweep`

## Design

`runEvidenceStaleReviewSweep` shipped complete on 2026-05-22 (Audit Coherence S3):
it flips APPROVED evidence past its `nextReviewDate` to `NEEDS_REVIEW` in one bulk
`updateMany`, tenant-scoped, `now` injectable, wrapped in `runJob`. It had a full unit
test with seven cases.

It had never run. No `JobPayloadMap` entry, no executor registration, no schedule
entry, no caller anywhere in `src/`. For three months evidence aged past its review
date with `status = APPROVED`, and the audit-readiness score kept counting it as
fresh — which is the exact failure the usecase was written to prevent.

Wiring it is four small additions:

| layer | addition |
|---|---|
| `types.ts` | `EvidenceStaleReviewSweepPayload` + `JobPayloadMap` key + retry/retention options |
| `executor-registry.ts` | `executorRegistry.register('evidence-stale-review-sweep', …)` |
| `schedules.ts` | daily at **06:30 UTC** |
| `infrastructure-guards.test.ts` | job count 31 → 32, name added to the expected set |

## Why 06:30

`notification-dispatch` runs at 07:00 and is what actually tells an owner their
evidence needs re-review. The sweep has to flip the rows *before* that pass reads
them, or every owner learns a day late. 06:30 also sits clear of the 06:00 cluster
(three jobs) and after the 04:00 `retention-sweep`.

The ordering is asserted as a **derived comparison**, not a pinned literal: the test
parses both cron patterns to minute-of-day and requires the sweep to be strictly
earlier, so moving *either* job past the other fails. It also asserts both are plain
daily patterns with no `tz` — otherwise a minute-of-day comparison would be comparing
incomparable schedules and would pass for the wrong reason.

## Files

| file | role |
|---|---|
| `src/app-layer/jobs/types.ts` | payload type, map key, job options |
| `src/app-layer/jobs/executor-registry.ts` | the registration, and why the slot is before dispatch |
| `src/app-layer/jobs/schedules.ts` | the 06:30 entry |
| `tests/unit/jobs/evidence-stale-review-sweep-wiring.test.ts` | reachability, not shape |
| `tests/regression/infrastructure-guards.test.ts` | count + name-set ratchet |
| `tests/guardrails/audit-s3-evidence-mgmt.test.ts` | five source-scan assertions deleted |

## Decisions

- **The five deleted assertions are the point of this note.** What stood in for
  coverage was a block in `audit-s3-evidence-mgmt.test.ts` asserting things about the
  usecase's *source text*: that it exports the function, issues an `updateMany`, sets
  `NEEDS_REVIEW`, accepts a `tenantId`, calls `runJob`. All five were true. All five
  passed continuously while the function was unreachable, because a regex over source
  cannot distinguish *implemented* from *implemented and wired*.

  They were also pure duplication — `tests/unit/usecases/evidence-stale-review-sweep.test.ts`
  already covers every one of them behaviourally, and more. Deleted rather than kept
  alongside: a duplicate that cannot fail is worse than no test, because it makes the
  row look covered.

- **The new test asserts reachability.** `executorRegistry.has(...)`, then an actual
  `execute()` that must reach a mocked usecase and carry its count back out through
  `itemsActioned`. Mutation-proved against three regressions: removing the
  registration (4 tests fail), removing the schedule entry (2), and moving the sweep
  after `notification-dispatch` (1 — the ordering test alone, which is the subtle one).

- **`tenantId: undefined` is asserted explicitly, not merely allowed.** The usecase
  reads `options.tenantId` and an absent key means *every tenant*. The test pins
  `toEqual({ tenantId: undefined })` so a future executor that defaults it to some
  "current" tenant fails rather than silently narrowing a global sweep.

- **A positive control sits beside the registration assertion.** `validateRegistrations()`
  returning `{ valid: true, missing: [] }` is only meaningful if the schedule is
  non-empty, so the test asserts `SCHEDULED_JOBS.length > 0` first. An empty list
  would otherwise report "nothing missing" and read as a pass.

- **The job-count guard is a hazard shape, flagged not fixed.**
  `expect(SCHEDULED_JOBS).toHaveLength(31)` is a COUNT: two branches each adding a job
  both write `32`, git merges them without conflict, and `main` ends up asserting 32
  against 33 actual jobs. The adjacent name-set assertion is the safe shape — a union
  of two appends is the true state. Out of scope to change here, but worth knowing
  before the next two job PRs land in the same week.

- **No RLS binding added.** The sweep runs one `updateMany` on the global client with
  an explicit `tenantId` filter when scoped, and no filter when sweeping all — which
  is the intended cross-tenant behaviour for the cron and cannot be expressed under a
  single bound tenant context. Unchanged from how it was written.
