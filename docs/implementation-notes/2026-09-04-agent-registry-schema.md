# 2026-09-04 — agent register: schema, isolation and the legacy backfill

**Commit:** `<pending> feat(agentic): the agent register — RegisteredAgent, its RLS, and the legacy backfill`

Stage 1 of two. This lands the model, the migration, the isolation proof and the
minimum write seam the encryption manifest requires. The HTTP surface, the risk
scorer and the per-agent framework-coverage query land on top of it.

## Design

A `RegisteredAgent` is one row per autonomous agent a tenant runs, carrying the
four properties that decide how much authority it may hold:

```
autonomyLevel   Int 0-6      how much it does without being asked
dataAccessScope enum         how far into tenant data it reaches   (ordinal, scored)
reversibility   enum         how hard its actions are to undo
provenance      enum         whose code it is  (THIRD_PARTY ⇒ a named Vendor)
      ↓
riskTier        enum?        the scored operational tier — NULL until scored
```

It is a **sibling** of `AiSystem` with a **required 1:1 link** to it:

```
AiSystem  1 ──── 0..1  RegisteredAgent  1 ──── *  AgentProposal
(EU AI Act register)   (agent register)  1 ──── *  WorkflowRun
```

### Why a sibling, not a discriminator on AiSystem

`AiSystem` is the EU AI Act register (Regulation (EU) 2024/1689) and every
column on it is Act vocabulary: its `riskTier` is the Act's tier, its
`classificationClauseId` is the clause that produced that tier, its
`deploymentRole` is provider-vs-deployer. An agent's governing questions are
not Act questions.

Three things decided it, and the third is the one that would have cost real
money:

- **The registry UI is not inherited.** All five list columns on the AI-system
  page are Act semantics (`riskTier`, `classificationClauseId` rendered as
  "Basis", `deploymentRole` rendered as "Role"), the sole filter is the EU tier,
  and the detail page has no tab bar. Separately,
  `aiSystemRequirementLink` has **zero read sites** in `src/` —
  `framework/coverage.ts` joins `controlRequirementLink` — so per-agent coverage
  is a query somebody has to write under either option. "Inherits the registry
  for free" was not true.

- **House precedent.** Discriminators in this repo sit on OPERATIONAL tables
  (`Asset.type`, `Task.type`); PRINCIPALS get their own table
  (`AuditorAccount`, `TenantDeviceToken`). An agent is a principal with a kill
  switch, and a kill switch on a row in a regulatory register is a category
  error. `POST /api/t/:slug/ai-systems` also carries no `requirePermission`
  (only `assertCanWrite`), so extending it would have made a table any
  write-capable member can insert into the authorization subject for tool
  exposure.

- **`ownerUserId` decided it.** On `AiSystem` the column is `String?` with no
  `@relation`. On a shared table it could only ever be a partial CHECK
  ("required when the row is an agent"), which Prisma cannot express — so it
  would be typed `string | null` forever. The downstream rule "the second
  approver must not be the agent's registered OWNER" would then have to read
  `owner && owner === ctx.userId`, which **passes when the owner is unknown**.
  That exact fail-open shape already ships at `evidence.ts:534` and twice in
  `gap-assessment-assignment.ts`. On the sibling the column is `String` with a
  real FK and the null is unrepresentable.

Migration risk did not decide it: `AiSystem` holds zero production rows across
seven tenants. Shape did.

### Why the link is nevertheless required

Every agent IS an AI system in the Act's sense. Keeping the link NOT NULL keeps
`ai-system-conformity`'s `riskTier === 'HIGH'` branch reachable for agents and
gives per-agent framework coverage somewhere to hang
(`AiSystemRequirementLink`). `ON DELETE RESTRICT`, so deleting the register
entry cannot silently delete the agent that governs it.

The consequence is visible in the backfill: adopting legacy rows means creating
a synthetic `AiSystem` for them too. That is the required link doing its job,
not an accident of it.

### The refusals live in DDL

Three CHECK constraints, so no write path can get around them:

| Constraint | Says |
| --- | --- |
| `autonomyLevel BETWEEN 0 AND 6` | the ladder is a spectrum; an Int, never a boolean |
| `provenance <> 'THIRD_PARTY' OR vendorId IS NOT NULL` | third-party risk you cannot attribute to a named supplier is an unattributed binary |
| `(riskTier IS NULL) = (riskTierScoredAt IS NULL)` | a tier can never be read without knowing how stale it is |

The first two are also expressed in Zod, on purpose: the schema gives the caller
a field-level error, the constraint is what nothing can route around. The unit
suite asserts the Zod layer refuses **independently**, by reading the issue path
— a usecase test against a real database would stay green with the refinement
deleted, because the constraint would catch it.

### NULL means UNSCORED means deny

`riskTier` is nullable only between insert and the first scoring run. Every
consumer must read NULL as "deny", never as a low tier: an agent nobody has
assessed is exactly the one that should not be running. `createRegisteredAgent`
therefore leaves the tier NULL and the status `DRAFT` rather than seeding a
plausible-looking `LOW`.

`AgentDataAccessScope` is ordered least→most exposing and is **append-only**,
because the scorer reads the ordinal. Reordering it silently rescores every
registered agent.

`AgentRiskTier` is a **different taxonomy** from `AiRiskTier` and the two must
never be read for one another: `AiRiskTier` is regulatory classification
(which obligations apply), `AgentRiskTier` is operational authority (how closely
this thing is watched). A `LOW` agent inside a `HIGH`-tier AI system is an
ordinary combination.

### The backfill, and why it adopts nothing

`AgentProposal.agentId` and `WorkflowRun.agentId` are nullable in the SCHEMA and
required at the USECASE. The split is not laziness: the ALTER and the backfill
run in one transaction, so there is a moment where existing rows have no value,
and a NOT NULL column with no sensible default cannot be added to a populated
table without inventing one. A NULL therefore means "written before the register
existed" — never "any agent".

Both tables are measured EMPTY in production, so the shipped statements adopt
zero rows on the deploy that runs them. That makes them the most dangerous kind
of SQL: correct-looking and never once observed working. So
`tests/integration/agent-registry-legacy-backfill.test.ts` reads the
`-- ── Backfill ──` section **out of the migration file** and runs it against
seeded fixtures — a re-typed copy would only prove that the copy works.

The placeholder lands `SUSPENDED`, `isLegacyPlaceholder = true`, unscored, and
worst-case on every axis the constraints allow (`autonomyLevel 6`,
`EXTERNAL_EGRESS`, `TERMINAL`). An unregistered agent's real properties are
unknown, and the fail-closed reading of unknown is "the most dangerous thing it
could have been". `provenance` is `FIRST_PARTY` only because `THIRD_PARTY`
requires a vendor there is no way to name — that is the CHECK constraint
deciding, not a claim about the code's origin.

It needs an `ownerUserId` and refuses to invent one: the tenant's **oldest
ACTIVE OWNER** is used, and a tenant with none is **skipped**, not failed. Its
rows keep `agentId` NULL and stay visible as unattributed. A deploy that dies on
a tenant with a broken membership graph is a worse outcome than a handful of
unadopted rows.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/enums.prisma` | The five agent enums, with the append-only warning on the ordinal one and the `AiRiskTier` disambiguation on `AgentRiskTier` |
| `prisma/schema/agentic.prisma` | `model RegisteredAgent`; `agentId` on `AgentProposal` + `WorkflowRun` |
| `prisma/schema/ai-governance.prisma` | `AiSystem.registeredAgent` back-relation (0..1) |
| `prisma/schema/auth.prisma` | `Tenant.registeredAgents`, `User.registeredAgentsOwned` |
| `prisma/schema/vendor.prisma` | `Vendor.registeredAgents` |
| `prisma/migrations/20260904120000_agentic_agent_registry/migration.sql` | Enums, table, indexes, composite + owner + vendor FKs, three CHECKs, the RLS triple + FORCE + GRANT, the two `agentId` columns, the three-step backfill |
| `src/lib/security/encrypted-fields.ts` | `RegisteredAgent.description` joins the Epic B manifest |
| `src/app-layer/schemas/agent-registry.schemas.ts` | Create/update input rules — the axes carry no default, the THIRD_PARTY refinement |
| `src/app-layer/repositories/RegisteredAgentRepository.ts` | Tenant-filtered reads; conditional `updateMany` writes whose count is the caller's evidence the row was theirs |
| `src/app-layer/usecases/agent-registry.ts` | The write seam — sanitise, audit, kill switch, retire |
| `docs/data-retention.md` | Classification row |
| `tests/guardrails/tenant-isolation-forward-lock.test.ts` | `ISOLATION_TESTED` entry |
| `tests/guardrails/sanitize-rich-text-coverage.test.ts` | `RICH_TEXT_COVERAGE` entry |
| `tests/guardrails/schema-index-coverage.test.ts` | Layer-C triage entry |

## Decisions

- **A usecase layer landed in stage 1, which was not the original plan.**
  `KNOWN_UNCOVERED` in the sanitiser ratchet is capped at ZERO, so registering
  `description` as an encrypted column with no sanitising write path leaves the
  tree red. Not registering it is worse: `encryption-manifest-coverage` flags a
  `description` column on a tenant-scoped model unless it is encrypted or
  written down as plaintext-on-purpose, and it is neither. The honest resolution
  is a real write seam, which also gives the isolation suite real usecases to
  drive rather than raw Prisma.

- **`@@unique([aiSystemId])` AND `@@unique([aiSystemId, tenantId])`.** The
  single-column one IS the invariant; Prisma requires a unique over the exact
  relation field list before it will type a composite relation as 1:1. The
  composite is implied by the other, so the index is redundant at the DB —
  kept anyway so neither half is deleted as "obviously unnecessary" without the
  other being noticed.

- **`onDelete: Restrict` on the child `agentId` FKs, not `SetNull`.** The
  relation is composite (`agentId, tenantId`), and `tenantId` is NOT NULL, so
  `SetNull` is not expressible. It is also the right rule: the proposals an
  agent made are its audit trail, and deleting the agent should be refused
  rather than quietly orphaning them.

- **The three exposure axes carry no Prisma default.** The least-exposing value
  is also the lowest-scoring one, so a default would let a writer that forgot
  the field silently under-state risk. An omitted axis has to fail, not score
  zero.

- **A schema comment was reworded to say "write-capable member" rather than
  naming the role.** The Class D assertion-reach ratchet counts needles that
  match more places than the thing they name, and
  `enterprise-identity-epic.test.ts` asserts `toContain('EDITOR')` against the
  whole concatenated schema. Prose in a new model's doc comment pushed that
  needle from four satisfying positions to five and turned the ratchet red. The
  alternative — narrowing that guard to read the `enum Role` block — is the
  better fix in the abstract, but it moves two shared count baselines, and two
  branches lowering the same baseline merge CLEANLY while being wrong. It
  belongs in its own diff.

## Open question — deliberately not resolved here

**Must an agent be registrable WITHOUT an EU AI Act classification?** If yes,
the `aiSystemId` link becomes optional and this model degrades to a plain
sibling with no required parent. Built NOT NULL because there are zero
production rows, so relaxing the constraint later is a one-line migration —
and tightening it later would not be.
