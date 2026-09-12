# 2026-09-12 — the sync transaction budget (#2501)

**Commit:** `fix(integrations): take provider HTTP out of the sync transaction and leave evidence when a write fails`

## Design

`runHrisSync` and `runIdentitySync` each wrapped their ENTIRE body in one
`runInTenantContext` callback. That is `p.$transaction(cb, txOptions)`, and
`txOptions` is populated only from an explicit caller argument
(`db-context.ts:64-66`); neither sync passed one and the client sets no
`transactionOptions` (`prisma.ts:306-312`), so both ran on Prisma 7.10.0's
runtime default of `timeout: 5_000`. Exactly three explicit overrides exist in
`src/` — `asset.ts:650`, `framework/install.ts:197`,
`audit-readiness/packs.ts:370` — and neither sync was one.

Inside those five seconds sat the connection read, the `IntegrationExecution`
create, the PROVIDER ROSTER READ (for Workday, up to ten sequential HTTPS
fetches, each budgeted at 30 s and each able to absorb a 60 s Retry-After sleep
in-process), thousands of sequential upserts, a full-table read, the manager
links, the reconcile and the final execution update.

The failure erased its own record. When the budget blew, the rollback took the
`RUNNING` row created at the top AND the `ERROR` row the catch was writing,
because the catch's update ran on the same, now-closed, transaction client. The
observable was an ABSENCE of any execution row — which is what a dispatcher
that never fired, a disabled connection and a dead worker also look like.

The run is now four phases, and the order is the design:

```
1. short tx      read the connection, commit the RUNNING row
2. NO tx         the provider read (+ a rotated secret persisted in its own short tx)
3. write txs     chunked upserts · manager links · [measure + decide + sweep + clear cursor]
4. short tx      finalise the execution row + clearAuthFailure
```

Every failure arm from phase 2 onward writes its `ERROR` row in a transaction of
its own, on a client the failure has not closed.

## Files

| file | role |
|---|---|
| `src/app-layer/integrations/sync-transaction.ts` | NEW. The budget constants, the derived write-phase worst case, and `chunk()`. One place both syncs read the numbers from. |
| `src/app-layer/usecases/hris-sync.ts` | Split into the four phases; upserts and manager links chunked; a catch around the write phase that finishes the committed `RUNNING` row. |
| `src/app-layer/usecases/identity-sync.ts` | Same split. The two blast-radius COUNTs, the refusal decision, the `updateMany` and the cursor clear stay in ONE write transaction. |
| `tests/guards/sync-transaction-budget-composes.test.ts` | NEW. The arithmetic: write-phase worst case ≤ half the lock lease; both timeouts above Prisma's default; `chunk()` behaviour. |
| `tests/unit/sync-transaction-shape.test.ts` | NEW. A fake transaction runner that models nesting and client death. Where the read happens, how many upserts per transaction, and that a failed write's ERROR row lands on a live client. |
| `tests/integration/sync-transaction-budget.test.ts` | NEW. Real Postgres. Measures the 5 s default killing a 6 s body and erasing its row, then runs both syncs over the same fixture, then a three-leg resume pass whose first leg is wider than one write chunk. |
| `tests/guards/personnel-connector.test.ts`, `tests/guards/identity-providers-connector.test.ts` | Bare `/runInTenantContext/` needles bound to the `@/lib/db-context` import line. |
| `tests/guardrails/assertion-needle-uniqueness-ratchet.test.ts` | Class D baselines re-seated downward (1431→1428, 240→239) with history. |

## Decisions

- **Chunked write transactions, not one big one.** The reconcile does not need
  the upserts to commit WITH it; it needs every upsert of the pass to have
  ALREADY committed when it runs, which the sequencing gives (a failed chunk
  throws before the reconcile is reached). What is given up is rolling committed
  upserts back when a later step fails, and that direction is the safe one: rows
  refreshed with no reconcile keep the status the source reported, so the mirror
  over-reports people as PRESENT. The reconcile is the half that marks people
  TERMINATED / DEPROVISIONED and it cannot run on its own.

- **Prisma upserts, not a batched `INSERT … ON CONFLICT`.** Set-based SQL would
  be far fewer round trips and would go around the client extensions — the audit
  trail and the field-level encryption both hang off the model-level handlers in
  `lib/prisma.ts`. Trading the audit trail for latency is not a trade this
  subsystem gets to make silently.

- **Identity's measure-decide-sweep stays atomic.** The rails judge a COUNT and
  then act on it. Across two transactions a row could change status in between
  and the number an operator is shown would describe a different set from the
  one that was swept — the same defect this subsystem already fixed in the AD
  provider. The cursor clear rides in that transaction for the matching reason:
  a sweep that commits while the cursor survives leaves the next run resuming a
  pass that already reconciled.

- **The write-phase budget is DERIVED, and the guard multiplies it out.** The
  original complaint was three budgets nobody had composed, so
  `SYNC_WRITE_PHASE_BUDGET_MS` is computed from the chunk size and the per-run
  row ceiling rather than written down. Raising either fails
  `sync-transaction-budget-composes.test.ts`.

- **What is NOT composed is stated, not implied.** The roster read's own worst
  case (3 attempts × (30 s + 60 s) × 10 pages = 45 minutes) exceeds
  `SYNC_LOCK_TTL_MS` (30 minutes) on its own. #2501 does not change that and the
  module doc says so; #2508 carries it, including the lock comment that cites a
  120 s per-page budget no constant in the tree has.

- **The resume path was exercised deliberately, against a real database.**
  Fixing the budget makes `MAX_USERS` / `MAX_EMPLOYEES` reachable, which wakes
  resume/PARTIAL machinery that has never executed in production. The two halves
  of "hitting the cap" are proved in different places on purpose: that a
  provider at its cap returns `complete: false` plus a token is a provider fact,
  already measured against 5,000 fixture users in
  `tests/unit/integrations/okta-directory-enumeration.test.ts`; that the token
  survives Postgres and the next leg continues from it is a usecase fact, and
  the three-leg pass measures it — with a first leg wider than
  `SYNC_UPSERT_CHUNK_SIZE`, so the newly-introduced multi-transaction write path
  is what carries it, and a final leg that reads an empty page.

- **The write-phase catch is new, and it had to be.** Before this change a throw
  in the write phase took the `RUNNING` row with it and the run left nothing
  behind. Now the row is committed, so something must finish it or the
  connection shows a run that started and never ended. That arm sets no
  `noRetry`: unlike the deterministic truncation arms, a write that ran out of
  budget or lost the pool is exactly the shape a retry fixes.

## Rollback

Revert the commit. Nothing else has to be undone:

- **No schema change, no migration.** `syncCursor` and `syncPassStartedAt`
  already existed and are written with the same values in the same cases.
- **No new scheduled job and no queue change**, so a revert leaves nothing
  firing.
- **Rows written by the new shape are valid under the old one.** The execution
  row's columns and the `resultJson` keys are unchanged except for
  `writePhaseFailed: true` on the new write-failure arm, which nothing reads.
- **What a revert restores is the defect**, not a clean state: the 5-second
  budget comes back, large rosters go back to blowing it, and a blown run goes
  back to leaving no `IntegrationExecution` row at all. A connection that was
  mid-pass when the revert lands is safe either way — its stored cursor is read
  identically by both shapes.
