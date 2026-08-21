# 2026-08-21 — AV rescan: split the attempt record from the verdict, and back off

**Commit:** `fix(evidence): record scan attempts separately from verdicts so the rescan sweep can drain`

## Design

`av-rescan` selects `FileRecord` rows at `scanStatus: 'PENDING'`, oldest-first,
under a `take`. Every branch that cannot honestly produce a verdict — the object
is gone from storage, the bytes no longer hash to `FileRecord.sha256`, clamd
returns `ERROR`, the file is over the stream cap, the scanner answered with the
synthetic `engine: 'disabled'` — deliberately leaves the row PENDING. That is
the correct call in every case: the alternative is fabricating a verdict, and
`SKIPPED` is servable.

It is also, on its own, a queue that cannot drain. Those rows are the OLDEST, so
oldest-first selection puts them at the head of the page on every subsequent
run, forever, and nothing behind them is ever examined. "The backlog never
drains" is the user-visible complaint the whole AV chain exists to fix, so the
sweep reproduced it.

The fix is two halves, and they are load-bearing separately.

**Split the attempt record from the verdict write.** A verdict
(`scanStatus` / `scanDetails` / `scannedAt`) is terminal, rare, and safety-
relevant: `isDownloadAllowed` reads it, an auditor reads it, and the whole job
is written around never manufacturing one. An attempt is frequent and says
nothing about the file. They now live in disjoint columns
(`scanAttempts` / `lastScanAttemptAt` / `nextScanAttemptAt`) written by a
separate statement, `FileRepository.recordScanAttempt`, which refuses at
runtime to touch any verdict column. A row that DOES reach a verdict is written
exactly as before — no bookkeeping rides along.

**Back off.** `scanAttemptBackoffMs` doubles from a 15-minute floor to a
24-hour ceiling. The sweep's predicate gains
`OR: [{ nextScanAttemptAt: null }, { nextScanAttemptAt: { lte: now } }]` and
its ordering becomes `[{ scanAttempts: 'asc' }, { createdAt: 'asc' }]` — the
gate keeps a failing row out of the page while it is backed off, and the
ordering means that even when it IS due it cannot outrank a row nobody has
tried. `NULL` reads as "due now", so every row that predates this ships due.

```
select PENDING ∧ (nextScanAttemptAt IS NULL ∨ ≤ now)   order by attempts, createdAt
    │
    ├─ verdict reached   → updateMany{ id, scanStatus:'PENDING' } SET verdict cols   (unchanged)
    └─ left pending      → updateMany{ id, tenantId, scanStatus:'PENDING' } SET attempt cols
                            attempts+1 · lastScanAttemptAt=now · nextScanAttemptAt=now+backoff(n)
```

## Files

| File | Role |
| --- | --- |
| `prisma/schema/evidence.prisma` | The three attempt columns + `@@index([tenantId, scanStatus, nextScanAttemptAt])` backing the sweep's predicate. |
| `prisma/migrations/20260821040000_file_record_scan_attempt_backoff/migration.sql` | Additive `ALTER TABLE` + the index. Nullable-or-defaulted throughout. |
| `src/app-layer/repositories/FileRepository.ts` | `scanAttemptBackoffMs` policy, `recordScanAttempt` (+ its verdict-column guard), and the backoff-aware `findPendingScan`. |
| `src/app-layer/jobs/av-rescan.ts` | Due-only selection, the `leavePending` helper on all five leave-pending branches, and a `backedOff` counter in the result. |

## Decisions

- **The attempt is recorded on the leave-pending branches, not before the
  scan.** Recording first would be crash-safe (a worker killed mid-scan would
  still back the row off) but it directly contradicts the existing
  `#121 writes nothing before the scanner has answered` invariant, which exists
  because a pre-scan stamp is one refactor away from a lease and a lease loses
  rows permanently. Duplicated work on a crash loop is the cheaper failure, and
  it is the same trade the job already makes for concurrency. The consequence
  is a known gap: a row that makes `scanBuffer` *throw* (rather than return
  `ERROR`) still aborts the page, and is not backed off. That is a separate
  defect and is left alone here.

- **`recordScanAttempt` carries `scanStatus: 'PENDING'` in its predicate.** Not
  for concurrency safety — a stale counter is harmless — but so the counter can
  never describe a row that has already left the queue. The tenant id is in the
  predicate too, as defence in depth beside RLS, per the repository convention.

- **The verdict-column guard is a runtime throw, not a code comment.** The
  columns are one merged object literal away from being written together, and
  the failure mode (a bookkeeping write moving `scanStatus`) is exactly the one
  this job's whole design is organised against. A reviewer noticing is not a
  control.

- **Backoff is capped rather than unbounded.** The failure modes do get fixed —
  storage is restored, clamd is upgraded — and a row has to come back to the
  queue on its own when they are, without an operator knowing to go looking for
  it. `scanAttemptBackoffMs` also fails closed to one attempt for a non-finite
  count, because `new Date(now + NaN)` is an Invalid Date, which Prisma writes
  as NULL, which reads back as "due now" and reinstates the starvation.

- **The unit test's Prisma mock is an in-memory TABLE, not a call recorder.** A
  test that only inspected the `findMany` arguments would pass against a
  correctly-spelled `where` with a wrong `orderBy`, and against a backoff whose
  delay is always zero. The headline assertions instead run the sweep twice and
  read the only thing an operator cares about: did the row behind the broken
  one get scanned?

- **`writtenPayloads()` in the existing suite became `verdictPayloads()` at six
  call sites.** Those assertions read `toEqual([])` — "the job wrote nothing".
  Post-split that is no longer the invariant they were protecting; the narrower
  and still-exact claim is that no VERDICT was written.
