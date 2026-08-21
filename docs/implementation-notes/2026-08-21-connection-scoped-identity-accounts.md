# 2026-08-21 — Connection-scoped identity accounts, and a checkbox that could not say yes

**Commit:** `<pending>` fix(identity): scope the deprovision reconcile to a connection, and let a ticked checkbox mean true

Two defects that share nothing except the moment they were found: one silently
corrupts directory state, one silently withholds a feature. Both were found by
investigating an operator decision rather than by a test.

## Design

### The reconcile matched the wrong thing

`IntegrationConnection` is unique on `(tenantId, provider, name)`. One customer
may therefore hold two AD forests, or two Entra tenants, under one Inflect
tenant — a supported configuration nothing refuses.

`ConnectedIdentityAccount` had no way to record which of them observed a given
account, so the nightly deprovision reconcile could only scope itself by
`provider`:

```sql
WHERE tenantId = X AND provider = 'active-directory' AND syncedAt < passStartedAt
```

Connection A syncs, touches only forest-A accounts, then marks DEPROVISIONED
everything for that *provider* it did not touch — all of forest B. B's pass then
does the reverse. Both report `PASSED`. The per-connection sync lease is keyed on
connection id, so nothing serialises them.

This runs on the **read** path. It needs no write permission, no Entra consent,
no AD bind, and no leaver pass. Any admin creating a second connection triggers
it, and the damage does not stay in one column: `DEPROVISIONED` is what the link
reconciler and `findLeaverCandidates` read.

The fix is a `connectionId` on the account row, claimed by the sync on every
pass, and a reconcile scoped to it.

### The null arm, which is the part worth reading

A row observed before the column existed — or one whose connection was deleted,
`onDelete: SetNull` — carries `NULL`. Neither obvious treatment is right:

- **Exclude nulls.** Those rows silently stop deprovisioning, and the silence is
  the dangerous half: `recordIdentityDeprovisioned` reports `0`, which reads
  exactly like a healthy directory.
- **Include nulls always.** In a two-connection tenant an unattributed row may
  belong to the *other* connection — the original bug in a new spelling.

So nulls are included only when the tenant has exactly **one** connection for
that provider, which is the case where "the other connection" does not exist and
the attribution is not in doubt. That is every tenant in the field today, so
observable behaviour is unchanged; the narrowing bites only for the
configuration that was already broken.

### Why the unique constraint did NOT change

The grain-correct end state is `@@unique([tenantId, connectionId, externalUserId])`
with the column `NOT NULL`. This change deliberately stops short of it:

- **Rolling deploy.** Old containers upsert through
  `tenantId_provider_externalUserId`. Dropping that unique in the release that
  introduces the column fails their writes outright.
- **`createSnapshotWriter.readState`** finds an account by
  `(tenantId, provider, externalUserId)`. That is unambiguous *only* while the
  old unique stands. Widening the unique makes the DRY_RUN reader ambiguous —
  and DRY_RUN is the only mode anyone runs, so it is not a dormant branch.
- **Four `create` calls** in two DB-backed RLS suites build accounts with no
  connection at all, and production rows for a two-connection tenant cannot be
  backfilled by definition.

Phase 2 is filed as its own task: swap the unique, take the column `NOT NULL`
once a production count of nulls is zero, scope the snapshot reader, and narrow
the `AMBIGUOUS_CONNECTION` refusal that phase 1 only reworded.

### A checkbox that ticked and meant nothing

The admin integrations form holds config values as `Record<string, string>`; its
checkbox writes `'true'` / `'false'` and reads `value === 'true'`, so it is
internally consistent and looks correct. The Entra writer compares
`config.writesEnabled !== true` — strictly, and deliberately, on the argument
that a value which merely looks affirmative is not a considered grant of
standing power to disable accounts.

Between those two facts: a checkbox that ticked, saved, reloaded ticked, and left
offboarding writes off, with no error anywhere. The codebase had already
diagnosed it — `describeWritesEnabled` exists solely to explain the mismatch and
tells the operator to "re-save the connection". Re-saving reproduced the string,
so the advice was impossible to follow through the product. Making that sentence
true is the whole fix.

The conversion is keyed off the provider's **declared** field type, not the
value's shape, and converts only the two spellings the checkbox itself emits.
`'yes'`, `'1'`, `'TRUE'` pass through untouched: they can only have arrived from
outside the form, and promoting one would defeat the strict comparison exactly
where it is doing its job.

`writesEnabled` was the only victim — the five sibling boolean config fields are
all read through string-coercing helpers, which is why nobody noticed.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/personnel.prisma` | `connectionId String?` + `connection` relation + `@@index([tenantId, connectionId])`; the unique is left alone, with the reason in a comment |
| `prisma/schema/automation.prisma` | `identityAccounts` back-relation on `IntegrationConnection` |
| `prisma/migrations/20260821020000_connected_identity_account_connection_id/` | additive column, FK `ON DELETE SET NULL`, index, and a backfill that runs only where `(tenantId, provider)` resolves to one connection |
| `src/app-layer/usecases/identity-sync.ts` | upsert claims the connection on create AND update; reconcile scoped, with the conditional null arm; the dead `seen` accumulator removed |
| `src/app-layer/integrations/identity-writer-factory.ts` | the `AMBIGUOUS_CONNECTION` docblock and its operator-visible refusal text no longer claim the model carries no connection id |
| `src/lib/integrations/config-form-values.ts` | `coerceDeclaredBooleans` — new, pure, and the reason the checkbox now means something |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/page.tsx` | calls it on submit; the `String(v)` edit-hydration is documented as safe only because of that pairing |

## Decisions

- **Claim the connection on `update`, not only on `create`.** A legacy or
  orphaned row is adopted by whichever connection can still see the account —
  the only evidence available about where it lives. Setting it on create alone
  would freeze attribution at whatever ran first and leave legacy rows
  unattributed forever.
- **`onDelete: SetNull`, not `Cascade`.** Deleting a connection must not delete
  the history of who had accounts in it. Same reasoning as the write journal
  outliving its link.
- **The residual `P2002`.** With the old unique retained, two connections to the
  *same* directory (a misconfiguration) collide on upsert and the second sync
  errors. That is a visible failure rather than silent corruption, and it is
  resolved by phase 2 rather than papered over here.
- **The dead `seen` accumulator was removed, not left.** It fed
  `externalUserId: { notIn: seen }`, which the resume work replaced with the
  `syncedAt < passStartedAt` predicate; it outlived its only reader and was
  rebuilt every pass. Its *absence* is what the reconcile's correctness now
  rests on, so a comment stands where the array was.
- **The coercion was extracted from the page rather than inlined.** A pure
  function can be asserted against; the same six lines inside a 900-line client
  component could only have been covered by mounting the page.
- **No type enforcement was added to `validateProviderConfig`.** Rejecting
  string-typed booleans there would 400 every existing connection on its next
  save — including the save that would have repaired it.
