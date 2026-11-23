# 2026-11-23 — Retry a failed Managed Agents session delete periodically (#5843)

**Commit:** `fix(agents): retry a Managed Agents session whose delete failed (#5843)`

## Design

Step 5b's settle records `SESSION_DELETE_FAILED` when Anthropic refuses a
session delete or cannot be reached. Step 5c's periodic reconciliation, run by
`data-lifecycle`, read back only sessions recorded DELETED (a lost delete), so a
failed delete was retried only by a purge, a connection removal or, for a kept
session, a DSAR erasure. The session, with the run's instructions, tool inputs
and read results, stayed in the customer's workspace.

The same reconciliation (`reconcileLostSessionDeletes`) now does two things per
tenant, under one deadline:

```
tenants: anthropic-workspace connections, tenant not soft-deleted (unchanged)
  1. failed deletes   readFailedDeletes → retryFailedDeletesFor (per recorded connection)
       FAILED SYNTHESIS steps on MANAGED_AGENTS runs, newest first, ≤ 1,000   (plaintext status)
       → that runs' session steps, decrypted → latest == DELETE_FAILED, never KEPT
       → ≤ 100 oldest first → deleteSession (5c's call, one constructor's client)
       → DONE / ALREADY_GONE: SESSION_DELETED step on the run's ledger
       → anything else: left for the next pass, metric with the named outcome
  2. lost deletes     unchanged (sessions recorded DELETED in the last 7 days)
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/managed-agents-cleanup.ts` | `readFailedDeletes`, `awaitsDeleteRetry`, `retryFailedDeletesFor`, `recordSessionDeleted`; the ledger reader learns each session's latest step and a `runIds` filter; the reconciliation runs both halves |
| `src/lib/agentic/managed-agents/session-ledger.ts` | New: the session step's label, lifecycle type and record shape, shared by the run's settle and the reconciliation |
| `src/lib/agentic/managed-agents/execute.ts` | Writes its session steps through `sessionStepRecord`; re-exports the label and type |
| `src/lib/observability/integration-metrics.ts` | `agentic.managed_agents.failed_delete_retry`, by outcome |
| `src/app-layer/jobs/executor-registry.ts` | Comment: what data-lifecycle's reconciliation now covers |
| `tests/integration/managed-agents-cleanup.test.ts` | The retry over a real DB and the faux workspace |
| `tests/unit/agentic/managed-agents-cleanup.test.ts` | `awaitsDeleteRetry` over lifecycle sequences |
| `tests/helpers/managed-agents-faux.ts` | Ids unique across faux instances in one file |
| `tests/unit/executor-registry.test.ts` | The mock's return shape |
| `CLAUDE.md`, `docs/claude-managed-agents-design.md` | The reconciliation's scope |

## Decisions

- **Extended the one reconciliation, no second mechanism.** No new record
  type, table or job: the ledger is the state, and writing `SESSION_DELETED` is
  what takes a session out of the retry.
- **"Latest step", not "has a FAILED step".** A session a later pass deleted
  carries both DELETE_FAILED and DELETED; only the latest says whether it is
  still Inflect's to delete. Steps are read oldest first, so the last one seen
  is the latest.
- **A session that was ever KEPT is excluded outright**, beyond the latest-step
  rule, because decision 4 makes a kept session the customer's choice, deleted
  only by a purge, a removal or an erasure. The settle never writes both today.
- **Found by the plaintext `status`, not the lifecycle.** `inputJson` is in the
  encryption manifest, so the database cannot filter on the lifecycle. On a
  Managed Agents run every SYNTHESIS step is a session step, and only
  DELETE_FAILED is written `FAILED`, so the first read decrypts nothing; only
  the candidate runs' steps are decrypted.
- **The bound.** Per tenant per pass: the newest 1,000 failed steps
  (`FAILED_DELETE_READ_CAP`, one read past it so truncation is a fact, metered
  `LEDGER_TRUNCATED`), at most 100 sessions attempted (`FAILED_DELETE_RETRY_BATCH`),
  the existing 60 s deadline, and a refused key, an unreachable provider or the
  deadline ends that connection's pass without sending the rest (5c's halting
  rule). Tenants stay capped at 1,000. There is no lookback window: a failed
  delete is retried however old it is. A resolved failed step still occupies
  the read cap, which is why it reads the NEWEST; the oldest wait only past
  1,000 failed deletes in one tenant, and that is metered.
- **No abandonment.** A session left by every pass (a revoked key) is retried
  daily and metered each time. Giving up after N days would be a product
  decision the brief did not make, unlike the 5c records' `ABANDONED`.
- **"Record the named outcome" is the metric and the log line, not a ledger
  step.** Writing another DELETE_FAILED step each day would grow the ledger
  by one row per stuck session per day and add nothing the metric lacks.
- **The DELETED step is written as a JOB** (`buildSystemContext`), through
  `recordStep`, the ledger's one write seam, at the run's next `seq`. If the
  write fails after the delete, the next pass reads the session back as a 404,
  which counts as deleted, and writes it then.
- **The faux's ids are file-unique.** The reconciliation crosses every live
  tenant in the database, and the suite keeps earlier tests' ledgers; with
  per-instance ids an earlier test's recorded `sesn_0010` named this test's
  `sesn_0010`, which real ids never do.
