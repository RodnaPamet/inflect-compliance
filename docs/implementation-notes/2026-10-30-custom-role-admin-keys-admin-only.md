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
away. The owner then ruled (2026-10-30), with that survey in front of them:

1. **Dead keys only.** On any membership but ADMIN, a custom role may not grant
   a key consumed only behind the admin API: `ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS`
   in `src/lib/roles.ts`.
2. **ADMIN base only on ADMIN.** A custom role's base is its carrier's role
   everywhere but the edge (`effectiveRole` in `resolveTenantContext`).

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
| `src/lib/roles.ts` | The list, the two reasons, the pure predicate, its details and messages |
| `src/app-layer/usecases/custom-roles.ts` | `assertCustomRoleCarriageInTx` (the usecase half), the save check over every carrier (`groupBy` role), the assignment |
| `src/app-layer/usecases/tenant-admin.ts` | The members-page role change, and the role with its custom role saved together |
| `src/app-layer/usecases/tenant-invites.ts` | Invite creation, the token redemption's backstop, the sign-in redemption's pre-claim skip |
| `src/lib/auth/entra-group-sync.ts` | A mapping that would move such an ADMIN off ADMIN is held (`custom_role_held`) |
| `tests/helpers/route-authorization-graph.ts` | `reachedBodies`: the analyser's call graph, without stopping at a decision |
| `tests/guardrails/admin-membership-only-keys-are-dead-elsewhere.test.ts` | Fails when a listed key gains a consumer outside the admin API |
| `tests/unit/custom-role-carriage-writers.test.ts` | The census of writers, and each writer's refusal |

## Decisions

- **Six keys, not the ten first proposed.** Looked at closer, four of the ten
  are reachable by such a membership another way, and were left off:
  `scim`, `compliance_dsar_manage` and `agent_harness_ingest` through an
  agent-bound API key acting for the membership (an `iflk_` bearer skips the
  edge's role gate, its context is the creator's permissions intersected with
  its scopes, and those admin routes check the key alone), and
  `agent_external_tools` through every tool call made for the membership (a run
  it starts at `/agent-runs` checks the starter's permissions; a key at
  `/api/mcp` its creator's). `admin.sso` stays: `admin:write` carries it, but
  no code reads it at all.
- **Only what a change adds is refused.** "Existing rows are not migrated or
  trapped" is a property of the predicate rather than of each writer: a clear,
  a narrowing save, a rename, a lower base, and a move among EDITOR, READER and
  AUDITOR (which the rule treats alike) never add an offence. A legacy row
  keeps working until somebody changes it, and nothing it already does is
  refused.
- **The base refusal comes first.** An ADMIN base grants five of the six keys by
  default, so the base is the change that decides what the keys are.
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
