# 2026-09-12 — the notification outbox gets its own schedule

**Issue:** #2485

## Design

Before this change the only SCHEDULED call to `processOutbox` in the codebase
was the last statement of `daily-evidence-expiry`:

```
06:00 UTC  daily-evidence-expiry
             await sweep(30)          ← unguarded
             await sweep(7)           ← unguarded
             await sweep(1)           ← unguarded
             await processOutbox()    ← the ONLY scheduled drain
```

Two facts followed from that shape, and neither was visible from the outbox
itself:

1. **Latency was set by an unrelated job's clock.** The leaver pass runs at
   05:00. Its notification — since 2026-09-12, the mail telling a manager a
   real Entra account was disabled — sat in `NotificationOutbox` for an hour
   waiting for 06:00.
2. **Delivery was downstream of three throws.** A failure in any evidence
   sweep left the function before the flush line, so the 05:00 mail waited for
   the NEXT 06:00 tick: roughly 25 hours. Nothing in the notification
   subsystem reported a problem, because from its side nothing had failed.

A manual per-tenant drain has always existed (`POST
…/notification-settings/run-job` with `jobType: 'processOutbox'`, wired to a
button on the settings page), so this was a SCHEDULING gap rather than a total
absence — but reaching for it requires already knowing the mail is stuck, which
is what the mail was for.

Both halves of the fix:

```
*/10 * * * *  notification-outbox-flush   → processOutbox({ limit: 200 })
06:00 UTC     daily-evidence-expiry
                try { sweep(30) } catch { record }
                try { sweep(7)  } catch { record }
                try { sweep(1)  } catch { record }
                processOutbox()                     ← always reached
                if (recorded) throw EvidenceSweepFailedError
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/jobs/notification-outbox-flush.ts` | New job. Wraps `processOutbox` in `runJob`; `OUTBOX_FLUSH_LIMIT = 200`. |
| `src/app-layer/jobs/schedules.ts` | `notification-outbox-flush` on a ten-minute cron, plus the header's schedule-semantics line. |
| `src/app-layer/jobs/executor-registry.ts` | Registers the executor; also corrects the false "always zero writes" comment on the leaver pass's `actioned` count. |
| `src/app-layer/jobs/types.ts` | `NotificationOutboxFlushPayload`, its `JobPayloadMap` entry, and a one-attempt `JOB_DEFAULTS` entry. |
| `src/app-layer/jobs/dailyEvidenceExpiry.ts` | Per-sweep `try`/`catch`; `EvidenceSweepFailedError` thrown after the flush. |
| `tests/unit/notification-jobs.test.ts` | Behavioural: a throwing sweep still flushes, and the job still fails. |
| `tests/unit/jobs/notification-outbox-flush-wiring.test.ts` | Reachability + cadence for the new job. |

## Decisions

- **The failing job still fails, and it fails AFTER the flush.** The obvious
  reading of "wrap the sweeps in try/catch" is to absorb the error, which would
  turn a loud failure into a job that reports success while a third of its work
  never ran. Throwing at the end keeps every downstream behaviour identical to
  before — `runJob` records the failure metric and reports to Sentry, the
  executor registry produces `success: false`, BullMQ retries — while moving
  the flush in front of the throw. It also avoids a subtler regression: had the
  job RETURNED a failure instead, `runJob` would have recorded a success and
  the registry a failure, for one run.
- **The error message names the flush.** `EvidenceSweepFailedError` reads
  `"1 of 3 evidence sweeps failed — 7d: …. The outbox still flushed (9 sent, 0
  failed, 1 skipped)."` The question an operator brings to a red
  `daily-evidence-expiry` at 06:05 is whether the 05:00 leaver mail went out.
- **Per-sweep, not one try around all three.** The thresholds are independent
  queries over different rows; a 30-day failure taking the 7-day and 1-day
  sweeps with it is a smaller copy of the same coupling.
- **A caught sweep contributes zeros to the aggregate**, never a sibling's
  numbers — the `details` blob is something a human reads.
- **`attempts: 1` on the new job.** At a ten-minute cadence the next tick *is*
  the retry, and a five-second BullMQ retry re-enters the same dead SMTP host.
  Per-MESSAGE retry is unaffected: `processOutbox` still gives each row three
  attempts, now spread across ticks rather than burned inside one.
- **The 06:00 flush stays.** The expiry sweeps enqueue mail and hand it
  straight to a flush; deleting that tail would make their own output wait up
  to a tick for nothing. A second drain in the same minute is free, because
  each row is claimed with a conditional `updateMany` before its send.
- **Cadence is asserted as a BOUND (≤15 min), not as the literal pattern.**
  Re-tuning to 5 or 15 minutes is a judgement call; a silent edit back to a
  daily cron would restore #2485 with the job still present and every
  structural ratchet green.
