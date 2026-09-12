# 2026-09-12 — the roster read is composed with the lock lease (#2508)

**Commit:** `e53afd614 fix(integrations): bound the HRIS roster read so it cannot outlive its lock lease (#2508)`

## Design

`jobs/hris-sync.ts` takes a per-connection lease before calling the usecase.
The lease is what makes the run the sole writer, and `acquireSyncLock` reaps
one older than `SYNC_LOCK_TTL_MS` (30 min). A reaped lease does **not** abort
the run holding it — it lets a second run start. The two then share
`syncCursor` and `syncPassStartedAt`, and whichever completes its pass first
clears both and reconciles against its own `passStartedAt`, terminating
employees the other has not reached, which the other upserts back. That is the
flip-and-flip-back corruption `jobs/hris-sync.ts` already documents.

#2501 moved the provider read out of the 5-second transaction. That removed the
budget the read was blowing and left it bounded by nothing at all, which is the
problem one layer up.

### The arithmetic, corrected

| layer | constant | value |
|---|---|---|
| one HTTP request | `DEFAULT_TIMEOUT_MS` | 30,000 ms |
| one absorbed Retry-After | `MAX_ABSORBED_RETRY_AFTER_MS` | 60,000 ms |
| attempts per request | `MAX_HTTP_ATTEMPTS` | 3 |
| sequential pages per run | `WORKDAY_MAX_PAGES_PER_RUN` | 10 |

`MAX_HTTP_REQUEST_MS` is **210 s**, not the 270 s the issue composed.
`createResilientFetch` throws on the final attempt instead of sleeping after
it, so three attempts carry two sleeps: `3 × 30 s + 2 × 60 s`. The same bound
covers a page that eventually *succeeds* — two throttled attempts then a slow
200 costs exactly the same. Ten pages is therefore 35 minutes of read, not 45;
either way it is longer than the 30-minute lease, so the defect stands.

**Ten pages is a FLOOR, not a ceiling**, which the issue's table does not say
and the first draft of this change got wrong too. The paging loop's row test
counts NORMALISED employees and `normalise` drops any row with no work email,
so a report carrying email-less rows never advances toward `WORKDAY_MAX_PER_RUN`
and pages on until a short page ends it. A row-count cap cannot bound
wall-clock time because it does not bound REQUESTS. That strengthens the case
for a clock rather than weakening it, and
`tests/unit/roster-read-within-lock-lease.test.ts` demonstrates it against a
report made entirely of droppable rows.

### The option chosen, and the direction it fails in

Five were on the table. **(a) bound the read** was taken.

- **(b) renew the lease while the read progresses** buys a *weaker* invariant
  here. Renewal keyed on "a page came back" cannot tell a run making real
  progress from one being throttled into uselessness, so a pathologically
  throttled run holds the connection for unbounded wall-clock time and blocks
  its own retry forever — (c)'s weakness with no ceiling. It also puts a
  database write back into the phase #2501 just finished clearing of database
  work, and threads the lock (held in the job) into the provider (reached
  through the usecase), which is the separation `tests/stress/README.md` and
  the job's own comment make explicit.
- **(e) absorb a smaller Retry-After** — shrinking `MAX_ABSORBED_RETRY_AFTER_MS`
  — is the option issue #2508 itself listed, and it is the one worth spelling
  out because it looks like it should work. It shrinks the per-REQUEST bound
  (`MAX_HTTP_REQUEST_MS` is `MAX_HTTP_ATTEMPTS * DEFAULT_TIMEOUT_MS` plus the
  absorbed sleeps) and does nothing to the REQUEST COUNT. The count is the
  unbounded term: a page whose rows are all droppable advances the cursor
  without growing `seen`, so the row cap never trips and the walk continues —
  the failure the droppable-row fixture above reproduces. A smaller constant
  multiplied by an unbounded page count is still unbounded, so (e) lowers the
  number without changing its boundedness. That is why the deadline is on the
  READ AS A WHOLE rather than on any request inside it.
- **(c) raise the TTL** is the weakest, as the issue says. `SYNC_LOCK_TTL_MS`
  is also the reaper's threshold, so raising it lengthens exactly the window in
  which a connection killed mid-sync stays wedged — the wrong direction on the
  input that causes the problem.
- **(d) detect lease expiry and abort before writing** is a correct *backstop*
  and a wrong *fix*: it does not prevent the overlap, only stops the loser
  writing. Run B has already started; A aborting after 35 minutes throws the
  work away, and against a reliably slow provider every run reads, loses the
  lease and aborts — a livelock in which the pass never completes and the
  departure reconcile never runs. Silent no-progress is the same shape as the
  bug the reconcile exists to prevent.

**(a) fails towards doing less per run, never towards two writers.** A run that
cannot finish its read inside the budget stops early and reports PARTIAL with a
stored cursor — the resume machinery #2501 exercised. The cost is that a
sustained throttle makes a pass take more scheduled runs; the honest worst case
is a provider throttled hard enough that a run gets ~3 of 10 pages, which shows
as repeated PASSED-with-`partial: true` execution rows and an advancing cursor
rather than as silence.

### Where the deadline lives

`ROSTER_READ_DEADLINE_MS` (10 min) is handed down as an absolute instant:

```
usecases/hris-sync.ts     readDeadlineAt = start + ROSTER_READ_DEADLINE_MS
  → HrisSyncDeps.readDeadlineAt
    → providers/workday/index.ts   forwarded PAST the OAuth token exchange
      → providers/workday/roster.ts  checked BETWEEN pages
```

Checked between pages, never mid-request: aborting a page in flight throws away
the rows it carries. So the enforced ceiling is
`ROSTER_READ_PHASE_BUDGET_MS = ROSTER_READ_DEADLINE_MS + MAX_HTTP_REQUEST_MS`,
and `tests/guards/sync-transaction-budget-composes.test.ts` asserts
`read + write <= SYNC_LOCK_TTL_MS` (810 s + 820 s ≤ 1,800 s).

Adding one request rather than one per remaining page holds only while the
token exchange — the one request issued *before* the paging loop, and
`resolveWorkdayAccessToken` never loops — finishes inside the deadline. That
precondition is `MAX_HTTP_REQUEST_MS < ROSTER_READ_DEADLINE_MS`, asserted
rather than left as prose. **Strictly** less than: the reader's check is
`now >= deadline`, so `<=` would be enough for the budget arithmetic and would
*not* be enough for the other thing the source claims — that every run gets to
attempt at least one page.

### The 120 s citation was a ghost, and its provenance is the lesson

`connection-lock.ts` justified its 30 minutes against "a 5000-account directory
enumeration at a 120 s per-page budget". No constant in the tree carries 120 s.
Git says why: `ENUMERATION_TIMEOUT_MS` (120 s) was added to `bounded-fetch.ts`
by **#1950** (30f371e61), cited by the lock in **#1958** (3e9939ce3), and
deleted by **#1970** (5504160a2) for never having had a consumer. The prose
justification outlived the constant it rested on and nothing failed. The
replacement names `ROSTER_READ_PHASE_BUDGET_MS + SYNC_WRITE_PHASE_BUDGET_MS`
and restates neither number — a restated number is what drifts.

## Files

| file | role |
|---|---|
| `src/app-layer/integrations/sync-transaction.ts` | derives `MAX_HTTP_REQUEST_MS`, declares `ROSTER_READ_DEADLINE_MS`, derives `ROSTER_READ_PHASE_BUDGET_MS`; the "read is not composed" paragraph is replaced |
| `src/app-layer/integrations/connection-lock.ts` | TTL docblock: the 120 s ghost replaced by the derived composition + why raising the TTL is the worst fix |
| `src/app-layer/integrations/providers/hris/index.ts` | `HrisSyncDeps.readDeadlineAt` — the contract, including "stop WITH a resume token" |
| `src/app-layer/integrations/providers/workday/roster.ts` | `WORKDAY_MAX_PAGES_PER_RUN`; the between-pages deadline check |
| `src/app-layer/integrations/providers/workday/index.ts` | forwards the deadline past the token exchange |
| `src/app-layer/usecases/hris-sync.ts` | computes the deadline from the run's own `start` |
| `tests/guards/sync-transaction-budget-composes.test.ts` | the read + write ≤ lease composition, non-vacuity, and the token-exchange precondition |
| `tests/unit/roster-read-within-lock-lease.test.ts` | the conduct the arithmetic assumes, at all three seams |

## Decisions

- **The deadline is an absolute instant, not a duration.** A duration would be
  restarted at every seam it crossed, and the Workday provider crosses one
  after its token exchange — a fresh ten minutes there is exactly the bug.
- **A short page outranks the deadline.** The reader returns `complete: true`
  when the report ended even if the clock has passed. Checking the clock first
  would store a cursor past the end of the report and defer the departure
  reconcile a whole scheduled run to rediscover what this run already knew.
- **A deadline stop must carry a resume token.** `usecases/hris-sync.ts` splits
  a truncated roster on the token's presence: with one it is a PARTIAL the next
  run continues, without one it is `ERROR, noRetry: true` — permanent, for that
  connection, forever. Stopping without a cursor would convert "throttled
  provider" into "a roster that can never finish".
- **`SYNC_LOCK_TTL_MS` stays an explicit number, not a derived one.** Deriving
  it from the two budgets would mean raising the chunk size silently widened
  the reaper's window. Keeping it explicit and asserting the composition is
  what makes the next move somebody's decision.
- **`WORKDAY_MAX_PAGES_PER_RUN` uses `Math.ceil`, and is documented as a
  FLOOR.** A page size that no longer divides the row cap must round up, or the
  figure understates the work by a whole request — and even rounded up it is
  only the page count needed to reach the row cap with no dropped rows.
- **The droppable-row fixture carries a tripwire, and the mutation proof is why.**
  Mutating the deadline away was first measured against an untripwired version:
  the loop ran until the jest worker died of heap exhaustion after 150 seconds,
  reported as "Test suite failed to run" naming no test. A regression that reads
  as an OOM is a regression nobody attributes to this change — a jest worker
  dying of heap exhaustion names no test, so the failure points at the runner
  rather than at the diff. The fetch double now throws a
  named error on the first page past the budget, so the same mutation fails in
  seconds with the sentence "roster read did not stop on its deadline".
- **`UNBOUNDED_ROSTER_READ_MS` lives in the guard, not in source.** It is the
  diagnosis the deadline replaces, and a constant nothing consumes is precisely
  the shape #1970 deleted — and the shape whose ghost this PR is cleaning up.

  **That principle has to be read against `WORKDAY_MAX_PAGES_PER_RUN`, which
  this same PR adds to `roster.ts` with no `src/` consumer** — only the guard
  and the unit test import it. The two are not in tension once "consumer" is
  read precisely. `#1970` deleted a constant that stated a budget NOTHING
  checked, so nothing could notice when it stopped being true.
  `WORKDAY_MAX_PAGES_PER_RUN` is a DERIVATION —
  `Math.ceil(WORKDAY_MAX_PER_RUN / WORKDAY_PAGE_SIZE)` — whose two inputs are
  live source constants, so it cannot drift from them, and the guard asserts
  exactly that. Exporting the derivation rather than restating `10` in two
  test files is what keeps the arithmetic honest. A constant is dead when
  nothing would notice it going stale; this one goes red the moment either
  input moves.
- **identity-sync is NOT covered, and both docblocks say so.** Okta and Google
  Workspace fan out a per-user enrichment request after the page walk
  (`enrichAccounts`, `enrichSso`), so their worst case is a different
  derivation. Claiming "the read phase is bounded" would be the same class of
  false comment as the 120 s citation.
