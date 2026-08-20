# 2026-08-20 — `av-rescan`: bounded one-off rescan of PENDING evidence

**Commit:** `feat(av): bounded one-off rescan job for PENDING FileRecords`

## Design

Evidence preview is blocked in `strict` mode until a `FileRecord` carries a
verdict, and until the inline upload scan shipped nothing ever moved a row off
its `scanStatus: 'PENDING'` default. Those rows are un-previewable forever,
because the only writer of a verdict was the request that already held the
bytes. `av-rescan` re-reads them out of storage and finishes the job.

```
enqueue('av-rescan', { tenantId, initiatedByUserId, limit? })
        │
        ├─ AV_SCAN_MODE === 'disabled'?  → return immediately, zero rows touched
        │
        ├─ findMany({ tenantId, scanStatus: 'PENDING', status: 'STORED',
        │             deletedAt: null }, take: min(limit, 1000))
        │
        └─ per row, NO transaction open:
             sizeBytes > AV_SCAN_MAX_BYTES ────────────→ leave PENDING
             readStream + streamToBuffer (throws) ─────→ leave PENDING
             sha256(buffer) !== row.sha256 ────────────→ leave PENDING  (#114)
             scanBuffer(buffer)
               status ERROR ──────────────────────────→ leave PENDING  (#115)
               engine 'disabled' ─────────────────────→ leave PENDING  (#113)
               ↓
             updateMany({ where: { id, scanStatus: 'PENDING' },
                          data: { scanStatus, scanDetails, scannedAt } })
               count === 0 ───────────────────────────→ lostClaim, no audit
               count === 1 ───────────────────────────→ appendAuditEntry (#122)
```

The whole design follows from one sentence: this job writes verdicts
unattended, in bulk, on bytes it did not receive from the user. Every guard
above is a consequence.

The single most dangerous case is the synthetic CLEAN. `scanBuffer`
manufactures `{ status: 'CLEAN', engine: 'disabled' }` when `CLAMAV_HOST` is
unset, and `isDownloadAllowed` serves CLEAN in **every** mode. One unattended
run on a dev or CI box would therefore stamp CLEAN across every PENDING row in
the tenant, permanently, surviving a later switch back to `strict`. It is
blocked twice — a mode check before enumerating anything, and an engine check
after the scan — mirroring the inline path at `file-scan.ts:76` and `:136-138`.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/jobs/av-rescan.ts` | The job. Selection, per-row guards, conditional claim, audit. |
| `src/app-layer/jobs/types.ts` | `AvRescanPayload`, `JobPayloadMap` entry, `JOB_DEFAULTS` (`attempts: 1`). |
| `src/app-layer/jobs/executor-registry.ts` | `av-rescan` executor; maps the result counters onto `JobRunResult`. |
| `tests/guardrails/runtime-wiring-coverage.test.ts` | `ON_DEMAND_JOBS` entry — deliberately not scheduled. |
| `tests/unit/av-rescan-job.test.ts` | Behavioural suite; one block per acceptance property. |

## Decisions

- **A conditional claim, not a per-row lease.** The obvious concurrency
  control stamps the row before the scan so two workers do not duplicate work.
  That trades a duplicated 3-second scan for a permanent loss: a worker killed
  mid-scan leaves a row no later run selects and no gate ever serves. Nothing
  is written until a verdict exists; the `where: { scanStatus: 'PENDING' }`
  predicate then settles the race in the database, the same shape the AV
  webhook uses. It also means the job structurally cannot overwrite an
  INFECTED verdict or a fresher one another writer landed mid-scan.

- **Verdict before audit — the inverse of the inline upload path.** There the
  file is refused and never stored, so the audit entry is the only record it
  existed; losing it to a crash loses the event. Here the row persists either
  way, and the failure worth avoiding is the mirror image: an audit trail
  asserting a verdict a crash stopped us persisting. Auditing after the claim
  also means only the writes we actually won get audited.

- **`SKIPPED` is never written.** `isDownloadAllowed` serves SKIPPED, so it can
  never carry "too big to scan" or "the scanner was down". Both are "we do not
  know", and PENDING already says that honestly. Reasons are surfaced as
  separate counters on the result instead of being encoded in the column.

- **Byte identity is checked before the scanner sees the buffer.** A truncated
  read scans CLEAN — the scanner is happy with a prefix — and that CLEAN would
  be recorded against the whole object. `bundle-attachments.ts` already makes
  this check before an export bundle accepts a file; verifying it *before* the
  scan rather than after also saves a pointless clamd round trip. A mismatch is
  reported as a storage-integrity incident (`logger.error`), not a scan result.

- **No transaction is open anywhere in the loop.** clamd's timeout is 30 s; a
  transaction held across it pins a Postgres backend and, through PgBouncer's
  transaction pooling, a pooled server connection — once per file.

- **Provenance stays local to the job.** `source: 'rescan-job'` is written into
  `scanDetails` here rather than hoisted into a shared helper in
  `file-scan.ts`, so an operator reading a row can tell a rescan verdict from an
  `inline-upload` one — which is exactly what they need when a rescan turns out
  to have run against a misconfigured scanner.

- **Bounded, single-tenant, not scheduled.** Each row costs a full object read
  plus a scanner round trip, so `limit` is clamped to `AV_RESCAN_MAX_LIMIT`
  (1000) and the job is registered in `ON_DEMAND_JOBS`, not `schedules.ts`. It
  is idempotent by construction — a row with a verdict is no longer PENDING and
  is no longer selected — so the operator re-runs it until `scanned` is zero.
  `attempts: 1` for the same reason: the interesting failures (scanner down,
  storage unreadable) are not fixed by a 5-second backoff, and every attempt
  re-reads every object.

- **`scanStatus` is the only column written.** The quarantine column (`status`)
  belongs to the webhook path; this job must never be what flips it. The test
  suite asserts no write payload carries a `status` key.

## Not done

No admin HTTP route was added — the job is triggered by enqueue from an
operator entrypoint. Adding a route means a `route-permissions.ts` rule, an
OpenAPI snapshot refresh and the admin-route coverage lists; that is a
separate, self-contained change. No new OTel metric either: the outcome is
carried by `runJob`'s job metrics plus the per-reason counters on the result
and the structured completion log.
