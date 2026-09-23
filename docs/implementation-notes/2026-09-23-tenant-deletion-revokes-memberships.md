# 2026-09-23 — tenant deletion revokes its memberships, and the doc's purge claim is pinned

Closes two acceptance gaps on #2747. Neither is a new feature: both are places
where a promise already written down was not backed by anything that runs.

## Design

### Gap 1 — the grant outlived the thing it granted access to

`deleteTenantUnderOrg` set `Tenant.deletedAt` and stopped. Its own docstring
said the tenant becomes "inaccessible immediately, everywhere" — which was a
claim about every CURRENT reader remembering the `deletedAt IS NULL` filter,
not about the grants. The `TenantMembership` rows saying "this user may enter
this tenant" survived the full 90-day purge window; the issue measured 113 of
them live.

The fix revokes them at deletion time, so access stops depending on everyone
else's `WHERE` clause:

```
prisma.$transaction([
  tenant.update            { deletedAt: revokedAt }          ← must run FIRST
  tenantMembership.updateMany
      where { tenantId, status: { in: ['ACTIVE','INVITED'] } }
      data  { status: 'DEACTIVATED', deactivatedAt: revokedAt }
])
```

Three things about that shape carry weight.

**The order is a correctness constraint, not a style choice.**
`tenant_membership_last_owner_guard` raises `P0001` on any UPDATE that
deactivates a tenant's last ACTIVE OWNER, and every tenant has one. Migration
`20260922200000_last_owner_guard_allows_purge` (already on main, from the purge
half of #2747) exempts a tenant carrying `deletedAt IS NOT NULL`. So the
soft-delete must have already executed when the membership UPDATE fires.
`$transaction([...])` runs its entries sequentially, which is what makes the
array form sufficient. Reverse the two and every deletion aborts against a real
database — while a unit test with a mocked client stays green, because a mock
has no triggers.

**The predicate is `ACTIVE | INVITED`, not "everything" and not "not
DEACTIVATED".** `deactivatedAt` is evidence of WHEN access ended, so a row that
already carries one must keep it rather than have it overwritten with today's
date. `REMOVED` is excluded for the same reason — it is a terminal state
`resolveTenantContext` already refuses, and rewriting it to `DEACTIVATED` would
lose which of the two happened. What is left is exactly the set
`src/lib/tenant-context.ts` lets through, i.e. the live grants.

**Revoked, not erased.** A `deleteMany` would have answered "who had access to
this tenant, and until when?" with silence, and that is a question asked about
a tenant precisely because it has been removed.

### Gap 2 — a doc claim nothing compared against the code

42 model rows in `docs/data-retention.md` promise a variant of *"Lives with
tenant; purged on tenant deletion"*. `retention-policy-coverage` checks each
model is LISTED, which verifies the row exists and never that it is true;
`tenant-purge-retains-regulatory` checks the retained set against the doc's
REGULATORY classification, so a Configuration row promising a purge it never
gets is invisible to it.

The new guard is the cross-walk: a model whose row promises the purge must not
be in `TENANT_PURGE_RETAINED`, and — exercising the real `deletionOrder()` under
the real retained-set filter — must be a table the purge actually deletes.

It found one on its first run. `Tenant`'s row promised "purged on tenant
deletion" while `TENANT_PURGE_RETAINED` names `Tenant` explicitly as the
tombstone that CANNOT go, because `AuditLog` carries a NOT-NULL non-cascading
FK to it. The doc promised the deletion of the one row the design guarantees
survives. That row is corrected here.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/org-tenants.ts` | `deleteTenantUnderOrg` revokes memberships in the soft-delete's transaction; the revoked count joins the existing log line |
| `docs/data-retention.md` | the `Tenant` row now says RETAINED as a tombstone instead of promising a purge |
| `tests/guardrails/tenant-purge-doc-claim-is-backed.test.ts` | the new cross-walk guard |
| `tests/unit/usecases/org-tenant-delete.test.ts` | revocation shape, predicate, shared timestamp, revoke-not-erase, and statement ORDER |

## Decisions

- **No restore counterpart was changed, because there is none.**
  `restoreEntity` in `soft-delete-operations.ts` covers twelve models and
  `Tenant` is not among them; nothing in `src/` or `scripts/` clears
  `Tenant.deletedAt`. A tenant is un-deleted today by a hand-written UPDATE, so
  there is no code path that would now leave a restored tenant with dead
  memberships. Whoever writes that UPDATE owns reactivation, and if a real
  restore path is ever built it owns that half explicitly. Inventing one here
  would have been a second membership write seam with no caller.

- **`TenantApiKey` is deliberately untouched.** `verifyApiKey` already refuses a
  key whose tenant carries `deletedAt`, and that check is documented as the
  reason it exists. Widening this diff to revoke keys as well would duplicate a
  control that works.

- **The guard reads the doc RAW, which inverts the usual masking advice.**
  `mdCodeOf` keeps code spans and blanks prose — and here the prose IS the
  subject, so masking would delete the claim and leave an empty population
  passing forever. `retention-policy-coverage` makes the same call at its own
  read seam. Reading raw is safe from the Class A / Class D ratchets because no
  assertion takes a whole-file read as its subject; that was verified by
  temporarily adding one and watching `raw-source-assertion-ratchet` name this
  file, then removing it.

- **The 17 claimants the purge cannot reach are PINNED, not filtered away.**
  `Framework`, `ControlTemplate`, `Organization`, `OrgMembership` and thirteen
  others carry no `tenantId`, so `DELETE FROM "X" WHERE "tenantId" = $1` can
  never name them and their row's promise is false too. Correcting each is a
  classification call for a compliance owner — "what DOES happen to the shared
  framework catalogue when one tenant leaves" has a real answer and it is not
  "it is purged" — so the list is asserted by exact equality instead. It may
  shrink as rows are corrected; a new name in it means somebody has just written
  the default sentence onto another unreachable model. A reachability filter
  nobody can see the shape of is a gate narrow enough to always pass.
