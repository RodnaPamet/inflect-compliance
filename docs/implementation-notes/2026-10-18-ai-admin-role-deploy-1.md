# 2026-10-18 — AI_ADMIN role, deploy 1 of 2 (read-only)

**Commit:** `feat(agentic): AI_ADMIN role, read-only — agent keys, admin.agent_ownership, agent-path edge allowlist (2a deploy 1)`

Issue #3699, part of step 2a (#3669) of the agentic IAM roadmap. Precedent:
#3691 / #3696, which brought `UNCLASSIFIED` to `AiRiskTier` the same way.

## Design

A built-in tenant role that runs the agent register and can own and receive
agents without holding any tenant-wide admin key. It reaches `Role` in two
deploys because a running container whose generated Prisma client predates a
value fails EVERY read of a row that carries it — measured here, not assumed:
the integration suites run against a client generated before the value fail
with `Value 'AI_ADMIN' not found in enum 'Role'` on the first membership read.
So deploy 1 ships the value and teaches every reader, and nothing writes it.
Deploy 2 is the assignment: an OWNER sets it on the members page.

```
             ┌──────────────── readers: TENANT_ROLES (exhaustive) ────────────────┐
  Role enum ─┤                                                                    │
  (+AI_ADMIN)└── writers: ASSIGNABLE_TENANT_ROLES (excludes it until deploy 2) ───┘
                    role-change usecase · invites (create + both redemptions)
                    members/invites route schemas · access-review MODIFY
                    custom-role base · SCIM ceiling · Entra mapping · SSO JIT

  request ─▶ edge: checkAdminAccess ──▶ handler: requirePermission(key) ──▶ usecase floor
             AI_ADMIN only on              AI_ADMIN holds the agent keys      canWrite/canAdmin
             AI_ADMIN_ADMIN_PATH_PREFIXES  and no tenant-wide key            OR the agent key
```

The role's `PermissionSet` is READER's plus the seven agent keys. Its coarse
tier (`ROLE_ORDER`) is READER's, so every usecase gated on `canWrite` /
`canAdmin` alone still refuses it. The agent usecases used exactly such a
floor under their route key, which would have made the role unable to
register an agent; they now take `assertAgentGovernanceWrite` /
`assertAgentGovernanceAdmin` — the coarse tier OR the key the route requires.

The ownership transfer moved from `admin.tenant_lifecycle` to a new key,
`admin.agent_ownership`, held by OWNER and AI_ADMIN and not by ADMIN, on both
routes, in the usecase's own check, and in the recipient rule
(`TRANSFER_RECIPIENT_MEMBERSHIP_ROLES` gains AI_ADMIN).

## Files

| File | Role |
|---|---|
| `prisma/schema/enums.prisma`, `prisma/migrations/20261018110000_role_ai_admin/` | The value, appended; the migration is one `ADD VALUE IF NOT EXISTS` |
| `src/lib/roles.ts` | `TENANT_ROLES` (readers, compile-time exhaustive), `ASSIGNABLE_TENANT_ROLES` (writers), the shared refusal message |
| `src/lib/permissions.ts` | `admin.agent_ownership`; the AI_ADMIN set; `AGENT_ADMIN_KEYS`; the role switch made exhaustive |
| `src/lib/tenant-context.ts`, `src/lib/auth.ts`, `src/lib/agentic/agent-authority.ts`, `src/lib/auth/entra-role-mapping.ts` | The four `Record<Role, number>` ladders: READER's rung, and never-ranked for group mappings |
| `src/lib/auth/guard.ts`, `src/middleware.ts` | `AI_ADMIN_ADMIN_PATH_PREFIXES`, `isAiAdminAdminPath`, the `checkAdminAccess` branch |
| `src/app-layer/policies/agent-governance.policies.ts` | The agent usecases' floor |
| `src/app-layer/usecases/agent-{registry,policy-card,kill-switch,tool-exposure,risk-assessment,circuit-breaker}.ts`, `external-tool-parameters.ts`, `external-mcp-tools.ts`, `mcp-tool-manifest.ts`, `src/lib/agentic/run-concurrency-policy.ts` | The floor swapped in, keyed on the route's key |
| `src/lib/agentic/ownership-transfer.ts`, `usecases/agent-ownership-transfer.ts`, both transfer routes, `src/lib/security/route-permissions.ts` | `admin.agent_ownership` |
| `usecases/tenant-admin.ts`, `usecases/tenant-invites.ts`, `usecases/access-review.ts`, `schemas/access-review.schemas.ts`, `usecases/custom-roles.ts`, the members/invites routes | Writers refuse the value |
| `src/lib/scim/roles.ts`, `schemas/entra-group-mapping.schemas.ts`, `src/lib/auth/entra-role-mapping.ts` | Identity providers can never produce it |
| `admin/members/page.tsx`, `admin/rbac/page.tsx`, `AccessReviewDetailClient.tsx`, `tasks/[taskId]/page.tsx`, `policies/{audit-readiness,issue}.policies.ts`, `messages/*.json` | Readers: a label, a matrix column, a reader type split from the picker, READER parity on two deny-lists |

## Decisions

- **Last in the enum, by plain `ADD VALUE`.** `TenantMembership.role` is
  ordinal-sensitive: `resolveEmissionActor`, `resolveDrillActor` and the
  posture-summary cron all `orderBy: { role: 'asc' }` to find the most senior
  member. AI_ADMIN holds less tenant authority than every existing role, so
  it sorts last — never ahead of ADMIN, nor of EDITOR. No `orderBy: { role }`
  was changed; with the value last, each picker still finds an OWNER/ADMIN
  first and reaches an AI_ADMIN only in a tenant with nobody else.
- **The agent keys, all seven, and nothing tenant-wide.** `agent_harness_ingest`
  is not API-key-only (OWNER and ADMIN hold it to upload a report by hand), so
  AI_ADMIN holds it too. `agent_external_tools` is an agent key and is held.
  There is no skill key yet (the Skills tab reads under `agent_registry`;
  `agent_skill_review` is step 4c's), and the enumerating test fails on a new
  key until it is classified. Resource domains are READER's exactly —
  `access_reviews.decide` included, because the usecase narrows it to the
  assigned reviewer.
- **The floor, not the rung.** Raising `ROLE_ORDER.AI_ADMIN` to EDITOR's rung
  would have let the role register agents with no usecase change — and would
  have admitted it to every usecase gated on `canWrite` alone, which is most
  of the product's writes. The new floor is a strict superset of the one it
  replaces: nothing it used to admit is refused, and the only callers it newly
  admits hold the key the route already required (the role, and a custom role
  on a READER/AUDITOR base that a holder of that key chose to grant). No API
  key reaches the new branch: `*` subtracts the four keys the floor is asked
  about. Refusal messages are the old floors' verbatim.
- **What AI_ADMIN still cannot do, deliberately.** Approve or reject agent
  proposals (`assertCanWrite`, no key — it commits a business-data write);
  export the governance pack (it writes an Evidence row, `evidence.edit`);
  read `/agents/proposals`, `/agents/runs` or the `/admin/mcp` credential
  panel (`admin.view`); set the agent driver (`admin.tenant_lifecycle`) or the
  agent-enforcement security setting (`admin.manage`). Each is a tenant-wide
  key, and widening any of them is its own decision.
- **The edge allowlist includes `/api/t/:slug/admin/mcp/quarantine`.** It is
  the one route gated by an agent key outside `/admin/agents`, and the only
  data path of `/agents/quarantine`; leaving it out would give the role the
  key and no way to use it. The three page entries are compatibility
  redirects to `/t/:slug/agents/**`, which is not an admin path at all.
  `/admin/mcp` itself (credentials, `admin.view`) stays refused.
- **Canonical form or nothing.** `isAiAdminAdminPath` refuses a `%`, a
  backslash, an empty segment or a dot segment instead of decoding and
  reasoning about it: an allowlist that matches segments must be shown
  segments. The cost is a 403 for an AI_ADMIN on a malformed path.
- **ADMIN does not hold `admin.agent_ownership`** — the issue's default,
  shipped pending the owner's confirmation. An OWNER can grant it to an ADMIN
  through a custom role; an ADMIN cannot grant it to themselves
  (`permissionsExceeding`).
- **A stored AI_ADMIN group mapping is dropped at read**, not only refused at
  write: `NEVER_GROUP_MAPPED_ROLES` filters it before the winner is picked, on
  the sign-in path (which passes no ceiling) as well as SCIM Groups, and it is
  reported in `clampedGroupIds`.
- **Invites refuse at both ends.** `createInviteToken` refuses the role;
  `finalizeInviteRedemption` refuses an invite row that carries it (the
  token path has already claimed it, so it stays burnt — the documented safe
  failure); the sign-in-by-email loop skips such a row BEFORE claiming it, so
  one bad invite neither burns nor blocks the others.
- **An access review cannot write it either.** `modifiedToRole` was
  `z.nativeEnum(Role)`, which would have accepted the new value the moment the
  client was regenerated; it is now the writers' list, and closing a review
  whose stored MODIFY names an unassignable role refuses the whole close
  before any row executes.
- **The members page renders role labels** from the `roles` catalogue, for
  every role, so an AI_ADMIN member reads "AI admin" rather than the enum.
  Its picker does not offer the role.
- **Tests that enumerate roles read `TENANT_ROLES`, not `Object.values(Role)`.**
  The former is checked against the `Role` type at compile time; the latter is
  whatever generated client the runner loaded, and a worktree runner can load
  one that predates the value.
