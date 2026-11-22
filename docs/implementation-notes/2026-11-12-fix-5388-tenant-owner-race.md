# 2026-11-12 — the tenant last-OWNER guard serialises per tenant (#5388)

**Commit:** see the PR for #5388.

## Design

The tenant last-OWNER guard (Epic 1) has two layers: the usecase counts in
`tenant-admin.ts` and the `tenant_membership_last_owner_guard` trigger
(`check_not_last_owner`). Both counted ACTIVE OWNER rows under READ COMMITTED
with no lock. Two OWNERs A and B demoting, deactivating or removing each other
at once each counted the other as still an ACTIVE OWNER, each wrote a
different row, both committed, and the tenant had no ACTIVE OWNER. The
integration test reproduces it against the old function and the old usecases:
both calls succeed and the tenant is left with zero owners.

This is the tenant twin of the org fix (#5373). Both layers now take one
transaction-scoped advisory lock per tenant before they count:

```
pg_advisory_xact_lock(hashtext('tenant-owner:' || tenantId))
```

- **Trigger** (migration `20261112160000_tenant_owner_guard_serialised`,
  function replace only). It takes the lock after the early returns AND after
  the soft-deleted-tenant exemption (#2747), so only a change that removes an
  ACTIVE OWNER from a live tenant queues on it; the tenant purge never does.
  The count then runs as a new statement, and in a VOLATILE PL/pgSQL function
  under READ COMMITTED each statement takes a fresh snapshot, so it sees what
  the previous lock holder committed.
- **Member usecases.** `updateTenantMemberRole`,
  `updateTenantMemberRoleAndCustomRole`, `deactivateTenantMember` and
  `removeTenantMember` already run their whole check-and-write in one
  `runInTenantContext` transaction. They now take the lock as its first
  statement, before reading the membership, so the membership read, the
  last-OWNER count and the last-admin count are all made after any concurrent
  owner change has committed. The race loser gets the usecase's existing 403
  (`Cannot demote/deactivate/remove the last OWNER`), not the trigger's raw
  P0001.
- **Ownership transfer.** `transferTenantOwnership` takes the lock first in
  its transaction, then writes both rows with conditional `updateMany`s
  (promote only an ACTIVE membership; demote only an ACTIVE OWNER) and refuses
  with the same errors as its pre-transaction checks when either no longer
  holds. Promote-then-demote is unchanged, so the trigger is satisfied.
- **Access-review close.** `closeAccessReview` takes the lock first in its
  phase-1 transaction, before its live-OWNER count and the planned
  REVOKE/MODIFY executions.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261112160000_tenant_owner_guard_serialised/migration.sql` | `CREATE OR REPLACE` of `check_not_last_owner`: takes the lock before the count; otherwise the 20260922200000 body. |
| `src/app-layer/usecases/tenant-owner-lock.ts` | `lockTenantOwners` / `tenantOwnerLockKey` — the one spelling of the key outside the migration. |
| `src/app-layer/usecases/tenant-admin.ts` | The four member-change usecases lock first in their transaction. |
| `src/app-layer/usecases/tenant-lifecycle.ts` | The transfer locks first and re-checks both rows in its writes. |
| `src/app-layer/usecases/access-review.ts` | The member close locks first. |
| `tests/integration/tenant-owner-race.test.ts` | Raw-SQL cross-demotion and deactivate-vs-delete with one transaction held open; usecase cross-demotion, deactivate-vs-demote and remove-vs-demote behind a held lock; the transfer under the lock and racing a deactivation of its incoming owner. |
| `tests/unit/*`, `tests/integration/tenant-admin.test.ts` | Mocked transaction clients gain `$executeRawUnsafe`; the transfer's tests follow its `updateMany` writes and assert the lock comes first. |
| `CLAUDE.md` | "Last-OWNER protection — two layers" states the serialisation. |

## Decisions

- **A new namespace, `tenant-owner:`.** The tenant audit chain already locks
  the bare `hashtext(tenantId)`. Sharing it would make every member change
  contend with every audit append in the tenant. `logEvent` appends in its own
  transaction anyway, so nothing would gain from sharing.
- **The usecases lock unconditionally, before the membership read.** Locking
  only when the target is an OWNER would need the role read first, outside the
  lock, where it can already be stale. Member changes are rare and per-tenant,
  so queueing every one costs nothing measurable, and the same lock closes the
  identical race on the last-ADMIN count (two ADMINs demoting each other),
  which the trigger does not cover.
- **Lock order is advisory lock, then row.** The trigger takes the advisory
  lock while the row it is updating is already locked, so any caller that
  took a row lock on ANOTHER membership first and then asked for the
  advisory lock could deadlock with a caller in the opposite order. Every
  usecase path that changes owners therefore takes the advisory lock before
  any row. This is why the transfer (which locks the incoming owner's row on
  the promote) and the access-review close (which updates several rows) take
  it too, not only for their error messages.
- **SCIM and the Entra group sync are not changed.** Neither ever mutates an
  OWNER membership (SCIM refuses ADMIN and OWNER targets; group sync treats
  OWNER as immune), so the trigger's lock never fires for their writes, and
  they hold no owner count that could race.
- **Deadlock exposure that remains is narrow and detected.** A writer that
  does not go through these usecases and touches two memberships in one
  transaction — e.g. a raw update — takes a row lock first and the advisory
  lock in the trigger. It meets a usecase only when both touch the same rows
  at the same instant, and Postgres then aborts one with 40P01: an error,
  never a silent orphan.
- **The access-review close's P0001 catch is unchanged.** It maps a trigger
  refusal to `SKIPPED_LAST_OWNER`. With the close holding the lock from the
  start, no other write that removes an ACTIVE OWNER can commit until the
  close does (each such write waits in the trigger), so the close's own
  projected-count check is now exact and the catch is a backstop that should
  not be reached.
