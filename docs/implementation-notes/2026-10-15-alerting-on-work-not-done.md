# 2026-10-15 — alerting on work not done (#3558)

**PR:** #3572 · **Issue:** #3558 · **Caused by:** #3554 · **Spawned:** #3573
**Deployed:** reporter + policy `9571974332933407186`, owner-authorised

## The gap, priced

#3554 ran for **7½ days**. `control-test-scheduler` claimed each due plan,
failed to enqueue the runner, rolled the claim back and retried — ~4,300 times,
24 an hour — with **zero** scheduled control tests run. A human found it
grepping logs for an unrelated reason.

Every signal that should have carried it worked:

| signal | why it was silent |
| --- | --- |
| `enqueueFailures` | incremented, returned to the caller **and** `logger.error`-ed on every attempt — read by nothing |
| the tick's own log | "job completed" each time, truthfully, having enqueued nothing |
| `/api/readyz` | green: the process was healthy, only the **work** failed |
| a manual trigger | worked, because it passes no custom job id |

## The design decision: measure the symptom, not the counter

#3558 proposed reading the failure counter. **That is not implementable.**
`runJob` persists nothing — there is no job-run history in Postgres for a
reporter to query, and the counter exists only in a log line.

What *is* readable is rows whose own scheduling column says they are late. That
is **strictly better** than a count, and the reason is worth keeping: one query
catches every cause — rejected enqueue, wedged worker, drained Redis, crash
loop, a bug nobody has found yet — whereas a counter only ever catches the
failure mode somebody already thought of.

And it would have caught #3554 **within minutes**: the rollback restored each
plan's original `nextRunAt`, so it sat in the past continuously for the entire
outage.

## Why the local idiom is a reporter, not a log-based metric

The issue's "one GCP log-based metric" is not how this deployment works, and I
only found that out by looking: the project has **zero** log-based metrics, and
three of its five alert policies are fed by shell reporters on the VM under
systemd timers (`infra/reporters/`), which the repo calls *"the alerting
mechanism that actually works on this deployment"*.

The pattern's four rules each exist because the opposite failed in production.
Two are load-bearing here:

- **Emit on the healthy path — `0` is a value.** A metric that only appears when
  something is wrong is indistinguishable from a reporter that died, which makes
  the absence arm meaningless.
- **An unreadable number is not zero.** A failed query exits **without posting**,
  so sustained silence becomes a page. Posting `0` on a failed read would be the
  worst available outcome: a confident all-clear.

## Verification, and the part that is easy to skip

Each query was **positively controlled, read-only, against production, before
any zero was believed**:

| family | real window | 100-year window | verdict |
| --- | --- | --- | --- |
| `control_test_plan` | 0 | **2** | controlled |
| `notification_outbox` | 0 | **1071** | controlled |
| `audit_outbox` | 0 | **0 rows in the table at all** | **UNEXERCISED** |

The third row is the honest one. `AuditOutbox` is empty, so that arm cannot be
controlled from production data and rests on the schema alone. It is recorded as
such in the metrics contract, because **a zero from an untested query is not
evidence** — it is the same shape as the probe in #3547 that returned the right
answer for the wrong reason.

Then: dry-run against the live database (every read, no POST), install, timer
active, first real run **HTTP 200**, all three series queryable.

## What the mutation proofs found

Six mutations; the fifth found a hole **in my own guard**.

Prepending `if [ "$TOTAL" -eq 0 ]; then exit 0; fi` before the payload satisfies
both assertions that were supposed to hold the emit-on-healthy rule — the POST's
shape is unchanged and the journal gate is still correctly positioned — while
stopping the reporter emitting on every healthy run. The rule exactly inverted.

**The guard was grading the shape of the POST and the position of the gate.
Neither is the property.** The property is that nothing *else* branches on the
total, and it is countable: `exit 0` exactly once (the dry run), `$TOTAL` read
exactly once (the journal gate).

That is the fourth time in this session that **counting** a needle rather than
matching it was the difference between a guard and a decoration — and the
second time the count itself corrected me: I wrote `exit 1; }` expecting 3 and
measured **4**, the fourth being the missing-token guard.

## Two stale claims, in opposite directions

- **I had the estate wrong.** I asserted in #3554 and #3558 that production
  alerting is one uptime check. It is **five policies**, three fed by these
  reporters. Asserted from memory; corrected on both issues and in the memory.
- **The repo denied coverage it had.** `identity-unsettled-reporter.sh` was
  listed "not yet applied" and the contract said *"until both are done there is
  NO alert on an unsettled identity write"* — while the metric held **5,558
  points over 30 days** and its policy was live. That is the inverse of the
  #2842 failure mode the entry was written to prevent: not a claim of coverage
  that does not exist, but a **denial of coverage that does**, which would have
  had the next reader build a second alert beside the working one.

And `unsettled-reporter-matches-the-product` caught me fixing only half of it —
it asserts `status == DEPLOYED` exactly when a policy id is present. Its sibling
test had pinned `deployed_policy_id` as null "because applying the alert is an
operator action not yet taken", with a comment asking for that expectation to be
updated in the diff that records the real id. Which is what happened, weeks
late.

## Not covered, so the coverage claim is honest

- **FAILED rows** — work *abandoned* rather than stalled. Production holds
  **520** of them, all one SMTP 550 sender-domain rejection, silent for three
  months, including 10 `IDENTITY_LEAVER_NEEDS_ACTION`. Filed as **#3573**, found
  while controlling the `notification_outbox` query: the zero was right, and the
  table it read was half full of abandoned work.
- The ~25 other `SCHEDULED_JOBS` entries that write no readable row, because
  `runJob` persists no history. That is the larger half of #3558 and needs a
  job-run table first.
