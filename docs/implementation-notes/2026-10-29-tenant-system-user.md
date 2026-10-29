# 2026-10-29 — A per-tenant SYSTEM user for job writes (#4400)

## Design

`Task.createdByUserId` is a NOT NULL foreign key to `User`, so a job that raises a task cannot write it as `SYSTEM_PRINCIPAL`. Nine jobs borrowed a real member's id instead (#4388). That named the member as the author of something they did not do, under an ADMIN-shaped context. This change adds the row the issue asked for and moves the first caller onto it.

- **Identity.** The id is `sys_<tenantId>`, the email hash is `system:<tenantId>`, the email is `system+<tenantId>@inflect.invalid`, the name is "Inflect automation", `emailVerified` is set and there is no password. The id is the marker: a cuid never contains `_`, so the prefix cannot collide with a person.
- **Created on first use.** `ensureTenantSystemUser(tenantId)` creates the row with `INSERT … ON CONFLICT DO NOTHING`, from `buildTenantSystemJobContext`, the first time a job needs it.
  - Lazy creation covers every tenant-creation path, including future ones, with no backfill and no change to the roughly 320 test files that create tenants directly.
  - It is raw SQL because the PII middleware would otherwise derive `emailHash` as an HMAC of the email, the one value this row's hash must never be.
- **Never a person, enforced by the database.** Migration `20261029200000_tenant_system_user`:
  - checks the row's shape: a `sys_` id and a `system:` hash come together, the hash names the same tenant, and the row has no password;
  - refuses `sys_` in the ten tables that hold a sign-in, membership, credential or session: `Account`, `UserIdentityLink`, `TenantMembership`, `OrgMembership`, `PasswordResetToken`, `UserMfaEnrollment`, `UserSession`, `Session`, `TenantApiKey.createdById` and `TenantDeviceToken.createdById`.

  Every route to a session or a context needs a password or a row in one of those tables. So those CHECKs close every route at once, including routes written later.
- **Second line in the app.** The jwt callback throws on a system id before writing any claim, and `sendEmail` drops a list made entirely of `.invalid` addresses.
- **First caller.** `policyReviewReminder` writes its task with `buildTenantSystemJobContext`. The owner is still the assignee, resolved against an ACTIVE membership by `createTask`.

## Files

| File | Role |
| --- | --- |
| `prisma/migrations/20261029200000_tenant_system_user/migration.sql` | The preflight, the row-shape CHECK and the ten not-system-user CHECKs |
| `src/lib/tenant-system-user.ts` | Pure id, hash, email and name helpers, with no imports, for `auth.ts` |
| `src/app-layer/context-system.ts` | `ensureTenantSystemUser` and `buildTenantSystemJobContext`; `buildDelegatedJobContext`'s docblock points at them |
| `src/app-layer/jobs/policyReviewReminder.ts` | The first caller |
| `src/auth.ts` | The jwt refusal |
| `src/lib/mailer.ts` | `isUndeliverableRecipient` and the send refusal |
| `tests/integration/tenant-system-user.test.ts` | The shape, the reachability and the CHECKs against a real database, plus the reminder for two tenants |

## Decisions

- **No new column and no foreign key to `Tenant`.**
  - The research for this change proposed a `systemForTenantId` column with a cascading foreign key. The id prefix already identifies the row to SQL, so the column would add nothing.
  - A foreign key to `Tenant` would cascade: a test that hard-deletes a tenant after a job wrote a task would fail on the task's restricting foreign key to `User`.
  - Without one, a hard-deleted tenant leaves an inert row. Production never hard-deletes a tenant; the purge keeps the tombstone.
  - No schema change means no regenerated Prisma client.
- **Lazy creation, not a trigger on `Tenant`.**
  - A trigger and backfill would have given every tenant a system row, including those whose jobs never need one.
  - It would also have put an extra `User` row into every test that creates a tenant.
- **The `system:` hash, not an HMAC of the sentinel email.**
  - An HMAC of the sentinel can be computed by any lookup by email. Whoever registered the sentinel first would hold the slot, and Google or Entra sign-in linking (which matches by email hash) could reach the row.
  - A value that is not an HMAC removes every route by email at once.
- **Unchanged here.**
  - The other borrowing callers: `retention-notifications`, `agent-owner-orphan-pass`, the control-test runner, the evidence emitters and the identity passes.
  - Five places treat "a machine did this" as `userId === SYSTEM_PRINCIPAL`. They must learn `isTenantSystemUserId` before `agent-owner-orphan-pass` and the identity passes move.
  - The reminder's own path touches none of them.
- **Automation.** The reminder's `TASK_CREATED` event now carries the system user as its actor.
  - A rule with a recorded creator acts as that creator, as before.
  - A legacy rule with no creator now falls back to an actor with no membership, and is refused ("not a member"). Before, it acted as the policy owner. This narrows authority, which is the point.
