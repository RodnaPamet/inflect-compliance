# 2026-09-05 — the ISO 27001 → OWASP ASI route was inert on every seeded database

**Commit:** `ee3577d7c` fix(frameworks): make the ISMS-side agentic route reach the seeded ISO 27001 representation

## What was broken

`iso27001-to-owasp-agentic.yaml` shipped with 39 curated edges and zero
unresolved refs, and delivered **nothing** to any tenant that got ISO 27001
through the product's own seed. Built as a real fixture — the shape
`prisma/seed.ts` writes, six IMPLEMENTED controls on the map's own ASI03
sources, an agent scoped to all ten risks — the readout was ten
`NOT_COVERED`, `coveragePercent` 0, `ASI03.inheritedFrom.length === 0`.

That is the bad failure mode rather than the loud one. The PR's headline
commercial claim is that an existing ISMS shows partial agentic coverage
immediately instead of starting at zero, and the stage-2 rationale for
carrying ISO 27001 at all is that it is the ONLY edge into an agentic
framework from the ISMS side of the mapping graph. An inert route makes that
claim quietly untrue for the largest population of tenants, and a tenant that
had done the work looked identical to one that had done none.

## Two causes, independent, neither sufficient alone

Every framework in this repo can exist twice in `Framework`: the seed row and
the YAML-library row. Reconciling them takes agreement on two axes, and ISO
27001 disagreed on both.

| axis | seeded row | library row | consequence |
| --- | --- | --- | --- |
| framework identity | `key: ISO27001`, `sourceUrn: null` | `key: ISO27001-2022`, `sourceUrn: urn:inflect:library:iso27001-2022` | `familyOf()` returned `key:ISO27001` vs the urn — the family never collapsed |
| requirement code | Annex A numbered `5.15` (93 rows, `prisma/fixtures/iso27001_2022_annexA.json`) | Annex A numbered `A.5.15` (29 of them) | the sibling lookup matches on `code`; a code-equality join reaches nothing |

The first cause was missed because ISO 42001 *does* carry a `sourceUrn`
(the `ISO42001` upsert in `prisma/seed.ts`), and the stage-2 report generalised from it to "both
representations already carry it". The second was invisible from either file
alone: both sides look internally consistent.

## The fix

`src/app-layer/domain/framework-representation.ts` now owns both halves.

- **Identity.** `frameworkFamilyId()` reads `sourceUrn`, then
  `LEGACY_KEY_FAMILY_URNS` (one entry: `ISO27001`), then degrades to
  `key:<key>` — a missing join rather than a wrong one. `prisma/seed.ts` also
  writes the urn now, but the fallback is the load-bearing half: an existing
  database is not re-seeded on deploy, so a seed-only fix would have left every
  tenant provisioned before today reading zero.
- **Code namespace.** `canonicalRequirementCode()` / `requirementCodeSpellings()`
  reconcile `A.5.15` with `5.15`. `loadInheritedCoverage` asks the database for
  every spelling and buckets siblings by the canonical one.

## Why the `A.` strip is scoped to one family

It looks like a formatting difference and is not. Inside ISO/IEC 42001:2023
**both** representations carry clause `8.2` (AI risk assessment) *and* Annex
control `A.8.2` (system documentation) — different obligations, both present in
both representations. A blanket strip merges them and would inflate inherited
coverage on a route that works today; measured against the shipped library, it
merges 30 distinct ISO 42001 codes into 15 (`8.2`+`A.8.2`, `4.2`+`A.4.2`, …).

ISO 27001 is safe for a reason that belongs to its data, not to the rule: its
library carries clauses `4`…`10` with no sub-clauses, so no clause code has the
`<n>.<n>` shape the strip produces. `tests/unit/framework-representation.test.ts`
recomputes that collision check from the shipped YAML and fixtures, so a library
revision that later adds clause `5.1` turns red instead of joining silently.

## Why not the other two candidates

- **Author the mapping against the seeded codes.** The importer resolves
  `source_framework_ref` against `Framework.key`, which is the *library* key, so
  seeded refs would resolve on a seeded database and fail on a library-only one
  — moving the inert case rather than removing it. It would also diverge from
  the eight pre-existing `ISO27001-2022` mapping files, all of which use `A.`.
- **Withdraw the ISO 27001 edge.** Only justifiable if the route could not be
  made to work. It can, in ~40 lines.

## Per-edge sweep — the same class, checked everywhere

Every mapping file this PR adds, resolved against BOTH shapes (source refs vs
the seed fixture and the library YAML):

| mapping set | source resolves (lib / seed) | target resolves (lib / seed) | live? |
| --- | --- | --- | --- |
| `imda-mgf-to-iso-42001` | 19/19 · 19/19 | 34/34 · 34/34 | yes |
| `imda-mgf-to-owasp-agentic` | 16/16 · 16/16 | 10/10 · 10/10 | yes |
| `iso-42001-to-imda-mgf` | 34/34 · 34/34 | 19/19 · 19/19 | yes |
| `iso-42001-to-owasp-agentic` | 26/26 · 26/26 | 10/10 · 10/10 | yes |
| `iso27001-to-owasp-agentic` | 27/27 · **0/27** | 10/10 · 10/10 | **was inert — fixed** |
| `owasp-agentic-to-imda-mgf` | 10/10 · 10/10 | 16/16 · 16/16 | yes |
| `owasp-agentic-to-iso-42001` | 10/10 · 10/10 | 26/26 · 26/26 | yes |
| `owasp-agentic-to-iso27001` | 10/10 · 10/10 | 27/27 · **0/27** | target side only — see below |

ISO 27001 is the only framework in the set whose two representations disagree,
and it is the only one where the seeded row lacked a `sourceUrn`. IMDA MGF and
OWASP ASI were authored in this PR against fixture and library at once; ISO
42001's seed fixture already used the library's `A.n.n` spelling.

`owasp-agentic-to-iso27001` has ISO 27001 on the TARGET side, which
`computeAgentRiskCoverage` never walks (it loads edges *into* the ten agentic
requirements). It is fixed by the same change wherever a reader does collapse
families — and today no other reader does.

## Known adjacent surface, deliberately not touched

`usecases/framework/coverage.ts` and `services/cross-framework-traceability.ts`
do **no** family collapse at all — neither mentions `sourceUrn`. So a seeded
ISO 27001 tenant's *gap analysis* against SOC 2, NIST CSF and ISO 27701 has the
same shape of hole this note fixes for agentic coverage. That is pre-existing,
wider than this PR, and wants its own evidence before anyone changes it.

## Files

| file | role |
| --- | --- |
| `src/app-layer/domain/framework-representation.ts` | new — family id + code-spelling reconciliation, with the ISO 42001 collision reasoning |
| `src/app-layer/usecases/agent-coverage.ts` | asks for every spelling; buckets siblings and route keys by the canonical code |
| `prisma/seed.ts` | seeded ISO 27001 carries `sourceUrn` |
| `tests/unit/framework-representation.test.ts` | pure functions + the data-driven collision/reachability check |
| `tests/integration/agent-coverage-analysis.test.ts` | tenant F — the seeded ISO 27001 shape, both deployment states |

## Decisions

- **The integration fixture builds the LEGACY shape (`sourceUrn: null`)**,
  because that is what deployed databases hold and it is the strictly stronger
  of the two. A fourth test flips the urn on and asserts the report is
  identical, so both states are covered without needing two `ISO27001` rows —
  `Framework.key` is `@unique`.
- **Tenant F holds six controls on the map's own ASI03 sources, four of them
  `SUBSET`.** Chosen so the assertion can name every route in order and prove
  the strongest-first sort, rather than asserting a count.
- **`LEGACY_KEY_FAMILY_URNS` has exactly one entry, pinned by a test.** `SOC2`,
  `NIS2` and `DORA` also lack a `sourceUrn` and also have libraries, but their
  code namespaces have not been compared. An entry here asserts two rows are
  one framework; adding one on the strength of a plausible name is how the
  wrong join gets in.
- **The mutation proof was run per cause.** Removing the legacy-key fallback
  alone fails 3 of tenant F's tests; removing the code canonicalisation alone
  fails 2. In both runs every other tenant in the file stays green, so the new
  assertions are the sole detector rather than passengers on a broad break.
