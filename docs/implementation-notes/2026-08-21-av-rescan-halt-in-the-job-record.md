# 2026-08-21 — the av-rescan circuit-breaker halt reaches the job record

**Commit:** `(this branch) fix(jobs): let the av-rescan job record say the run halted`

## Design

`runAvRescan` returns an `AvRescanResult` with sixteen fields. The `av-rescan`
executor in `executor-registry.ts` copied ten of them into the `details` block
of the `JobRunResult` — the object BullMQ stores as the run's return value and
the only structured record an operator reads when asking "did last night's
sweep work?".

The list was hand-enumerated, and correct on the day it was written. Six fields
added later never reached it: `scannerThrew`, `backedOff`, `halted`,
`haltReason`, `haltRemediation` (and `durationMs`, deliberately — see below).

The consequence was worse than a missing counter. A run that the infection-ratio
breaker STOPPED and a run that finished with nothing to do produced
indistinguishable records: same `success: true`, same counters, no field
anywhere saying which had happened. The halt was visible only in the
`av-rescan.halted` log line and the audit row — neither of which is where
someone looks at run history. An absence carries no information about which
absence it is.

The fix builds `details` by SPREADING the result instead of re-typing it, so
the record follows the interface by construction and the next counter added
lands there without anyone remembering to.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/jobs/executor-registry.ts` | `av-rescan` details block spread from the result; the PARTIAL judgement recorded at the call site |
| `tests/unit/av-rescan-executor-record.test.ts` | Behavioural lock — the distinguishability property, the field-drift check, the success-not-retried lock |

## Decisions

- **Spread, not a longer hand list.** Re-enumerating would fix today's six
  fields and re-create the failure mode. The spread cannot silently drop a
  future one.

- **`durationMs` is the one field dropped, by name.** The result's is the job
  body's own measure; `JobRunResult.durationMs` is the executor's wall clock
  including the dynamic import. Two different numbers under one name in one
  record is a reader's trap. Excluding a NAMED field is safe in a way that an
  inclusion list is not — it cannot swallow a field that does not exist yet.

- **A halt is NOT reported as `JobOutcome.status: 'PARTIAL'`.** Two independent
  reasons.

  *It would be invisible.* `makeResult` reads `JobOutcome.status` only to
  compute `success` (`!== 'ERROR'`); `errorMessage` and `noRetry` are gated on
  `ERROR`, and the status string itself is never written to `JobRunResult`.
  Passing `PARTIAL` yields a record identical to passing nothing — a change
  that reads like a fix and moves no information.

  *The meaning would be wrong.* `PARTIAL` already means something in this file:
  a directory synced across several runs, each storing a cursor and stopping,
  resuming unattended on the next tick — "working as designed, do not page
  anyone". A halted rescan is the opposite: it stopped BECAUSE its verdicts
  looked wrong, and `AV_RESCAN_HALT_REMEDIATION` requires a human to verify the
  signature database before a re-run.

  So the run's status stays a success — it is not a job failure and BullMQ must
  not retry it — and what says the true thing is `details.halted` +
  `haltReason` + `haltRemediation`, which an operator and an alert rule can both
  match on.

- **The test asserts the property, not the fields.** Both runs in the
  distinguishability case carry identical counters, so the halt is the only
  thing that can separate them; every top-level field is asserted EQUAL, which
  is what makes `details` differing the load-bearing assertion. Reverting the
  source change fails three of the four tests, including that one.
