# 2026-10-30 — Only an ADMIN membership carries an admin-only custom role

**Commit:** `feat(rbac): only an ADMIN membership carries an admin-only custom role`

## Design

Three layers disagreed about a custom role granting `admin.*` keys on an
EDITOR, READER or AUDITOR membership (#4467 findings 6 and 9, #4466 finding 9,
#4471):

- the pages read the custom-role-aware keys and offered admin controls;
- the edge (`checkAdminAccess`) reads the membership's built-in role and
  refuses `/api/t/:slug/admin/**`;
- the usecases' `assertCanAdmin` reads the coarse tier of the custom role's
  BASE.

A survey of every consumer found that whether a combination is dead depends on
the key and the surface, not on the key alone. Nine admin keys are consumed
outside the admin API (the agent pages, `/agent-runs`, billing events, the
server-rendered admin pages, which the edge does not refuse), so the owner's
first rule ("admin keys only on Owner/Admin") would have taken working access
away. The owner then ruled (2026-10-30), with that survey in front of them,
and ruled again the same day on what the survey found:

1. **Ten keys only on ADMIN.** On any membership but ADMIN, a custom role may
   not grant one of `ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS` in `src/lib/roles.ts`:
   the six consumed only behind the admin API (`ADMIN_API_ONLY_KEYS`), and four
   that are live elsewhere but reached only through a side door around the
   edge's role gate (`SIDE_DOOR_ADMIN_KEYS`).
2. **ADMIN base only on ADMIN.** A custom role's base is its carrier's role
   everywhere but the edge (`effectiveRole` in `resolveTenantContext`).
3. **The stored roles are settled once.** A migration states the ten `false`
   in every custom role that only non-ADMIN memberships carry.
4. **Refusals stay unaudited.**

The predicate compares two carriages, before and after a change:

```
customRoleCarriageRefusal(after, before)
  offence(c) = { adminBase: admin-tier base on a non-ADMIN membership,
                 adminKeys: listed keys the role's EFFECTIVE grant holds }
  refuse what offence(after) adds to offence(before) — base first, then keys
```

Every writer of a membership's role or custom role, or of a custom role's base
or blob, asks it with what it read and what it is about to write.

## Files

| File | Role |
| --- | --- |
| `src/lib/roles.ts` | The list in its two parts, the two reasons, the pure predicate, its details and messages |
| `src/app-layer/usecases/custom-roles.ts` | `assertCustomRoleCarriageInTx` (the usecase half), the save check over every carrier (`groupBy` role), the assignment |
| `src/app-layer/usecases/tenant-admin.ts` | The members-page role change, and the role with its custom role saved together |
| `src/app-layer/usecases/tenant-invites.ts` | Invite creation, the token redemption's backstop, the sign-in redemption's pre-claim skip |
| `src/lib/auth/entra-group-sync.ts` | A mapping that would move such an ADMIN off ADMIN is held (`custom_role_held`) |
| `tests/helpers/route-authorization-graph.ts` | `reachedBodies`: the analyser's call graph, without stopping at a decision |
| `prisma/migrations/20261030170000_admin_membership_only_keys_off_for_non_admin_custom_roles/` | The ten stated `false` in roles only non-ADMIN memberships carry |
| `tests/integration/admin-membership-only-keys-migration.test.ts` | Runs that migration's SQL against a real database |
| `tests/guardrails/admin-membership-only-keys-are-dead-elsewhere.test.ts` | Fails when one of the six gains a consumer outside the admin API, or one of the four loses its last |
| `tests/unit/custom-role-carriage-writers.test.ts` | The census of writers, and each writer's refusal |

## Decisions

- **Ten keys, in two parts, and the second part takes something away.** Looked
  at closer, four of the ten first proposed are reachable by such a membership
  another way: `scim`, `compliance_dsar_manage` and `agent_harness_ingest`
  through an agent-bound API key acting for the membership (an `iflk_` bearer
  skips the edge's role gate, its context is the creator's permissions
  intersected with its scopes, and those admin routes check the key alone), and
  `agent_external_tools` and `agent_harness_ingest` through tool calls made for
  the membership (a run it starts at `/agent-runs` checks the starter's
  permissions; a key at `/api/mcp` its creator's). They were first left off.
  The owner then refused them too, because that path is a side door around the
  edge's role gate. So the earlier claim, that the rule costs nobody anything
  they could use, holds for the six only: going forward, a non-ADMIN membership
  cannot be given these four through a custom role, and the migration removed
  them where only such memberships carried the role. `admin.sso` is among the
  six: `admin:write` carries it, but no code reads it at all.
- **The guardrail holds both claims.** Rules 1 to 4 ask that the six stay dead
  outside the admin API. Rule 5 asks the opposite of the four, that each is
  still reached (a scope carries it; for the two agent keys, the tool funnel
  names it), so the docblock saying the rule takes them away stays true, and a
  key that has gone dead is noticed.
- **Only what a change adds is refused.** "Existing rows are not trapped" is a
  property of the predicate rather than of each writer: a clear, a narrowing
  save, a rename, a lower base, and a move among EDITOR, READER and AUDITOR
  (which the rule treats alike) never add an offence. No writer refuses a row
  for what it already carries; what stored roles carry was settled by the
  migration instead.
- **The migration switches keys off, and nothing else.** It touches a role only
  if at least one membership carries it and none of its carriers, of any
  status, is ADMIN, and only if the role still grants one of the ten as a
  request reads it: one stated `true` on a READER, EDITOR or AUDITOR base, or
  any not stated `false` on an ADMIN base, whose defaults grant nine of them.
  It states all ten `false` rather than removing them, because a removed key
  reads its base default or derives from another key (`agent_skill_author`
  from `agent_skill_review`). It never changes a base: an ADMIN-built role
  carried by Readers keeps its base and its other admin keys, and the writers
  refuse any new carrier. The base filter is an allowlist for #4520's reason,
  so a legacy OWNER- or AI_ADMIN-based row under the NOT VALID #3734 CHECK is
  left alone rather than failing the deploy. A role with any ADMIN carrier
  keeps its keys for its other carriers too; that is the owner's scope.
- **The base refusal comes first.** An ADMIN base grants nine of the ten keys by
  default, so the base is the change that decides what the keys are.
- **The Admin-base rule's refusal is asked before this one on a save.** #4536
  made Personnel / manage need an Admin base, and #4595 generalised it to
  `ADMIN_BASE_ONLY_PERMISSIONS` (`src/lib/custom-role-admin-base-rule.ts`: that
  key plus `admin.manage`, `admin.members`, `admin.owner_management` and
  `admin.tenant_lifecycle`). Both rules can refuse one custom role update: a
  permission on a base that may not hold it (400, `PERMISSION_NEEDS_ADMIN_BASE`)
  and a base or key the carriers may not take (409). The Admin-base check reads
  only the request, the carriage check reads every carrier, so the cheap one
  runs first and wins. They never ask for contradictory fixes: with non-ADMIN
  carriers the base cannot become ADMIN, so a save satisfies both by switching
  those permissions off, or by making every carrier an Admin first.
- **The two rules, and their migrations, are orthogonal.** The Admin-base rule
  judges a role's base, this one its carriers, and the key sets are disjoint
  (#4595's `ADMIN_KEYS_ON_ANY_BASE` lists all ten of these as allowed on any
  base, which is true: this rule restricts who carries them, not the base).
  #4595's migration (`20261030150000`) runs first and switches its four admin
  keys off on READER, EDITOR and AUDITOR bases; this one (`20261030170000`,
  renamed from a `150000` prefix that collided with it) switches the ten off by
  carrier. A real-DB test runs both in each order and gets the same rows: an
  ADMIN-based role carried only by Readers keeps `admin.manage` and loses the
  ten; a READER-based role carried by an Admin loses `admin.manage` and keeps
  the ten.
- **A legacy OWNER base is judged as admin-tier.** No writer makes one
  (`VALID_BASE_ROLES`, a NOT VALID CHECK); the rule reads the tier, not the
  name, so one left over is not mistaken for harmless.
- **The save counts carriers of every status.** A deactivated member is one
  reactivation from carrying the role live. Counted per built-in role with
  `groupBy`, so a role carried by thousands costs one row per role.
- **No DB CHECK.** The rule reads `permissionsJson` parsed over the base role's
  defaults (`parsePermissionsJson`), and those defaults live in TypeScript, not
  in SQL. It also spans two tables (the membership's role, the custom role's
  base and blob), which a CHECK cannot read. A trigger could compare the base
  half alone, but it judges the row, not the change, so it would trap the
  legacy rows this rule leaves alone, and it would put half of one rule in the
  database and the other half in code.
- **The unable writers are verified, not assumed.** A campaign MODIFY clears the
  custom role in the same write; an ownership transfer writes OWNER (only for a
  member carrying none) and ADMIN; SCIM moves roles only among EDITOR, READER
  and AUDITOR; every other writer creates rows with no custom role. The census
  reads each of those off the source.
- **Refusals are not audited.** The assignment and save refusals follow
  `BUILT_IN_SCOPE_ROLE_CARRIES_NO_CUSTOM_ROLE`, which writes no row: they refuse
  a configuration, not an access. The Entra sync logs and counts, as its other
  holds do.
- **The structural guardrail's limits.** It follows calls syntactically for three
  module hops from every non-admin route and every server page and layout, and
  scans the tool funnel, the agent engines, the AI layer and the jobs directly.
  It does not follow JSX, `import()` or a computed key. A page that reads a key
  only to decide whether to show an admin-API control is listed as such, with
  its reason, and may not read one in anything it calls.
