# 2026-08-21 — av-rescan: surviving a poison row, and a breaker on mass condemnation

**Commit:** `fix(av-rescan): survive a poison row and halt on an abnormal infected ratio`

Two independent defects in `runAvRescan`, fixed together because they live in
the same loop and the second one needs the first one's `continue` to exist.

## Design

### 1. A `scanBuffer` throw no longer aborts the page

`#120` (the attempt/backoff work) made every row that fails with a *handled*
outcome stop holding the head of the page: it records an attempt in
`scanAttempts` / `lastScanAttemptAt` / `nextScanAttemptAt` and the selection
skips it until the backoff expires. That note recorded the gap it left, in as
many words: a row that makes `scanBuffer` **throw** rather than return
`{ status: 'ERROR' }` still escapes the per-row handling and takes the batch
with it.

The escape was real and reproducible against `main` — the call site was a bare
`const result = await scanBuffer(buffer);`, so a throw propagated out of the
`for`, out of `runJob`, and out of the executor. The consequence is worse than
losing one run: nothing is written for the poison row, so the *next* run selects
the same page, dies on the same row, and the backlog never moves. One file that
upsets clamd is a permanent outage of the sweep.

The call is now wrapped. The catch does exactly what the other five
leave-pending branches do — no verdict is fabricated, the row keeps its honest
`PENDING`, and `leavePending(row)` records the attempt so the backoff carries
it out of the way. It is counted as `scannerThrew`, not folded into
`scannerError`: "clamd answered ERROR forty times" and "the call to clamd came
apart forty times" send an operator to different pages of the runbook.

### 2. An infection-ratio circuit breaker

This job condemns files unattended and `INFECTED` is terminal for a download.
The only way back is an OWNER walking
`POST /api/t/:slug/admin/files/:fileId/clear-quarantine` (shipped separately),
file by file, with a written reason each time. So a rescan that flips a large
FRACTION of a tenant's library is a shape worth stopping: a bad signature
update looks exactly like that, and an actual outbreak across most of an
evidence library does not.

After each row that reaches a verdict, `infectionBreakerTripped(out)` is
evaluated:

```
settled = clean + infected
settled >= AV_RESCAN_INFECTION_BREAKER_MIN_VERDICTS   (20, an ABSOLUTE floor)
  && infected / settled > AV_RESCAN_INFECTION_BREAKER_RATIO   (0.5)
```

and on a trip the loop `break`s with `halted` / `haltReason` /
`haltRemediation` set, a dedicated `av-rescan.halted` log event, and an
`AV_RESCAN_HALTED` audit row anchored on the tenant.

`out.scanned` changed from `rows.length` (set before the loop) to an increment
per row examined, so a halted run does not claim credit for rows it never
looked at.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/jobs/av-rescan.ts` | The per-row try/catch, the `scannerThrew` counter, the breaker constants + predicate + halt block, and `scanned` becoming incremental. |
| `tests/unit/av-rescan-poison-row.test.ts` | Ten behavioural assertions over an in-memory FileRecord table — four for the throw, six for the breaker. |

## Decisions

- **The breaker's denominator is SETTLED rows, not rows examined.** A page half
  of which could not be read from storage says nothing either way about whether
  the signature is sound. Counting those in the denominator would let a storage
  outage silently suppress a breaker that should have fired — the failure mode
  where two problems cancel into a green run.

- **The absolute floor is the half that stops the breaker being harmful.** A
  ratio on its own halts a three-file tenant with one genuine infection at 33%,
  and a one-file tenant at 100%, turning a working scan into an operator ticket
  every time. Below 20 settled rows the ratio is not evaluated at all. The
  companion test seeds `MIN_VERDICTS - 1` rows at a 100% infection rate and
  asserts the run completes — dropping the floor turns that test red.

- **The ratio is 0.5 — chosen high rather than sensitive.** The signal being
  caught is a bad signature update, which condemns essentially everything it
  looks at, so the true positive sits near 1.0. Halting is not free: every row
  behind the breaker stays PENDING and un-previewable until a human decides, so
  a jumpy threshold trades one library-wide failure for a recurring one.

- **Verdicts already written are LEFT ALONE — no rollback.** The temptation is
  to un-condemn what this run condemned, and it is wrong twice over. The run
  doing the reversing is the same one that has just declared it does not trust
  its own verdicts; and an unattended `INFECTED` → `CLEAN` write with no reason
  string and no human is precisely the shape the clear-quarantine route was
  built to prevent. The halt output names that route instead.

- **Rows behind the breaker keep `scanAttempts` at zero.** They were never
  examined, so they have not earned a backoff. Recording one would delay the
  legitimate re-run after an operator has fixed the signature database.

- **The halt is a distinct log EVENT and a distinct audit action, not a field
  on the completion line.** From the outside a halt and a clean finish are the
  same shape — both return a result, both may have scanned fewer rows than the
  limit — so the difference has to be something an alert can match on.
  `AV_RESCAN_HALTED` also puts it in the SIEM stream next to the
  `FILE_QUARANTINED` rows it is casting doubt on.

- **The breaker check sits AFTER the audit write for the row, not before it.**
  Evaluating mid-row would leave a verdict durable with no audit entry — the
  exact ordering failure the job's existing "verdict before audit" rule is
  organised against.
