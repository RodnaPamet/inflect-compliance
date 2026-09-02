# 2026-09-02 — the MFA anti-lockout safeguard did not count OWNERs

**Commit:** `<pending>` fix(mfa): count OWNERs in the anti-lockout safeguard

## Design

`updateTenantMfaPolicy` refuses to switch a tenant to `mfaPolicy: REQUIRED`
unless somebody who could switch it *back* already has verified MFA. The
population it queried was:

```ts
where: { tenantId: ctx.tenantId, role: 'ADMIN' }
```

The gate that lets a caller reach that code is `ctx.permissions.canAdmin`,
which `src/lib/tenant-context.ts` defines as `ROLE_ORDER[role] >= 4` over
`{ OWNER: 5, ADMIN: 4, EDITOR: 3, AUDITOR: 2, READER: 1 }`. So **OWNER passes
the gate and is invisible to the query.**

For a tenant with one OWNER and no ADMINs the list came back empty, the
`adminUserIds.length > 0` guard short-circuited, the enrolment count never
ran, and `REQUIRED` was written with nobody enrolled — the exact outcome the
safeguard exists to prevent.

That is not a rare shape. `createTenantWithOwner` writes an OWNER row and no
ADMIN, so it is the shape every tenant starts in, and ADMINs are optional
forever after.

The query is now `role: { in: ['OWNER', 'ADMIN'] }, status: 'ACTIVE'`.

## Files

| file | role |
| --- | --- |
| `src/app-layer/usecases/mfa.ts` | the query, the error message, and the two docstrings that said "ADMIN-only" |
| `tests/unit/usecases/mfa-policy.test.ts` | replaced the test that pinned the no-op as correct; added the OWNER, DEACTIVATED and query-shape cases; added the first coverage of `getTenantSecuritySettings` and `getUserMfaStatus` |

## Decisions

- **`status: 'ACTIVE'` as well as the role.** A `DEACTIVATED` or `REMOVED`
  member cannot sign in, so their enrolment does not make the policy
  recoverable through them; `INVITED` never had a session at all. The DB
  trigger in `20260424220000_epic1_last_owner_trigger` uses the same pair
  (`role = 'OWNER' AND status = 'ACTIVE'`) as its definition of a live owner,
  so this matches the existing notion rather than inventing one.

- **Custom roles are deliberately out of scope.** A `TenantCustomRole` whose
  base `role` is below ADMIN but whose `permissionsJson` grants admin rights
  would also be able to switch the policy back, and is not counted. Reaching
  it needs a join and a `permissionsJson` interpretation; the built-in roles
  are the population this query can honestly express, and the code says so
  rather than leaving the omission to be re-discovered.

- **The `length > 0` guard stays.** With an active OWNER guaranteed by the
  trigger it should now be unreachable, so reaching it means that invariant
  broke. Skipping the count there is the same answer the old code gave, and
  keeping the branch states the behaviour instead of leaving it to Prisma's
  `{ in: [] }` semantics.

- **Two false claims in the old test file were the reason this survived.**
  The docstring said flipping to REQUIRED "would lock every admin out
  forever". It would not: `isMfaAllowedPath` admits
  `/api/t/:slug/security/mfa/enroll` while `mfaPending`, so the real
  consequence is that everyone is forced through enrolment on next sign-in.
  Overstating the consequence is what made the second claim — "tenant with
  zero ADMINs (no lockout possible) … no one to lock out" — read as a
  harmless edge case. There is always someone to lock out, and the trigger
  proves it.

- **A filter-blind mock cannot test a filter.** The first version of the new
  OWNER test used `mockResolvedValue([{ userId: 'owner-1' }])`, which returns
  the row whatever the query asks for. Measured: with the fix reverted, that
  test stayed GREEN and only the `where`-shape assertions failed. The mock now
  honours `role.in` and `status`, and two separate mutations — dropping the
  role widening, and dropping only the status filter — each fail the tests
  that should be sensitive to them and leave the others alone.

## Consequence for operators

A tenant that could previously enable REQUIRED MFA with nobody enrolled now
gets a 400 telling it to enrol first. That is the safeguard doing what it
already did for ADMIN-holding tenants; no tenant loses a capability it should
have had. Tenants already sitting on REQUIRED are unaffected — this path runs
only on the switch INTO REQUIRED.
