# 2026-10-18 — Tenant-authored skills under the review lifecycle (step 4c)

**Commit:** `feat(agentic): tenant-authored skills under the review lifecycle (4c)` (#3680)

## Design

Settled decision Q5 keeps the repository corpus Inflect-original and lets
third-party methodology in only as a tenant's own skill, behind the lifecycle a
repository skill has. Each repository control has a tenant counterpart:

| Repository skill | Tenant skill |
|---|---|
| a pull request | a new `TenantSkillVersion`, which starts at `DRAFT` |
| `parseSkillDocument`'s rules | the same rules, through `validateSkillFields` (extracted from it) |
| the load-time text scan | the same `scanSkillText`: at save as feedback, at mount as the gate |
| a committed `evaluation-record.json` | a record attached to the draft once, stored only if it passes |
| a reviewer other than the author | an approver other than the author, by usecase and CHECK |
| the merged text | `approvedContentHash`, recomputed against the decrypted text at every mount |

```
author ──create/edit──▶ DRAFT ──attach record──▶ DRAFT+record ──submit──▶ IN_REVIEW
                                                                             │
                     another holder of admin.agent_skill_review ──approve(hash)┘
                                                                             ▼
   run admission / each Flue segment ── tenant-mount.ts (own tenant, APPROVED,
   names the workflow) ── resolveRunSkills: repo skills, then tenant skills,
   each through checkTenantSkillMountable, ONE catalogue budget ──▶ pins
```

The mount half is pure (`tenant-skill.ts`, `resolveRunSkills`), and the read
half (`tenant-mount.ts`) is the only place a tenant's rows are fetched for a run:
under `runInTenantContext`, filtered on `ctx.tenantId`, with no parameter that
names a tenant. Run admission (`workflow-runs.ts`) and every Flue segment
(`execute.ts`) call it, so a version approved, superseded or retired mid-run
drifts the pin and fails the run before the model is called.

## Files

| File | Role |
|---|---|
| `prisma/schema/agentic.prisma`, `enums.prisma`, `auth.prisma` | `TenantSkill`, `TenantSkillVersion`, two new enums, Tenant back-relations |
| `prisma/migrations/20261019030000_tenant_skills/` | Tables, CHECKs, partial unique indexes, lifecycle triggers, grants, RLS |
| `src/lib/agentic/flue/skills/tenant-skill.ts` | The tenant mount gate and record recomputation (pure) |
| `src/lib/agentic/flue/skills/tenant-mount.ts` | The own-tenant read and the async mount used by admission and execution |
| `src/lib/agentic/flue/skills/resolve.ts` | `resolveRunSkills`, combined budget, tenant-aware catalogues, drift on stored pins |
| `src/lib/agentic/flue/skills/mount-gate.ts` | Repository and tenant pin types, `pinForRow`, `parseMountedSkillPins` |
| `src/lib/agentic/flue/skills/index.ts` | `validateSkillFields` extracted from `parseSkillDocument`; `isSkillName` |
| `src/app-layer/usecases/tenant-skills.ts` | The single writer: create, edit, evaluate, submit, approve, reject, retire, reads |
| `src/app-layer/schemas/tenant-skill.schemas.ts` | Request bodies and the loader's limits for the form |
| `src/app/api/t/[tenantSlug]/admin/agents/skills/tenant/**` | Eight routes, each a literal `requirePermission('admin.agent_skill_review')` |
| `src/lib/permissions.ts`, `src/lib/auth/api-key-auth.ts` | The new key: OWNER, ADMIN, AI_ADMIN; subtracted from `*` |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/` | Skills tab split into a read-only repository section and the workspace section, editor modal, review sheet |
| `src/lib/observability/integration-metrics.ts` | `agentic.tenant_skill.mount` and `agentic.tenant_skill.review` |

## Decisions

- **The review key and its holders** (owner decision, 2026-10-18).
  `admin.agent_skill_review` is held by OWNER and ADMIN, as step 0e's signed
  table names, and by `AI_ADMIN` because `AGENT_ADMIN_KEYS` must name every
  `agent_*` key and that role holds them all. ADMIN stays a holder because the
  four-eyes rule needs two holders, and a one-OWNER tenant without ADMIN could
  never approve. One key gates authoring and approval: the separation is the
  author/approver person rule, not a second key.
- **Who produces an evaluation record** (owner decision, 2026-10-18). The author
  attaches a record in the repository's own format to the draft. The server
  checks it with `checkEvaluationRecord`, recomputes the rates, and stores it
  only if it passes. Inflect does not run the evaluation set server-side.
  Running it against the tenant's residency-selected model would send tenant
  text to a model outside a run and spend the tenant's tokens. The reviewer
  sees who attached the record, which model revision answered it and the
  recomputed rates.
- **An edit leaves the approved version serving.** "Mounts nothing until
  re-approved" is about the new version: the old approved text keeps teaching
  until a second person approves the new hash, then is retired as superseded in
  the same transaction. Retiring the approved version is the way to stop a
  skill at once.
- **Freezing encrypted text.** A trigger freezes the plaintext columns for every
  role but can freeze the encrypted ones against `app_user` only, because the
  DEK rotation sweep re-encrypts in place as the owner. The mount gate's
  recomputation of the instructions' hash against `approvedContentHash` is what
  binds the text for every other writer. `description` stays plaintext so the
  trigger can freeze it for every role.
- **Pin format.** A tenant pin is `{ name, version, contentHash, origin:
  'tenant', versionId }`. A repository pin keeps exactly its three keys, so a
  run pinned before this change computes the same pin on resume and does not
  drift. Repository pins come first in declaration order, tenant pins after in
  code-unit name order, so the order is the same on every host.
- **Names.** A tenant skill may not take a repository skill's name, refused at
  creation and again at mount: the runtime mounts a name once, and a delegated
  specialist narrows its parent's skills by name, so a collision would either
  throw or reach a specialist. The catalogue line is the name the author chose,
  with no prefix.
- **Which workflows.** A version names the workflows it mounts on and the
  approval covers the list. Only workflows that ask for the Flue engine can be
  named, because a static run mounts no skill and a skill attached to one would
  read as taught when it never is.
- **Budget, twice.** Approval refuses a version that would put a workflow it
  names over budget, under a per-tenant advisory lock, and every run applies the
  combined budget again, because two approvals and a deploy can still race.
- **Retention class** (owner decision, 2026-10-18). `TenantSkillVersion` is a
  business record, purged with the tenant, not the regulatory artefact the
  roadmap planned. Its text is often a third party's methodology held under
  the tenant's licence, which a purge must not keep, and the runs whose pins
  name it are purged with the tenant anyway. The hash-chained `TENANT_SKILL_*` audit rows carry each version's
  content hash and survive.
