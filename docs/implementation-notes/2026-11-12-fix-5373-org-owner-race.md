# 2026-11-12 — the org last-owner guard serialises per organization (#5373)

**Commit:** see the PR for #5373.

## Design

The org last-owner guard (#4576) had two layers, the usecase count in
`org-members.ts` and the `org_membership_last_owner_guard` trigger. Both
counted ORG_OWNER rows under READ COMMITTED with no lock. Two owners A and B
demoting each other at once each counted the other as still an owner, each
wrote a different row, both committed, and the organization had no owner. The
integration test reproduces it deterministically against the old function.
Transaction 2's update of A never waits for transaction 1's uncommitted
update of B.

Both layers now take one transaction-scoped advisory lock per organization
before they count:

```
pg_advisory_xact_lock(hashtext('org-owner:' || organizationId))
```

- **Trigger** (migration `20261112130500_org_owner_guard_serialised`,
  function replace only). It takes the lock after the early returns, so only a
  change that removes an owner queues on it. The count then runs as a new
  statement. In a VOLATILE PL/pgSQL function under READ COMMITTED each
  statement takes a fresh snapshot, so the count sees whatever the previous
  lock holder committed. The test confirms this rather than assumes it.
- **Usecase**. `changeOrgMemberRole` and `removeOrgMember` take the same key
  first in their transaction, whenever the target is an owner or admin, before
  the in-transaction re-checks of the last-owner and last-admin counts. The
  loser of a race now gets the usecase's 409 `LAST_ORG_OWNER`, not the
  trigger's raw P0001. The trigger re-acquires the lock for free, because
  advisory locks stack within a transaction.
- **Removal atomicity**. `removeOrgMember` ran `deprovisionOrgAdmin` in its
  own transaction and then the membership delete. The delete was the step the
  trigger could refuse, so a refused removal left the member with the org role
  and no tenant ADMIN rows. The fan-in and the delete now share one
  transaction, the shape `changeOrgMemberRole` already had.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261112130500_org_owner_guard_serialised/migration.sql` | `CREATE OR REPLACE` of `check_not_last_org_owner`: takes the lock before the count; otherwise unchanged. |
| `src/app-layer/usecases/org-members.ts` | `lockOrgAdministrators` plus `assertNotLastAdministrator`. The role change locks before its re-checks. The removal runs lock, re-check, fan-in and delete in one transaction. |
| `tests/integration/org-owner-race.test.ts` | Raw-SQL cross-demotion with explicit ordering, the concurrent usecase cross-demotion behind a held lock, removal racing a demotion, and rollback of a failed removal. |
| `tests/unit/org-members-usecase.test.ts`, `tests/unit/audit-trail-org-emission.test.ts` | Mocked transaction clients gain `$executeRawUnsafe`. The removal is now transactional, and the lock is asserted to come before the in-transaction count. |
| `CLAUDE.md` | The org-role bullet states the serialisation. |

## Decisions

- **A new namespace, `org-owner:`.** The org audit chain already locks
  `hashtext('org:' || organizationId)`. Sharing that key would make every role
  change contend with every org audit append, and the usecase appends audit
  rows after commit, so nothing would gain from sharing it.
- **The usecase lock also covers the last-ADMIN count.** It is the same race
  (two admins demoting each other to reader), and the trigger does not cover
  it. One key for both checks means the role change and the removal queue
  together, whichever check they run.
- **Lock only when the target administers the org.** A reader's removal or
  promotion runs no count, so it does not need to queue.
- **The pre-transaction checks stay.** They refuse the common case without
  opening a transaction. The re-check under the lock decides.
- **Deadlock exposure is narrow and detected.** A writer that does not go
  through the usecase (the invite upsert's re-redemption, a raw update) takes
  the row lock first and the advisory lock in the trigger. The usecase takes
  them in the other order. They meet only when both change the same owner row
  at the same instant. Postgres then aborts one transaction with 40P01: an
  error, never a silent orphan.
- **The tenant guard is not changed here.** `check_not_last_owner`
  (`tenant_membership_last_owner_guard`) has the same unlocked count, which is
  out of scope for this issue.
