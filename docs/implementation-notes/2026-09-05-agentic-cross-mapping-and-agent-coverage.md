# 2026-09-05 — Agentic cross-framework mapping + per-agent risk coverage

**Commit:** _(this PR)_ `feat(frameworks): map the agentic frameworks into the control library and report coverage per agent`

Stage 2 of the agentic-frameworks work. Stage 1
(`2026-09-05-agentic-frameworks.md`) authored the OWASP Agentic AI Top 10 and
the IMDA MGF as framework content. On its own that gives a customer two
frameworks at 0% and a control library that knows nothing about them. This
stage connects them: eight cross-framework mapping sets so an existing ISO
42001 / ISO 27001 posture inherits partial agentic coverage on day one, and the
per-agent coverage query that answers "which agentic risks is THIS agent
covered for" — a question the codebase could not previously answer at all.

## Design

### 1. Which representation the mappings are authored in

The same question stage 1 answered for framework content, answered the same
way. Mapping sets are **YAML in `src/data/libraries/mappings/`**, consumed by
the existing `mapping-set-importer.ts` (`scanMappingSetDirectory` →
`parseMappingSetFile` → `importMappingSet`), which `library-sync.ts` already
runs as phase 2 after framework import. No new machinery, no Prisma model, no
migration, no route for the mapping half.

Refs are **library `ref_id`s** (`ISO42001-2023`, `OWASP-ASI-TOP10`), because
that is what the importer resolves against `Framework.key`. That choice has a
consequence the coverage query has to absorb — see §4.

### 2. What was mapped, and why those pairs

Four ordered pairs, each shipped in both directions (§3):

| Pair | Entries (each way) | Why it exists |
|---|---|---|
| ISO 42001 ⇄ OWASP ASI | 38 | The AI management system a customer may already hold, against the ten risks it never names. **This is the map the commercial claim rests on.** |
| ISO 27001 ⇄ OWASP ASI | 39 | Most agentic risks are security risks wearing new clothes, and the shipped ControlTemplate library is heaviest on Annex A. Also the only edge that reaches the agentic frameworks from the ISMS side of the mapping graph. |
| ISO 42001 ⇄ IMDA MGF | 47 | Anchors the second agentic framework to the same AI-management standard. |
| OWASP ASI ⇄ IMDA MGF | 27 | The two agentic sources to each other: OWASP states RISKS, the MGF states GOVERNANCE EXPECTATIONS. |

**Methodology.** Every entry is `[curated]` — Inflect's judgement of conceptual
alignment, never part of either publication, and the rationale says so in the
first token so a reader never mistakes it for a citation. Strengths were chosen
against the published semantics in `docs/requirement-mapping-sets.md`, and the
selection is deliberately pessimistic:

- **No `EQUAL` anywhere.** Nothing in ISO 42001 or ISO 27001 *is* an agentic
  control. `determineGapStatus` turns `EQUAL`/`SUPERSET` into `COVERED`, so an
  over-generous strength would let a file we wrote certify a risk nobody looked
  at. The unit test asserts the absence.
- `SUBSET` only where the source is clearly NARROWER than the risk and covers a
  proper part of it — ISO 42001 A.4.2 (inventory of AI system resources) covers
  the unregistered-agent half of ASI10 and none of the orphaned,
  out-of-schedule or never-decommissioned halves.
- `RELATED` wherever the honest answer is "this is where the control would live
  if the standard had one". The gap layer never counts `RELATED` as coverage,
  so writing these down costs nothing and makes the SILENCES visible: ASI03
  (Identity and Privilege Abuse) gets four `SUBSET` routes from ISO 27001 and
  nothing but `RELATED` from ISO 42001, which is the accurate statement that an
  AIMS has no access-control clause.

Coverage is complete in both directions: all ten ASI risks and all nineteen MGF
requirements are reached from at least one control-library-backed framework,
with zero entries in the `UNMAPPED_WITH_REASON` escape hatch.

### 3. Both directions, and why a test rather than a generator

The reverse file is the exact transpose of the forward one with each strength
inverted (`SUBSET` ⇄ `SUPERSET`; `EQUAL` / `INTERSECT` / `RELATED` are
self-inverse). That is derived data living beside its source, which normally
argues for generating it at import time — but that would mean changing shared
machinery every existing mapping set flows through, to serve four pairs.

Instead the transposition is an asserted invariant:
`tests/unit/agentic-framework-mappings.test.ts` reconstructs the expected
reverse entry set from the forward file and compares, so editing one side alone
turns CI red. The mutation proof is in the verification list below: weakening a
single `SUPERSET` to `INTERSECT` on the reverse side is caught.

Only the agentic pairs are symmetric, and the doc now says why: both questions
get asked of a NEW framework ("what does my ISMS already give me" and "what
does my agentic control set give me toward the standard I certify against"),
whereas for the older pairs only the forward question is.

### 4. The per-agent coverage query

`computeAgentRiskCoverage(ctx, agentId)` in
`src/app-layer/usecases/agent-coverage.ts`, with the classification rules split
into a pure `src/app-layer/services/agent-risk-coverage.ts`.

```
RegisteredAgent ──(required aiSystemId)──▶ AiSystem
                                             │
                        AiSystemRequirementLink │  ← the ONLY per-agent signal
                                             ▼
   Control ──ControlRequirementLink──▶ FrameworkRequirement (ASI01…ASI10)
                                             ▲
                                RequirementMapping (curated, other frameworks)
                                             │
   Control ──ControlRequirementLink──▶ FrameworkRequirement (ISO 42001 / 27001)
```

Three inputs, one verdict per risk, reusing `GapStatus` verbatim rather than
inventing a vocabulary:

- `COVERED` — the agent's AI-system entry is scoped to the risk AND a live
  tenant control implements it.
- `PARTIALLY_COVERED` — a control exists but the agent was never scoped, or the
  only evidence is an inherited mapping.
- `REVIEW_NEEDED` — inherited through `RELATED` edges only.
- `NOT_COVERED` — nothing.

Plus a `reason` (`NOT_SCOPED` / `NO_CONTROL`) naming the single next action, and
four **disjoint code lists** that partition the ten risks. The lists are the
product: a percentage is the one number that cannot answer "which risk is
open", and the open one is all an assessor wants.

Two decisions carry the design:

**The agent link is required for `COVERED`.** Without that conjunction the
readout is identical for every agent in the tenant — a tenant readout wearing an
agent's name. `AiSystemRequirementLink` is the only per-agent signal the schema
has, and stage 1's `RegisteredAgent.aiSystemId` is a REQUIRED 1:1, so every
agent has a place to hang it.

**Inherited coverage is capped at `PARTIALLY_COVERED`**, even where
`determineGapStatus` would return `COVERED` off an `EQUAL`/`SUPERSET` edge. A
mapping is our curated judgement; letting it certify a risk would have the
product vouch for work nobody has done, on the strength of a file we shipped.
The cap is what makes the inherited path safe to ship at all.

### 5. Framework families — the part that makes it work on a real database

Every framework in this repo exists in up to TWO representations with DIFFERENT
`Framework.key` values: the seed row (`OWASP-ASI`, `ISO42001`) and the YAML
library row (`OWASP-ASI-TOP10`, `ISO42001-2023`). They must differ because
`key` is `@unique` and one shared key makes `prisma/seed.ts` and
`syncAllLibraries` fight over one row (stage 1's finding).

A tenant's controls hang off whichever representation its database was built
from. So:

- A single-key lookup for the agentic framework reports a tenant with a full
  ASI control set as covering nothing — and "covers nothing" is
  indistinguishable from a tenant that has done no work.
- Mapping sets are authored against LIBRARY keys, so matching mapping edges to
  tenant controls by requirement id alone makes inherited coverage **silently,
  permanently zero on every seeded database** — the commercial claim quietly
  untrue rather than visibly broken.

Both sides are resolved by FAMILY instead. The family key is
`Framework.sourceUrn` — the seed writes the library's urn verbatim, the
importer writes `library.urn`, so the two representations already agree on it
and no hand-maintained alias table is needed. Requirements are then collapsed
by `code`, which is the identifier an assessor cites and the one stage 1 made
the contract. Both directions are pinned by tests (tenant D in the integration
suite), each with its own sole detector.

The whole query is 6–8 bounded statements with no read inside a loop: the
framework catalogue (a small global table) is loaded once and grouped in
memory.

### 6. HTTP surface

`GET /api/t/:slug/admin/agents/:agentId/coverage`, gated by
`requirePermission('admin.agent_registry')`. The existing rule in
`route-permissions.ts` matches `^/api/t/[^/]+/admin/agents(/.*)?$`, so no new
rule was needed and a denial writes the same hash-chained `AUTHZ_DENIED` row as
the rest of the register.

## Files

| File | Role |
|---|---|
| `src/data/libraries/mappings/iso-42001-to-owasp-agentic.yaml` + `owasp-agentic-to-iso-42001.yaml` | The core pair. 38 curated entries each way. |
| `src/data/libraries/mappings/iso27001-to-owasp-agentic.yaml` + `owasp-agentic-to-iso27001.yaml` | ISMS ⇄ agentic risks, 39 each way. |
| `src/data/libraries/mappings/iso-42001-to-imda-mgf.yaml` + `imda-mgf-to-iso-42001.yaml` | AIMS ⇄ MGF, 47 each way. |
| `src/data/libraries/mappings/owasp-agentic-to-imda-mgf.yaml` + `imda-mgf-to-owasp-agentic.yaml` | The two agentic sources to each other, 27 each way. |
| `src/app-layer/services/agent-risk-coverage.ts` | Pure classification + summary. Owns the inherited-coverage cap. |
| `src/app-layer/usecases/agent-coverage.ts` | The query: agent → scope → direct controls → inherited controls, with family resolution. |
| `src/app/api/t/[tenantSlug]/admin/agents/[agentId]/coverage/route.ts` | Read-only HTTP surface. |
| `tests/unit/agentic-framework-mappings.test.ts` | Zero silent gaps · symmetry · no dangling refs · no `EQUAL`. |
| `tests/unit/agent-risk-coverage-classification.test.ts` | The classification rules, including the two that are counter-intuitive. |
| `tests/integration/agent-coverage-analysis.test.ts` | Four tenants, real DB: the ordinary case, cross-tenant isolation, the ISO 42001 inheritance claim, the two-representation collapse, the per-agent gate. |
| `tests/guardrails/schema-index-coverage.test.ts` | `AiSystemRequirementLink` triaged — its first `findMany` in `src/app-layer`. |
| `docs/requirement-mapping-sets.md` | Supported-sets table regenerated from the directory (it claimed 4 pairs / 78 entries against an actual 22 pairs before this change); agentic-symmetry rule documented. |

## Decisions

- **The mapping data is the deliverable, so it is held to account as data.** The
  unit test asserts against parsed YAML through the production scanner —
  never by matching source text — and its four invariants were each chosen
  because the failure mode is silent: an unreached risk looks like an
  uncontrolled one; a one-sided edit leaves a plausible file; a ref onto a
  non-assessable grouping node is skipped at import and does nothing forever.

- **`UNMAPPED_WITH_REASON` ships empty, and that is a finding rather than an
  oversight.** Every one of the twenty-nine agentic requirements has an honest
  route in from ISO 42001 or ISO 27001, even where the honest strength is
  `RELATED`. The escape hatch exists so a future risk with genuinely no route
  has to be written down rather than silently absent.

- **Reused `GapStatus` / `determineGapStatus` / `strengthToConfidence` rather
  than re-spelling the conservative semantics.** One place decides that
  `RELATED` is never coverage. The one addition — the inherited cap — is
  applied on top and named, not folded into a second copy of the rules.

- **No new Prisma model, so no migration and no RLS work.** The per-agent
  question is answerable from rows that already exist; adding a table would
  have created a second source of truth for "which risks apply to this agent"
  beside `AiSystemRequirementLink`. Two-tenant isolation is still proved
  behaviourally on the READ (tenant B holds the control for exactly the risk
  tenant A is missing; a leak would make A's report look BETTER, which is the
  kind nobody reports).

- **`framework: { key, name }` in the response is the first family member, and
  the tests deliberately do not assert it.** With two representations installed
  the choice is arbitrary; the CODE is the contract, and every assertion in
  the suite is on codes.

- **The route is read-only and emits no audit event.** It reads links that
  other seams wrote. Adding a `logEvent` here would put a row in the
  hash-chained trail every time somebody opened a page.

## Open questions

- `mapping-set-importer.ts` records an unresolved ref as an entry-level error
  and continues, so a broken ref is visible only in the import result. Three
  PRE-EXISTING sets carry them today — `ISO27001-2022→ISO27701-2019` (8),
  `ISO27701-2019→GDPR` (2), `ISO27001-2022→NIST-CSF-2.0` (1). All eight new
  sets import with zero. The `no dangling refs` invariant in the new unit test
  is scoped to the agentic sets; widening it to the whole directory would turn
  CI red on day one, which is a separate fix with a separate diff.

- `performGapAnalysis` filters `frameworkRequirement` on `{ assessable: true }`,
  but `FrameworkRequirement` has no `assessable` column — the flag lives only in
  the YAML and the importer uses it to decide which nodes to persist. That
  filter cannot succeed at runtime. Not touched here (the per-agent query does
  its own read and does not go through `performGapAnalysis`), but it means the
  product-facing gap-analysis usecase is untested against a real database.

- Neither `prisma/seed.ts` nor `scripts/backfill-framework-catalog.mjs` imports
  mapping sets, so a seeded database has framework rows and no edges until
  `syncAllLibraries` runs. Stage 1 raised the same question for the frameworks
  themselves; the family resolution added here means a later `syncAllLibraries`
  on a seeded production database now DOES light up inherited coverage for
  controls that hang off the seeded rows, which was the blocker.
