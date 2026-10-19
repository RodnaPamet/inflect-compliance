# 2026-10-18 — An OWNER membership never carries a custom role (#3720), and a campaign does no OWNER-tier work (#3727)

**Commit:** `(this commit) fix(security): an OWNER never carries a custom role, and a campaign does no OWNER-tier work`

## Design

A custom role REPLACES a membership's permissions at resolution
(`resolveTenantContext` reads `customRole.baseRole ?? role` and parses the
custom role's `permissionsJson`). `assignCustomRole` checked the CALLER
(`assertCanManageMembers`, which an ADMIN passes) and the GRANT
(`assertGrantWithinOwnAuthority`), never the TARGET. So an ADMIN could put a
READER-based custom role on every OWNER and demote them in effect. The enum
role still read `OWNER`, so the last-OWNER usecase checks and
`tenant_membership_last_owner_guard` never fired. The demoted OWNERs could not
undo it from inside the product, because undoing it needs `admin.members`.

#3699 deploy 2 had already made the rule for AI_ADMIN: `BUILT_IN_SCOPE_ROLES`
and `mayCarryCustomRole` in `src/lib/roles.ts`, and the named reason
`BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE`. The owner's decisions for this
issue (2026-10-18) extend it to OWNER and add a database backstop:

```
                      assign custom role      promote a carrier       clear a (legacy) one
OWNER membership      refused, every caller   refused until removed   OWNER only (owner_management)
AI_ADMIN membership   refused, every caller   refused until removed   anyone with admin.members (as #3722)
any other role        unchanged               n/a                     unchanged
```

Every writer that can set `role` or `customRoleId` reads `mayCarryCustomRole`:

| Writer | How it holds the rule |
|---|---|
| `assignCustomRole` | refuses the assignment (409); refuses an ADMIN's clear on an OWNER (403) |
| `updateTenantMemberRole` (members page) | refuses promoting a carrier (409); already OWNER-gated for an ADMIN |
| `PATCH /admin/members/:id` | body refuses `role: OWNER` beside a custom role (400); role-first order means promote-and-clear in one body commits nothing |
| `transferTenantOwnership` | refuses a new owner who carries one, before the transaction (409) |
| `createInviteToken` | refuses an OWNER invite for an inactive membership that carries one (409) |
| `finalizeInviteRedemption` | backstop inside the transaction (409, invite stays burnt) |
| `redeemPendingInvitesByEmail` | skips such an invite BEFORE the claim, with one hoisted read |
| access review MODIFY | never sets OWNER and never sets a custom role (#3727, below), so it cannot reach the combination |
| Entra group sync | OWNER is never a mapped role, and an OWNER membership is never touched (`owner_immune`) |
| SCIM, SSO JIT | never write OWNER, and never write `customRoleId` |

The database CHECK `TenantMembership_built_in_scope_role_no_custom_role`
(`NOT (role IN ('OWNER','AI_ADMIN') AND "customRoleId" IS NOT NULL)`) is the
backstop for anything that does not go through a usecase.

## Files

| File | Role |
|---|---|
| `src/lib/roles.ts` | `BUILT_IN_SCOPE_ROLES` gains OWNER; `clearingCustomRoleIsOwnerTier`, `OWNER_TIER_CLEAR_REFUSAL`; an `'invite'` wording |
| `src/lib/errors/types.ts` | `ForbiddenError` / `forbidden()` take optional `details`, so a usecase 403 can name its reason |
| `src/app-layer/usecases/custom-roles.ts` | the assignment refusal now covers OWNER; the OWNER-tier clear |
| `src/app-layer/usecases/tenant-admin.ts` | docs only: the existing check now covers OWNER |
| `src/app-layer/usecases/tenant-lifecycle.ts` | the ownership-transfer refusal |
| `src/app-layer/usecases/tenant-invites.ts` | invite creation, token redemption and sign-in redemption |
| `src/lib/access-review/member-decision-rules.ts` | #3727's three named reasons and their messages |
| `src/app-layer/schemas/access-review.schemas.ts` | MODIFY refuses OWNER and any custom role by name (`params.reason`) |
| `src/app-layer/usecases/access-review.ts` | the close's four refusals; refusal audit rows; MODIFY writes the built-in role and clears a custom role |
| `src/app-layer/repositories/AccessReviewRepository.ts` | the close reads the live `customRoleId` |
| `src/app/api/t/[tenantSlug]/access-reviews/[reviewId]/decisions/[decisionId]/route.ts` | a schema refusal at the route is audited too |
| `src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx` | the MODIFY picker offers `CAMPAIGN_MODIFY_ROLES` (no OWNER) |
| `tests/integration/access-review-{closeout,e2e}.test.ts` | their OWNER-lowering closes now run as an OWNER |
| `src/app/api/t/[tenantSlug]/admin/members/[membershipId]/route.ts` | `customRoleId` must be non-empty; comment on why neither half slips through |
| `src/app/t/[tenantSlug]/(app)/admin/members/page.tsx`, `messages/{en,bg}.json` | OWNER rows are locked for a non-OWNER; an OWNER can remove a legacy custom role |
| `prisma/migrations/20261018180000_built_in_scope_role_no_custom_role/` | the CHECK, NOT VALID, then a conditional VALIDATE |
| `prisma/schema/auth.prisma` | a doc comment on `customRoleId` naming the CHECK |
| `tests/integration/mcp-*.test.ts` (two files) | their "custom-role-narrowed principal" fixture was an OWNER; it is an ADMIN now |

## Decisions

- **NOT VALID, then VALIDATE only on a clean table.** Nobody here can read
  production, and a row breaking the rule may exist there (exploited, or set up
  on purpose). A plain `ADD CONSTRAINT ... CHECK` would fail `migrate deploy` on
  such a row, and the entrypoint re-runs it on every start, which is the #2745
  outage shape. `NOT VALID` enforces every INSERT and UPDATE from the moment it
  is added. The `DO` block validates when the count is 0, and otherwise raises a
  WARNING with the count and leaves the constraint NOT VALID. The repo's
  migrations already use `DO` blocks (the GAP-21 pre-flight), and no guardrail
  restricts them. `migration-enum-isolation` concerns `ADD VALUE` only, and the
  `AI_ADMIN` literal is safe because `20261018110000_role_ai_admin` committed
  the value in its own migration.
- **The consequence is deliberate.** NOT VALID still checks updates, so an
  offending legacy row refuses EVERY update until its custom role is cleared:
  its status, a deactivation, an access-review REVOKE, and the org tenant
  removal's bulk deactivate. A clear (`customRoleId` → NULL) satisfies the CHECK
  and passes the last-OWNER trigger, because role and status are unchanged. A
  demotion to a role that may carry a custom role satisfies it too. DELETE is
  never checked. No usecase pre-checks for this: once the post-deploy query
  comes back empty it cannot happen. Until then, a refusal is a loud 500, not a
  silent write.
- **Refused, never repaired.** No path clears a custom role on the caller's
  behalf, as for AI_ADMIN, except the one whose purpose is removing access: an
  executed campaign MODIFY. It sets the built-in role and clears the custom role,
  as it always did for a MODIFY naming none, because a custom role replaces the
  role at resolution and leaving it would make the MODIFY change nothing. Its
  execution row now records `clearedCustomRoleId`.
- **The clear is OWNER-tier for OWNER only.** It restores full OWNER authority.
  AI_ADMIN keeps what #3722 shipped, an `admin.members` clear. That path is moot
  anyway: no AI_ADMIN row can carry a custom role (deploy 1 had no writer, deploy
  2's writers refuse, and the CHECK refuses).
- **An ADMIN's clear on an OWNER is refused even when there is nothing to
  clear.** The rule is "an ADMIN does not modify an OWNER membership", the same
  as the role change. A no-op that reports success would hide that.
- **The 403 names its reason.** `ForbiddenError` gained optional `details`,
  matching `ConflictError` and `ValidationError`. A usecase refusal writes no
  `AUTHZ_DENIED` row, the same as every other usecase-level OWNER-tier refusal
  (`Only OWNERs can modify an OWNER membership.`). `requirePermission` writes
  one only where the route gate refuses, and the gate cannot see the target's
  role without a read.
- **The invite is refused at creation, not only at redemption.** Redemption
  claims the invite before it reads the membership, so a refusal there burns
  it. Refusing at creation means the invitee is never sent an invite that
  cannot redeem. The sign-in path skips before the claim, so the invite stays
  pending.
- **Fixtures that modelled the forbidden state were moved, not exempted.** Two
  MCP suites used "an OWNER narrowed by a custom role" as their redaction
  principal. They now use an ADMIN, which keeps the property under test (the
  narrowing travels `resolveTenantContext`) without depending on a state the
  database now refuses.

## #3727 — a campaign does no OWNER-tier work

Found while verifying #3720's writers. Closing a member campaign writes its
decisions under `access_reviews.close`, which an ADMIN holds, and nothing
excluded the closer's own membership. So an ADMIN could create a campaign over
themselves, MODIFY themselves to OWNER and close it; demote or revoke an OWNER;
or hand a member an existing custom role without `assertGrantWithinOwnAuthority`.
Owner decisions (2026-10-18):

1. A campaign never promotes anyone to OWNER (`CAMPAIGN_MODIFY_ROLES`).
2. Lowering an OWNER — a REVOKE, or a MODIFY, which with (1) can only lower —
   needs a closer holding `admin.owner_management`. The last-OWNER guard applies
   as well.
3. A MODIFY sets a built-in role only, never a custom role.

```
                      schema (submit)          close (every stored decision)
MODIFY → OWNER        400 NEVER_PROMOTES_…     409 CAMPAIGN_NEVER_PROMOTES_TO_OWNER
MODIFY + custom role  400 MODIFY_SETS_NO_…     409 CAMPAIGN_MODIFY_SETS_NO_CUSTOM_ROLE
lower a LIVE OWNER    —                        403 OWNER_SUBJECT_NEEDS_OWNER_CLOSER (closer lacks owner_management)
REVOKE a legacy row   —                        409 BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE (#3720's CHECK)
```

### Decisions

- **The whole close is refused, not the offending decision.** A CLOSED campaign
  is immutable, so a decision skipped at close could never be carried out, and
  the sealed evidence would record a reviewer's verdict nobody acted on — the
  "silently dropped" the owner ruled out. It is also the shape the close already
  had for a pending decision, an unassignable MODIFY and the zero-OWNER
  projection. The campaign stays open; the message names the reason, the
  decision ids and the way out (an OWNER closes it, or the reviewer revokes the
  decisions and records them again).
- **Rule 2 reads the LIVE role.** It is what the write changes: a subject
  promoted to OWNER since the snapshot is held, one demoted since is not.
- **Named in the schema by `params.reason`, not by enum.** OWNER stays in
  `ASSIGNABLE_TENANT_ROLES`'s enum and is refused by a refinement, so the caller
  learns why. `modifiedToCustomRoleId` stays in the shape so a client still
  sending one is refused by name rather than having it stripped in silence;
  `submitDecision` stores NULL.
- **Every named refusal writes an audit row, outside the refused transaction.**
  `ACCESS_REVIEW_DECISION_REFUSED` and `ACCESS_REVIEW_CLOSE_REFUSED` carry the
  reason and decision ids. The close's refusal is thrown inside its
  transaction, so the row is written after the rollback (`recordCloseRefusal`),
  never relying on `logEvent` happening to use its own connection. The decision
  route audits a schema refusal from `parseJsonBody`, and `submitDecision` from
  its own parse, so it is recorded once whichever reached the schema first.
- **A REVOKE of a legacy OWNER that still carries a custom role is named**
  rather than surfacing as #3720's CHECK failing mid-close. A MODIFY of one
  writes `customRoleId: null` and satisfies the CHECK.
- **Unreachable code removed, not left.** #3720's narrower close check (OWNER
  plus a custom role) and its schema refinement went with rule 3, and the
  projected-OWNER GAIN term went with rule 1: nothing can gain OWNER at close.
- **A behaviour change for open campaigns.** One holding a MODIFY to OWNER or
  with a custom role, or one an ADMIN means to close that lowers an OWNER, now
  refuses to close until an OWNER closes it or the decisions are re-recorded.
