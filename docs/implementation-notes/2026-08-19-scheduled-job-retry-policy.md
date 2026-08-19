# 2026-08-19 — every cron job's retry policy was documentation

**Commit:** `(this PR)` fix(jobs): apply JOB_DEFAULTS on the cron path

## Design

`JOB_DEFAULTS` declares per-job retry policy: attempts, backoff, retention.
`enqueue()` has always applied it. `registerSchedules` did not.

```ts
await queue.upsertJobScheduler(name, repeatOpts, { name, data });  // no opts
```

BullMQ composes a scheduled job's options as (`queue.js:250`):

```js
Object.assign({}, this.jobsOpts, jobTemplate?.opts)
```

With `opts` absent that is exactly `jobsOpts` — the queue-level
`defaultJobOptions`: `attempts: 3`, exponential backoff, `removeOnComplete: 500`.

So **29 of 30 scheduled jobs ran a policy none of them declared**, and the
declarations read as policy while being documentation. The one exception,
`automation-runner`, matched only because it happens to declare the queue
default.

Fix: pass `opts: JOB_DEFAULTS[schedule.name]`.

## What actually changes

| declared | jobs | was |
| --- | --- | --- |
| `attempts: 1` | 14 | 3, exponential |
| `attempts: 2` | 15 | 3, exponential |
| `attempts: 3` | 1 (`automation-runner`) | unchanged |

**The direction is one-way.** Every entry declares *fewer* attempts than the
queue default. This can only reduce retry pressure — never increase it. That
is the single most important property for assessing the risk: there is no job
that starts hammering something it did not hammer before.

The 14 dropping to a single attempt are the ones whose entries already
explained, in writing, why retrying is harmful — NVD's rate limit, a Powerpipe
shell-out against live AWS, a calendar fan-out where one blip becomes a second
pass over everyone's calendar. Those comments were describing an intent the
runtime had never honoured.

Retention also tightens (`removeOnComplete` 500 → mostly 50, `removeOnFail`
1000 → 200): less Redis memory, less completed-job history for debugging.

## Deploy semantics

`Queue.upsertJobScheduler` passes `{ override: true }`, so an existing
scheduler's stored options are replaced on the next `registerSchedules` run.
Both entry points call it — `scripts/scheduler.ts` and every worker boot — so a
normal deploy applies this with no manual migration and no Redis surgery.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/jobs/register-schedules.ts` | passes `opts`; header explains the merge |
| `tests/unit/scheduled-job-retry-policy.test.ts` | per-job opts, the 1-attempt set, no orphans, direction |
| `src/app-layer/jobs/calendar-push.ts` | reason 1 marked historical |
| `src/app-layer/jobs/types.ts` | `calendar-push-tenant` rationale corrected |
| `src/app-layer/jobs/executor-registry.ts` | "ONLY path" claim corrected |
| `tests/unit/calendar-push-job.test.ts` | opening rationale rewritten |
| `tests/guardrails/runtime-wiring-coverage.test.ts` | exemption reason rewritten |

## Decisions

- **Six comments corrected rather than left.** Five files asserted the inert
  behaviour as live fact, and one of them — `calendar-push.ts` — used it as the
  *first* justification for splitting that job in two. Fixing the code without
  fixing those would leave five confident, wrong explanations pointing at the
  new code. The calendar-push reason is marked historical rather than deleted,
  because the shape it produced is still the shape in the tree and a reader
  deserves to know which justifications are live.

- **The two-job calendar shape survives on its other reasons.** The per-tenant
  scan is what its composite index was built for, and each child carries a
  deterministic per-day job id so re-dispatch is a no-op. Only the retry
  argument evaporates.

- **A test asserts no entry declares MORE than 3.** Not because one does, but
  because the direction is what makes this safe to ship. An entry declaring 4+
  would be a real escalation against a third party, and it should be a reviewed
  decision rather than a side effect of this fix.

- **`JOB_DEFAULTS[name]` orphans are a test, not a runtime guard.** A missing
  entry yields `undefined`, which BullMQ reads as "no opts" — silently
  restoring the old behaviour for that one job while every sibling is correct.
  A partial fix that looks total is worse than no fix.
