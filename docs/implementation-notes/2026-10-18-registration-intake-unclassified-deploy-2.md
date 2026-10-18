# 2026-10-18 — Registration intake from a shadow-agent finding (2a, deploy 2 of UNCLASSIFIED)

**Commit:** _(this PR)_ `feat(agentic): registration intake from a SHADOW_AGENT finding, the one UNCLASSIFIED writer (2a deploy 2)`

The last open part of step `2a` (#3669). Deploy 1 (#3696) added `UNCLASSIFIED`
to `AiRiskTier` and taught every reader. #3703 shipped the retirement cascade
and the ownership transfer. This PR adds the writer.

## Design

```
POST /api/t/:slug/admin/agents/intake            requirePermission('admin.agent_registry')
  └ registerShadowAgent (usecases/agent-registration-intake.ts)
      assertAgentGovernanceWrite + admin.agent_registry
      schema (.strict — no tier, no questionnaire)
      OWNER_NOT_CONFIRMED  ← no ownerUserId, or confirmOwner !== true      (before any read)
      SUGGESTION_INVALID   ← attribution fails parseOwnershipAttribution   (1d's contract)
      ── one runInTenantContext ───────────────────────────────────────────────
      Finding (tenant, not deleted)                FINDING_NOT_FOUND
        discoveredIdOfShadowFinding               NOT_A_SHADOW_AGENT_FINDING
      DiscoveredAgent (tenant, discoveredId)      DISCOVERED_AGENT_NOT_FOUND
        registeredAgent live?                     ALREADY_REGISTERED
      findIntakeClaim (any row, any status)       ALREADY_REGISTERED_BY_INTAKE
      attribution.discoveredAgentId == DA.id?     SUGGESTION_FOR_ANOTHER_AGENT
      ACTIVE membership of ownerUserId            OWNER_NOT_ACTIVE_MEMBER
      vendor in tenant (THIRD_PARTY)
      AiSystemRepository.createProvisional        riskTier UNCLASSIFIED, clause/rationale/answers NULL
      insertRegisteredAgentInTx                   DRAFT, unscored, intakeDiscoveredAgentId = DA.id
        P2002 (the claim's unique index)          ALREADY_REGISTERED_BY_INTAKE, all rolled back
      audit: AI_SYSTEM_REGISTERED · AGENT_REGISTERED (operation intake, provenance) · AGENT_REGISTRATION_INTAKE on the Finding

next harness scan reports registeredAgentId ──▶ ingest links DiscoveredAgent, closes SHADOW_AGENT

activateRegisteredAgent ─▶ applyRegisteredAgentStatus(ACTIVE) ─▶ assertActivatable
                                                                   1. AI_SYSTEM_UNCLASSIFIED
                                                                   2. UNSCORED
POST /api/t/:slug/ai-systems/:id/classification  (assertCanWrite)
  └ classifyAiSystemEntry: all four answers required → classifier → classifyProvisional
                           (WHERE riskTier = UNCLASSIFIED) → link the tier's obligations
```

## Files

| File | Role |
|---|---|
| `prisma/schema/agentic.prisma` | `RegisteredAgent.intakeDiscoveredAgentId` (nullable, no FK) and `@@unique([tenantId, intakeDiscoveredAgentId])`. |
| `prisma/migrations/20261018120000_registered_agent_intake_claim/migration.sql` | `ADD COLUMN` plus the unique index. Additive. |
| `src/app-layer/repositories/AiSystemRepository.ts` | `createProvisional`, the only store of the value, which takes no tier. `classifyProvisional` is the one move out of the value. |
| `src/app-layer/repositories/RegisteredAgentRepository.ts` | `create` accepts the claim; `getAiActClassification`; `findIntakeClaim`. |
| `src/app-layer/usecases/agent-registration-intake.ts` | New. `registerShadowAgent`, the intake. |
| `src/lib/agentic/registration-intake.ts` | New, pure. The refusal set and the suggestion provenance, which holds no person reference. |
| `src/lib/agentic/harness-findings.ts` | `shadowRefOf` / `discoveredIdOfShadowFinding`. One definition of the `SHADOW_AGENT:` ref, used by the planner and the intake. |
| `src/app-layer/usecases/agent-registry.ts` | `insertRegisteredAgentInTx`, the register row's write recipe, now shared by `createRegisteredAgent`, `registerAgent` and the intake. `assertVendorInTenant` exported. Activation's preconditions moved into `assertActivatable`, called by the status writer for every move to `ACTIVE`, with `AI_SYSTEM_UNCLASSIFIED` added ahead of `UNSCORED`. |
| `src/app-layer/usecases/ai-system.ts`, `schemas/ai-system.schemas.ts` | `classifyAiSystemEntry` and `ClassifyAiSystemSchema`. |
| `src/app-layer/schemas/agent-registry.schemas.ts` | `RegistrationIntakeSchema` (strict). |
| `src/app/api/t/[tenantSlug]/admin/agents/intake/route.ts` | New route, with a literal `requirePermission('admin.agent_registry')`. |
| `src/app/api/t/[tenantSlug]/ai-systems/[systemId]/classification/route.ts` | New route; the usecase's `assertCanWrite` gates it. |
| `src/lib/security/route-permissions.ts` | An explicit `/admin/agents/intake` rule above the catch-all. |
| `public/openapi.json` | Stub entries for the two routes. |
| `tests/guards/ai-risk-tier-unclassified-writers.test.ts` | From "no writer" to "exactly one writer". |
| `tests/guardrails/admin-route-coverage.test.ts`, `tests/guards/agentic-route-inbound-links.test.ts` | The new admin route, listed. |

## Decisions

- **A real classify verb was needed, and is built here.** The `AiSystem` seam
  had no update: an entry was classified at insert or never. So decision 1's
  "cannot become ACTIVE until classified" had no way out, and an intake agent
  would have stayed `DRAFT` for good. `classifyAiSystemEntry` is the smallest
  verb that closes that gap. It moves a provisional entry out of `UNCLASSIFIED`
  once, through the classifier, and links the tier's obligations. It refuses an
  entry that is already classified. Re-classifying a classified entry would
  replace its answers while leaving its old tier's obligations linked, which is
  a different act. Its gate is `assertCanWrite`, the one `createAiSystem` uses,
  because classifying at insert is the same act. Activation keeps its own key
  and its score precondition.
- **The questionnaire must be answered, not defaulted.** `createAiSystem` reads
  an absent questionnaire as `{}` and classifies it MINIMAL. That was tolerable
  for an entry authored in one step. It is wrong for an entry that exists
  because nobody had classified it. `ClassifyAiSystemSchema` requires all four
  keys, with `null` meaning "does not apply". So `{}` is a 400, and the stored
  answers always read as "assessed, and nothing applies".
- **The store fixes the value, and the guard counts references to the store.**
  `createProvisional` takes no tier, so no caller can choose it, and `create`
  keeps its classifier-only type. The writer is therefore the file that
  REFERENCES `createProvisional`. Any reference counts, a call or a destructure,
  so an alias cannot reach it either. Exactly one file outside the seam may,
  the intake. Inside the seam the value may appear only in the store's insert
  `data` and the classify's `WHERE`. Both are asserted on the extracted blocks,
  and so is the rest of the seam, so a third mention fails.
- **Idempotency is a column and a unique index.** A second intake for one
  discovered agent must never make a second register row. A read alone cannot
  hold that under a race, and the audit trail cannot either: `logEvent` writes
  on its own connection, outside the transaction. So the register row carries
  the discovered agent's id, unique per tenant. Postgres treats NULLs as
  distinct, so every other row is unconstrained and no partial index is needed,
  and Prisma can declare the constraint. The claim read is not filtered on
  `deletedAt` or status, so it matches what the index matches. A retired intake
  row keeps its claim.
- **No FK on the claim.** `DiscoveredAgent.registeredAgentId` already references
  `RegisteredAgent`. A second FK back would make the two tables a reference
  cycle that no row-by-row delete gets out of. That includes test teardown and
  any future purge. Discovered agents are never deleted while their tenant
  exists, and the intake resolves the row under RLS in the same transaction it
  writes the column. Nothing reads the column to authorize anything.
- **The finding is left open, and the discovered agent is not written.**
  `DiscoveredAgent` has one writer, the harness ingest
  (`agent-harness-single-write-seam.test.ts`). A harness finding closes only
  on positive evidence, here a scan that sees the agent in the register. So
  the intake writes neither. The next scan that reports the new row's id links
  it and closes `SHADOW_AGENT`; the integration test drives exactly that. The
  intake leaves an `AGENT_REGISTRATION_INTAKE` audit row on the finding, so the
  finding's own history names the register row it became.
- **The suggestion is provenance, and the person's reference is not kept.** The
  attribution answer is parsed through `parseOwnershipAttribution`. A malformed
  one is refused (`SUGGESTION_INVALID`) rather than dropped, because silently
  losing provenance is worse than asking for it again. One about a different
  discovered agent is refused too. The audit row records the status, the grade,
  each signal's kind and evidence pointer and whether it named a person, and
  `confirmedOwnerIsSuggested`. It does not record the suggested reference or
  any `personRef`: those are source-namespace identifiers, often an e-mail
  address, and audit `detailsJson` streams to the tenant's SIEM. The match is by
  user id, or by e-mail lookup hash for an e-mail-shaped reference. `FALSE` means
  "not shown to agree" and does not prove a different person.
- **Activation checks classification before the score, in the status writer.**
  An intake agent is both unclassified and unscored, and the regulatory
  classification of its system is the fact the register cannot otherwise state.
  So `AI_SYSTEM_UNCLASSIFIED` is asked first. Both checks moved into
  `assertActivatable`, which `applyRegisteredAgentStatus` calls for every move
  to `ACTIVE`. `activateRegisteredAgent` was the only caller passing `ACTIVE`
  before this change and still is, but a future path that reaches `ACTIVE`
  through the status writer meets both checks. The refusals carry
  `details.reason` beside an unchanged human sentence, so the unscored
  message every existing test matches is untouched.
- **No lock on the activation check.** The only write of the value is an INSERT
  of a new entry, an agent's `aiSystemId` is not amendable, and the one update
  moves an entry out of the value. So a concurrent write can only turn a
  refusal into a pass, never a pass into an agent that is `ACTIVE` while
  unclassified.
- **The register row's write recipe is shared, not copied.** `createRegisteredAgent`
  and `registerAgent` each spelled out the same insert (sanitise the
  description, normalise the model, create). The intake would have been a third
  copy, so the recipe is now `insertRegisteredAgentInTx`. Owner and vendor
  checks stay with each caller, ahead of any write, so a refused registration
  still leaves no half-authored entry. The intake reads the membership itself
  because it needs a named refusal and the owner's e-mail hash.
- **No UI in this PR.** The shadow list on `/agents/reports` has no finding id
  per row. The intake form needs the register's owner and vendor lists, which
  the reports page does not load, and the five required agent fields, which is
  most of `NewAgentModal`. Classifying a provisional entry needs the
  questionnaire on the AI-system detail page. Both are follow-ups, recorded as
  API-only in `agentic-route-inbound-links.test.ts`.
- **A rolled-back insert leaves an audit-extension row.** The Prisma client's
  audit extension (`src/lib/prisma.ts`) writes a row for each statement on its
  own connection as the statement runs. The loser of a racing intake therefore
  leaves a `CREATE AiSystem` row for an entry that rolled back. This holds for
  every rolled-back write in the product and is not changed here. The intake's
  own rows are written last, by the winner only, and the race tests count
  those.
