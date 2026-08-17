# 2026-08-17 — Fan-out: deterministic job ids and failure isolation

**PR:** #1957 — fix(jobs): make every fan-out idempotent and failure-isolating

## Design

Every dispatcher looked like this, including
`cloud-posture-collect-dispatch.ts`, which I added a few PRs ago:

```ts
for (const conn of page) {
    await enqueue(job, { tenantId: conn.tenantId, connectionId: conn.id });
}
```

Two defects, and they compound.

**No `jobId`.** BullMQ treats every enqueue as new work, so any re-run of the
dispatcher — a retry, a redeploy replaying a schedule, an operator kicking it
manually — queues a second full sync for every connection.

**No failure isolation.** A single `enqueue` throw (Redis blip, connection
refused) aborts the whole loop. Every connection after it is silently never
dispatched, and the completion log still reads like a clean run because the
counters only count what got as far as being enqueued.

Together they are worse than apart: the aborted dispatcher throws, BullMQ
retries it, and the retry re-enqueues everything that already succeeded in order
to reach the connections it never got to.

```
  connections ──▶ fanOut(items, component, describe, enqueueOne)
                        │
                        ├── enqueue with jobId = `${job}:${key}:${bucket}`
                        ├── catch + log + count, continue
                        └── { dispatched, failed }
                                    │
                     failed > 0 && dispatched === 0 ──▶ throw
```

### The bucket is the sharp edge

A deterministic id is only safe if it CHANGES each scheduling period. BullMQ
dedupes against jobs still held in the completed/failed sets, so an id that
outlives its schedule interval does not merely suppress a duplicate — it makes
the next legitimate run a silent no-op.

That failure is much worse than the one being fixed, because **a sync that
stops running looks exactly like a sync with nothing to do.** Nothing errors;
the scheduled job completes on time; it just does nothing.

So the bucket must match the cron period: daily dispatchers get 24 h, the
4-hourly SharePoint dispatcher gets 4 h. Erring the *other* way is safe — a
bucket shorter than the cadence just catches fewer duplicates, which is where
we started.

`tests/guards/fan-out-bucket-matches-schedule.test.ts` derives the period from
`SCHEDULED_JOBS` and fails if a bucket is coarser. That is the edit worth
guarding: the schedule and the bucket live in different files and nothing links
them, so tightening a cadence without touching the bucket is both easy and
invisible.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/jobs/fan-out.ts` | New. `dispatchJobId` (bucketed) + `fanOut` (isolating). |
| `src/app-layer/jobs/identity-sync.ts` | Daily bucket. |
| `src/app-layer/jobs/hris-sync.ts` | Daily bucket. |
| `src/app-layer/jobs/cloud-posture-collect-dispatch.ts` | Daily bucket; both defects were mine. |
| `src/app-layer/jobs/sharepoint-delta-sync.ts` | **4-hourly** bucket; `skippedNoAdmin` re-derived. |
| `src/app-layer/jobs/compliance-posture-summary.ts` | Already isolated; gained the id. |
| `tests/guards/fan-out-bucket-matches-schedule.test.ts` | Cron period ≥ bucket, per dispatcher. |

## Decisions

- **`failed > 0 && dispatched === 0` throws.** A partial failure is reported in
  counters and logs and left as a success — the work that got out is real. But
  a run where *nothing* was dispatched must not report a clean run that did
  nothing. An empty input list stays a legitimate no-op, and the two are
  distinguishable because `failed` is 0 in that case.

- **`skippedNoAdmin` is derived from `routable`, not from `dispatched`.** The
  old expression `connections.length - dispatched` was correct only while
  enqueues could not fail. With isolation it would relabel every Redis failure
  as a missing-admin skip — hiding an infrastructure problem behind a
  configuration one, which is the more plausible-looking of the two and would
  send an operator to the wrong place.

- **The bucket is the raw floored epoch, not a formatted date.** A formatted
  string invites someone to make it human-readable in local time, which would
  shift the boundary by the server's UTC offset and desynchronise it from the
  cron.

- **`dispatchJobId` throws on a non-positive bucket.** `Math.floor(now / 0)` is
  `Infinity`, so every call would produce the same id — the "never runs again"
  failure with no visible cause.

- **A parser bug its own sanity case caught.** The first `cronPeriodMs` ignored
  the minute field, reporting `*<slash>15 * * * *` as hourly — four times longer
  than the truth, and over-reporting the period is exactly the direction that
  lets a too-coarse bucket pass. No dispatcher is currently sub-hourly, so only
  the deliberate sanity assertion caught it.
