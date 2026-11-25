# 2026-11-25 — The DSAR erasure's operator entry point, and its workspaces from membership history (#5802)

**Commit:** `fix(dsar): …` (branch `fix/fix-5802-erasure-entry-point`)

## Design

Owner decision 2026-11-25 on #5802: an operator-only command, no HTTP route,
that finds the subject's workspaces from membership history in the audit trail
— not only from the subject's own actions — then runs `eraseUser` and the
Managed Agents clean-up over all of them.

```
scripts/dsar-erase-user.ts --user <id> [--confirm]
  ├─ plan (runInGlobalContext, reads only)
  │    planErasure(userId)            → blockers (a membership among them)
  │    readErasureWorkspaces(userId)  → tenants + evidence + what it cannot see
  │    print ids and counts; without --confirm stop here
  └─ --confirm (refused on any blocker or undecided evidence)
       eraseUser(userId, { afterCommit })
         tx: planErasure → readErasureWorkspaces → pseudonymize → record → delete
         after commit: deleteKeptManagedAgentsSessionsAfterErasure(tenantIds)
                         → openDsarErasureCleanups (unchanged)
```

`readErasureWorkspaces` (`src/app-layer/jobs/dsar-erasure-workspaces.ts`) is the
one reader. Inside `eraseUser` it runs after `planErasure` (which proves the
connection is unconstrained) and before the pseudonymization (which nulls the
subject's own rows, half of the evidence). It replaced the after-commit tenant
set that was derived from the subject's own rows only.

It is a pure decision (`erasureWorkspacesFrom`) over two bounded, paged reads:

- `AuditLog`, grouped by tenant/action/entity, for rows whose `userId` is the
  subject (OWN_ACTION) or whose `entity = 'TenantMembership'` and `entityId` is
  the subject (MEMBERSHIP_RECORD, counted only under a listed action);
- `OrgAuditLog`, for org-admin fan-out rows whose `targetUserId` is the subject,
  read for `detailsJson.tenantIds` (ORG_TENANT_FANOUT).

## The membership writers, enumerated from the code

The eight allowlisted `TenantMembership` writers (`tests/guardrails/no-auto-join`):

| Writer | Audit row naming the subject | Covered by |
| --- | --- | --- |
| `tenant-invites.ts` (both redemption paths) | `MEMBER_INVITE_ACCEPTED`, `userId` = subject | OWN_ACTION |
| `tenant-lifecycle.ts` `createTenantWithOwner` | `TENANT_CREATED` / `TENANT_REGION_SET` (`userId` = owner), `TENANT_MEMBERSHIP_GRANTED` (`userId` and `entityId` = owner) | OWN_ACTION, MEMBERSHIP_RECORD |
| `scim-users.ts` | `SCIM_USER_CREATED` / `_REACTIVATED` / `_UPDATED` / `_DEACTIVATED`, `entity = TenantMembership`, `entityId` = subject, `userId` null | MEMBERSHIP_RECORD |
| `org-provisioning.ts` via `org-members.ts` | `ORG_ADMIN_PROVISIONED` / `_DEPROVISIONED`, `entityId` = subject; org trail `ORG_ADMIN_PROVISIONED_TO_TENANTS` / `_DEPROVISIONED_FROM_TENANTS` | MEMBERSHIP_RECORD, ORG_TENANT_FANOUT |
| `org-provisioning.ts` via `org-invites.ts` | org trail `ORG_ADMIN_PROVISIONED_TO_TENANTS` only | ORG_TENANT_FANOUT |
| `org-provisioning.ts` `provisionAllOrgAdminsToTenant` (from `createTenantUnderOrg`) | none | — gap |
| `org-tenants.ts` `createTenantUnderOrg` (creator's OWNER row) | none | — gap |
| `src/app/api/auth/register/route.ts` | none | — gap |
| `sso.ts` `linkExternalIdentity` JIT | none | — gap |
| `src/app/api/staging/seed/route.ts` | none (staging only) | — gap |

The Entra group sync changes a role, not a membership, and writes
`MEMBER_ROLE_CHANGED` with `userId` = the member, so it is OWN_ACTION too.
The gaps are `MEMBERSHIP_WRITERS_WITHOUT_A_SUBJECT_ROW`, printed with every
plan. Removal (`MEMBER_REMOVED`, `MEMBER_DEACTIVATED`, `MEMBER_ROLE_CHANGED` by an
admin) is audited by MEMBERSHIP id, which cannot be tied to the person once the
row is gone.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/jobs/dsar-erasure-workspaces.ts` | The rule: action table, writer gaps, pure decision, bounded paged read |
| `src/app-layer/jobs/dsar-erasure.ts` | `eraseUser` reads the workspaces in its transaction; `deleteKeptManagedAgentsSessionsAfterErasure` returns what the clean-up opened |
| `scripts/dsar-erase-user.ts` | The operator command; `npm run dsar:erase-user` |
| `tests/unit/dsar-erasure-workspaces.test.ts` | Each writer's audit shape; the bound |
| `tests/unit/dsar-erase-user-command.test.ts` | The command's refusals and output |
| `tests/unit/dsar-erasure-execute.test.ts` | The fake answers the new reads; the hook gets a SCIM-only workspace |
| `tests/integration/dsar-erase-user-command.test.ts` | Real SCIM writer, real erasure, faux Anthropic workspace |
| `docs/runbooks/dsar-erasure.md` | The operator procedure (never published) |
| `docs/dsar.md`, `CLAUDE.md`, `docs/claude-managed-agents-design.md` | The known limit replaced by the rule as built |

## Decisions

- **An action is listed, never inferred.** The clean-up deletes every kept
  session in a workspace, not the person's alone, so a workspace added on an
  unclassified row costs other people's sessions. An unlisted `TenantMembership`
  row naming the subject is reported `UNLISTED_MEMBERSHIP_ACTION`, and the
  command refuses `--confirm` until it is classified: after the erasure the
  subject's own rows are pseudonymized and the chance is gone.
- **Refused, never truncated.** Each read is paged (500 groups a page, 200
  pages) and reads one row past the bound before refusing, so a set of exactly
  the bound is read whole and a larger one is an error, not a partial set.
- **The command follows `eraseUser`'s membership rule** rather than adding an
  "ACTIVE membership" check: `planErasure` already blocks on a membership in any
  status, so the command refuses whatever the plan blocks.
- **The `sys_` refusal lives in the command**, before any read. `eraseUser` has
  no such rule; a system user is never a subject.
- **The id is validated, and nothing refused is echoed.** A positional e-mail
  or an unknown flag carrying one is refused without being printed.
- **No new audit action.** The record is `eraseUser`'s `ERASURE_EXECUTED` and
  the clean-up's records; nothing names the person.
- **Not checked by the command:** the cooling-off window and the rejection
  criteria, which need the DSAR request, not a user id. The plan says so every
  time, and the runbook puts both on the operator.
