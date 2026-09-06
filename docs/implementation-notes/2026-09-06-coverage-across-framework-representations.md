# 2026-09-06 — Coverage, SoA, tree and gap analysis across the two framework representations

**Commit:** _(stamped post-commit)_

Every framework in this repo can exist TWICE in `Framework`: the row
`prisma/seed.ts` writes and the row `library-importer.ts` writes from
`src/data/libraries/`. Their `key` values must differ — `Framework.key` is
`@unique` — and a tenant's `ControlRequirementLink` rows hang off whichever one
its database happened to get.

`src/app-layer/domain/framework-representation.ts` reconciles the two on both
axes (`frameworkFamilyId` for identity, `canonicalRequirementCode` /
`requirementCodeSpellings` for the requirement code). The older consumers were
never routed through it.

For a tenant whose ISO 27001 came from one representation while the mappings
reference the other, the two sides never met. The failure is a WRONG NUMBER,
not an error: a control that IS mapped reads as a gap, which is
indistinguishable from a customer who has done no work.

## Design

### One seam, four surfaces — because a partial fix is worse than none

FOUR usecases answer "which of this framework's requirements does this tenant
cover?" off the same `ControlRequirementLink` rows, and a person reads them
beside each other:

| Surface | Where it shows up |
| --- | --- |
| `computeCoverage` | Frameworks list page, framework JSON + CSV export, MCP tools |
| `generateReadinessReport` | readiness report and its export |
| `getSoA` | the Statement of Applicability and its export |
| `getFrameworkTree` | the per-requirement compliance decoration in the explorer |

The first draft of this change taught the first two and left the other two on
the un-collapsed join. That is strictly worse than fixing none: coverage then
reports 100% beside an SoA reporting every requirement unmapped, for one tenant
at one moment, and neither surface says why. So the reconciliation moved into
`src/app-layer/services/framework-representation-aliases.ts` and all four call
it. A fifth surface that joins on `requirementId` alone belongs there too.

`resolveFamilyRequirementAliases(db, fw, requirements)` returns

- `lookupIds` — every requirement id a tenant link could legitimately name:
  this framework's rows plus every sibling representation's;
- `toOwnRequirementId` — any family requirement id → THIS framework's row for
  the same obligation, joined on `(family, canonicalRequirementCode)`.

`collapseLinksToOwnRequirements(links, aliases)` then re-points each link and
returns at most ONE per `(requirement, control)`. Every line downstream is
untouched: `mappedReqIds`, `bySection`, `rollUpRequirementVerdict`,
`readinessScore`, the SoA's per-requirement rollup and the tree's compliance
decorator all keep reading links that name this framework's own requirements,
one per control, exactly as `@@unique([controlId, requirementId])` used to
guarantee on its own.

**The dedupe is required by the collapse, not defensive tidying.** A control
linked to BOTH representations of one obligation is the only way that
uniqueness assumption breaks, and it breaks visibly: two identical
`controlMappings` entries and two identical rows in the coverage CSV, and —
because `ControlRequirementLink.applicability` is a PER-FRAMEWORK override that
the SoA and the readiness rollup both resolve — a control scoped OUT of this
framework counting as applicable anyway, because the sibling link says
otherwise. (`getFrameworkTree` reads `Control.applicability`, the global
column, so a duplicate cannot change its verdict today; the dedupe is what
keeps that true rather than something that surface relies on.) The tie-break
keeps the link written
against the requested framework's OWN row, because
`ControlRequirementLink.applicability` is a per-framework override and that is
the row naming the framework the caller asked about; between two sibling links
the lower requirement id wins — arbitrary in meaning, but stable, so a tenant
cannot get two answers from two query plans.

**The denominator deliberately does not move.** A sibling representation can
carry obligations the requested framework does not declare; folding those into
`total` would inflate the report with requirements nobody asked about. Only
which requirements count as MAPPED expands.

The catalogue read is skipped when `frameworkFamilyId(fw)` is `key:<fw.key>`.
That is not an optimisation traded against correctness: `Framework.key` is
`@unique`, so a family id of that shape can only ever name the row it came
from, and the query would have a provably empty answer. It is also why every
existing mocked unit test still passes with no new mock.

### cross-framework-traceability.ts — a framework identity registry

The service is pure and sees only framework KEYS, but only a row's own
`sourceUrn` can identify a library key as a second representation. So the
caller supplies `FrameworkIdentityRegistry` (`key → sourceUrn`) and the service
resolves families through it. Absent, it degrades to what
`LEGACY_KEY_FAMILY_URNS` alone can resolve — strictly better than key equality,
and every existing call site compiles unchanged.

Three comparisons changed:

1. `buildTraceabilityReport` filters paths by family, not key.
2. `analyzeGaps` filters paths by family, and keys `targetCoverage` by the
   target obligation (`canonicalRequirementCode`) rather than by
   `path.target.requirementId` — a mapping authored against the library
   representation lands on ITS rows, which carry different ids.
3. Both hand `frameworkFamilyKeys(...)` to `resolveMapping`. The BFS in
   `mapping-resolution.ts` filters candidate paths by target framework KEY, so
   passing one representation's key discards the paths that reach the other
   before the service can look at them. Fixing (1) and (2) without (3) delivers
   nothing.

`usecases/gap-analysis.ts` is the only caller and now loads the registry — in
BOTH of its entry points. `getRequirementTraceability` and
`performGapAnalysis` build their own target-key list and call the service
separately, so each needed its own behavioural test: reverting one leaves the
other's tests green.

### SOC 2 was a second instance of the same defect

`prisma/seed.ts` writes `sourceUrn` on its ISO 27001 row and wrote none at all
on `SOC2`, while the library ships `soc2-2017.yaml` whose importer creates
`SOC2-2017` carrying `urn:inflect:library:soc2-2017`. Three shipped mapping
sets target `SOC2-2017` (from ISO 27001, NIST CSF and the SSDF) and reached
nothing a seeded tenant held.

Two changes, and both are needed: the seed now writes the urn (so a fresh
database ties itself), and `SOC2` joins `LEGACY_KEY_FAMILY_URNS` (so an
existing database, which is never re-seeded, ties too). The entry ASSERTS that
two `Framework` rows describe one framework, so
`tests/unit/framework-representation.test.ts` recomputes the comparison from
the shipped YAML and the seed's own `soc2Reqs` literal: every seeded criterion
appears verbatim in the library, so the identity axis is the only one that
differs and no code rule is needed. A library revision that renumbers the
criteria turns that red rather than joining silently.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/services/framework-representation-aliases.ts` | NEW — the shared seam: alias resolution + the re-point/dedupe collapse |
| `src/app-layer/usecases/framework/coverage.ts` | `computeCoverage` + `generateReadinessReport` routed through the seam |
| `src/app-layer/usecases/soa.ts` | `getSoA` routed through the seam |
| `src/app-layer/usecases/framework/tree.ts` | `getFrameworkTree` routed through the seam (selects `control.id` for the dedupe key) |
| `src/app-layer/services/cross-framework-traceability.ts` | `FrameworkIdentityRegistry`, `frameworkFamilyKeys`, family + obligation matching |
| `src/app-layer/usecases/gap-analysis.ts` | loads the registry and passes it through both entry points |
| `src/app-layer/domain/framework-representation.ts` | `SOC2_FAMILY_URN` + the second legacy-key entry |
| `prisma/seed.ts` | writes `sourceUrn` on the `SOC2` framework row |
| `tests/integration/framework-representation-coverage.test.ts` | the behavioural test: three families, four surfaces, real DB |
| `tests/unit/framework-representation-aliases.test.ts` | the collapse's tie-break and the read the resolver declines to make |
| `tests/unit/cross-framework-traceability.test.ts` | `buildTraceabilityReport` / `frameworkFamilyKeys` family matching |
| `tests/unit/framework-representation.test.ts` | the SOC 2 code comparison, recomputed from the shipped data |

## Decisions

- **Three families in the fixture, not one.** A single-representation fixture
  passes before and after the fix. One two-representation family cannot
  separate the axes either. So: ISO 27001 (seeded row with NO `sourceUrn`,
  Annex A spelled `5.15` vs `A.5.15`, clauses `7` and `8` spelled identically)
  isolates identity from spelling inside one family; SOC 2 (seeded row with no
  urn, one spelling) is the identity axis with nothing to hide behind; ISO
  42001 (urn on BOTH rows, and clause `8.2` beside Annex `A.8.2` as different
  obligations) proves the urn path needs no legacy key AND that the `A.` strip
  stays family-scoped.
- **What each mutation leaves GREEN is the load-bearing half**, and the numbers
  in the test file's header are measured against that file rather than asserted
  from the design. Emptying `LEGACY_KEY_FAMILY_URNS` leaves both ISO 42001
  assertions green. Neutering `canonicalRequirementCode` leaves the clause `7`
  assertion green — that one, and only that one, separates identity from
  spelling; it does NOT redden only the Annex A assertion, because every ISO
  27001 total counts the same requirement. A family-blind `A.` strip reddens
  only the two ISO 42001 assertions.
- **What was deliberately NOT routed through the seam, having been enumerated
  rather than assumed.** `grep`ping every `controlRequirementLink.findMany` in
  `src/app-layer` turns up two more shapes, and neither is a live
  contradiction. `FrameworkRepository.getCoverage` is the same question in the
  same vocabulary (`total` / `mappedCount` / `unmapped`) and its own comment
  claims it "matches SoA/readiness" — but it has NO caller in `src/`, only an
  integration test, so it reaches no user; a future caller must route it here
  first. `compliance-posture.ts` and `test-readiness.ts` aggregate ACROSS
  frameworks and report one row per `Framework` row, which is a different
  question: collapsing families there means de-duplicating the LIST, not the
  join, and is its own design.
- **The framework tree still reads `Control.applicability`, not the
  per-framework link override.** So a control scoped out of one framework reads
  N/A on the SoA and `compliant` in the tree. That divergence predates this
  change and is reachable with a single representation — any tenant using the
  override sees it — so it is pinned as measured behaviour in the integration
  test and left for its own fix rather than silently widened into this one.
- **`requirementCodeSpellings` is not used by any consumer here.** It is the
  query-side twin — "ask the database for every spelling of this named code".
  These consumers load a whole framework rather than named codes, so the
  in-memory `canonicalRequirementCode` is the correct half. Using the other
  would have been a wider query for the same answer.
- **The source side of gap analysis is NOT expanded.** `performGapAnalysis`
  still traverses from the requested source framework's own requirement rows,
  so a mapping set authored against the other representation of the SOURCE is
  still unreachable. That is a distinct defect in a third file, and
  `performGapAnalysis` has no production caller today (nor does
  `getRequirementTraceability`) — it also filters on
  `FrameworkRequirement.assessable`, a column the schema does not have, so its
  default path is a Prisma validation error against a real database. Both are
  left alone and recorded here rather than fixed silently.
