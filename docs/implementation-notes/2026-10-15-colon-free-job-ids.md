# 2026-10-15 — scheduled control tests did not run for seven days (#3554)

**PR:** #3556 · **Issue:** #3554 · **Spawned:** #3557, #3558 ·
**Second occurrence of:** #2175 / the leaver dispatch

## What happened

`control-test-scheduler` hand-rolled `jobId = ctr:{planId}:{scheduledForIso}`.
BullMQ accepts a colon in a custom id **only** when the id splits into exactly
three parts. The template's two colons were fine; the ISO timestamp contributed
two more, and every enqueue threw `Custom Id cannot contain :`.

| | |
| --- | --- |
| first failure | **2026-10-07T09:09:37Z** |
| last seen before the fix | 2026-10-14T20:30Z |
| rate | **24/hour**, unbroken — ~4,300 failures |
| affected | 2 `ControlTestPlan` rows, 1 tenant |
| scheduled control tests that ran | **zero** |

## Three things worth keeping from this

### 1. Resilience hid it, and the resilience is correct

The failure path rolls the DB claim back under a guarded update so the plan is
re-claimed next tick. Nothing was lost. **It converted a permanent error into
an infinite retry, and a permanent error being retried is indistinguishable
from progress.** The tick log says "job completed" every time — truthfully, it
completed having enqueued nothing.

The lesson is not "don't roll back". It is that a retry loop needs some notion
of *this has failed the same way N times*, or the only thing distinguishing a
transient blip from a dead feature is somebody reading logs. Filed as #3558.

Deploying the fix produces **two** enqueues, not 4,300: a successful claim
advances `nextRunAt` to the next cron occurrence after *now*, so missed
occurrences are skipped rather than accumulated. Worth knowing before a fix
like this goes out, because "seven days of missed runs" sounds like a flood.

### 2. The code was broken for five months and the failure is seven days old

The hand-rolled id dates from #147 (2026-05-05). BullMQ's check was already in
place by 2026-08-29, when #2175 documented it. So the trigger was neither code
nor dependency: it was **data**. Two plans acquired a schedule and the enqueue
path executed for the first time.

An unreached code path is not a working one. The question "when did this break"
had three plausible answers and only one was right; bisecting the log by
timestamp settled it in four queries, and the `--limit` cap lied twice on the
way (a capped newest-first read makes its oldest row look like a start
boundary).

### 3. The lesson existed, written down, in this repo

#2175 — *"the leaver dispatch has never enqueued a single pass"* — diagnosed
this rule, documented it at length in `fan-out.ts`, and encoded it as
`expect(opts.jobId.split(':')).toHaveLength(3)` **in the two dispatch tests it
fixed**. It was never made a property of the codebase, so the one enqueue site
that did not use the helper kept its bug.

That is the difference between a fix and a guard, and it is why this PR is four
parts rather than one line.

## Why three gates were green

| gate | why it was quiet |
| --- | --- |
| the scheduler's unit test | asserted `options.jobId` equalled the exact broken string, against a **mocked** enqueue that accepts anything. Green forever, and incapable of expressing the only failure that mattered |
| the enqueue seam | had **no test at all** — every suite in the repo mocks `@/app-layer/jobs/queue`, so the one function every job passes through was exercised by nothing |
| alerting | `/api/readyz` is the only watched signal; the process was healthy and only the work failed. A manual trigger passes no `jobId` and worked perfectly throughout — as it did in #2175 |

## The fix

1. **`scheduledJobId(prefix, key, instantMs)`** — colon-free, for schedulers
   that are not fan-outs. Not `dispatchJobId`: that buckets by time window, and
   a cron plan can legitimately be due twice inside a bucket, so bucketing
   would collapse two real runs into one — a quieter version of the same
   outage. Throws on a colon-bearing key and on a non-finite instant
   (`new Date(undefined).getTime()` is `NaN`, which would give one stable id
   for every run).
2. **`enqueue()` validates `options.jobId`** — the one place every job passes
   through, thrown as a precondition, with a message naming the rule and the
   factories. `Custom Id cannot contain :` had to be decoded twice, five weeks
   apart, from two different logs.
3. **The scheduler's test asserts the rule**, not the spelling.
4. **`tests/guards/bullmq-job-id-rule.test.ts`** — the predicate still matches
   the *installed* library (read differentially out of `node_modules`); it
   really rejects the real id; and **no site in `src/` assigns a jobId from a
   template literal**, which is how both occurrences were written.

## The upgrade that is already scheduled

The installed BullMQ carries its own note above the check:

```js
// TODO: replace this check in next breaking check with include(':')
// By using split we are still keeping compatibility with old repeatable jobs
```

The carve-out is going. When it does, `dispatchJobId`'s format — **eight job
families** — becomes invalid at once. That is why the new factory is colon-free
rather than merely three-segment, and why the guard pins the `!== 3` needle:
the day it disappears, CI fails and points at #3557 instead of production
finding out a third time.

## Verification

45 suites / 704 tests (the derived population of everything importing or
mocking the three changed modules, plus the opt-in dispatch stress suite —
`tests/stress/` is excluded unless `JEST_STRESS=1`, which is why 45 requested
paths ran 44 suites; chased rather than assumed). Needle-uniqueness and
span-reach ratchets, 51 tests, because two new test files land in a population
whose read cap has zero drift allowance. eslint clean, `tsc` 0 errors.

Five mutation proofs; the instructive one is **"factory uses colons"**, which
fails exactly one test. A three-segment colon id is still *valid*, so only the
stronger colon-free assertion catches it — the weaker property would have
passed and left the next BullMQ major to find it.
