# 2026-08-21 — connectionId phase 2: the grain becomes the connection

**Commit:** `<pending>` fix(identity): make an account belong to the connection that observed it

Phase 1 (#2058) added `ConnectedIdentityAccount.connectionId` as a nullable
column and scoped the nightly deprovision reconcile to it, closing a defect where
two directory connections under one tenant marked each other's accounts
DEPROVISIONED every night, both passes reporting PASSED.

It deliberately stopped short of the end state. This is the rest, and it could not
have shared that deploy.

## Design

### What phase 1 could not do, and why

Two things blocked it, both about the release in between:

- **The old unique was load-bearing during the rolling deploy.** Containers
  running the pre-#2058 image upserted through
  `tenantId_provider_externalUserId`. Dropping it in the same release that
  introduced the column would have failed their writes outright.
- **`createSnapshotWriter.readState` was unambiguous only while that unique
  stood.** Widening the key makes the DRY_RUN reader ambiguous — and DRY_RUN is
  the only mode any tenant runs, so it is not a dormant branch.

Both conditions have now cleared. The phase-1 image is deployed (verified: the
column exists in production) and `COUNT(*) WHERE connectionId IS NULL` is **0**.

### The window is empty, and that is measured rather than assumed

Dropping the old unique still breaks the phase-1 image's upsert key in principle.
In practice production holds **zero** `IntegrationConnection` rows of any provider
and **zero** `ConnectedIdentityAccount` rows, so no sync runs and the upsert path
is never exercised. The same argument that made phase 1 free makes phase 2 free —
and it closes the day a customer connects a directory, which is why both halves
were taken now rather than left for later.

### Three deletions, each removing something that had become false

- **The reconcile's null arm.** Phase 1 included unattributed rows when the
  tenant held one connection, because excluding them would have silently stopped
  deprovisioning every pre-column row — with the deprovisioned count reporting 0,
  which reads exactly like a healthy directory. `connectionId: null` now matches
  nothing, so the arm is dead and the extra `COUNT` query that decided whether to
  widen has nothing left to decide. Its removal is asserted **positively** — the
  test checks the count query is no longer issued, rather than assuming.
- **The DRY_RUN arm's position.** It sat above the connection refusals so a dry
  run could still observe with zero or several connections. Phase 2 makes that
  worse than refusing: with no connection there are no account rows either, so
  every candidate returns "no observed directory record" — a FAILED per account
  instead of one named `NO_CONNECTION` for the run. Since #2066 the refusal is
  recorded, so it appears in the seven-day artefact rather than as silence.
- **`ON DELETE SET NULL`.** With the column required an orphan cannot be
  represented, so the FK cascades. This is a real behaviour change for connection
  deletion, called out in the migration header.

The reversal is **scoped, not wholesale**: `SECRETS_UNREADABLE` stays below the
dry-run arm, because `selfAccountIdsFromConnection` degrades to what `configJson`
alone can say. An undecryptable secret still yields a dry run with one bind
protected instead of none. A companion test pins that, so the scope of the
reversal is itself checked.

### `SET NOT NULL` is allowed to fail the deploy

If any row still carries a NULL, the migration aborts. That is intended. A row
that cannot say which directory it came from is exactly what this column exists to
prevent, and guessing one during a migration would write a wrong attribution
permanently. The backfill re-runs first, so only genuinely unattributable rows can
reach the statement, and the header says what to do if it fires.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/personnel.prisma` | `connectionId` required; unique swapped to `(tenantId, connectionId, externalUserId)`; FK cascades |
| `prisma/migrations/20260821170000_connected_identity_account_connection_required/` | backfill → NOT NULL → swap uniques → re-create the FK |
| `src/app-layer/usecases/identity-sync.ts` | upsert keyed on the connection; the null arm and its COUNT removed |
| `src/app-layer/integrations/identity-writer-factory.ts` | snapshot reader scoped to its connection; DRY_RUN arm moved below the connection refusals |
| `tests/guards/identity-providers-connector.test.ts` | the pinned unique updated to the new grain |
| the two RLS integration suites | accounts now created with the connection that observed them |

## Decisions

- **`AMBIGUOUS_CONNECTION` was NOT narrowed**, though the task listed it. With
  `connectionId` mandatory the accounts are no longer ambiguous — but a writer is
  still resolved per (tenant, provider) rather than per account, so one of two
  connections would have to be chosen for all of them. Narrowing it properly means
  grouping candidates by connection and resolving a writer per group, which is a
  larger change than a unique swap and belongs in its own diff. The refusal's
  wording was corrected to say why it still refuses.
- **`provider` stays in the reconcile predicate** even though `connectionId`
  implies it. It keeps the statement readable and correct on a connection that
  legitimately bypasses RLS, and it is the column the index leads with.
- **Two tests written earlier the same day were reversed, not deleted.** Each
  carries the phase-1 reasoning, why it was right then, and what makes it false
  now. A test that quietly changes sides is indistinguishable from one that was
  wrong all along.
