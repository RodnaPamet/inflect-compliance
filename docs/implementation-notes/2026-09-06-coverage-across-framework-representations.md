# 2026-09-06 — Coverage and gap analysis across the two framework representations

**Commit:** _(stamped post-commit)_

Every framework in this repo can exist TWICE in `Framework`: the row
`prisma/seed.ts` writes and the row `library-importer.ts` writes from
`src/data/libraries/`. Their `key` values must differ — `Framework.key` is
`@unique` — and a tenant's `ControlRequirementLink` rows hang off whichever one
its database happened to get.

`src/app-layer/domain/framework-representation.ts` reconciles the two on both
axes (`frameworkFamilyId` for identity, `canonicalRequirementCode` /
`requirementCodeSpellings` for the requirement code). Two OLDER consumers were
never routed through it and had zero mentions of either half:

- `src/app-layer/usecases/framework/coverage.ts`
- `src/app-layer/services/cross-framework-traceability.ts`

For a tenant whose ISO 27001 came from one representation while the mappings
reference the other, the two sides never met. The failure is a WRONG NUMBER,
not an error: a control that IS mapped reads as a gap, which is
indistinguishable from a customer who has done no work.

## Design

### coverage.ts — expand the numerator, never the denominator

`resolveFamilyRequirementAliases(db, fw, requirements)` returns

- `lookupIds` — every requirement id a tenant link could legitimately name:
  this framework's rows plus every sibling representation's;
- `toOwnRequirementId` — any family requirement id → THIS framework's row for
  the same obligation, joined on `(family, canonicalRequirementCode)`.

`computeCoverage` and `generateReadinessReport` widen their link query to
`lookupIds` and then re-point each returned link through the alias map. Every
line below that point is untouched: `mappedReqIds`, `bySection`,
`rollUpRequirementVerdict`, `readinessScore` all keep reading a link that names
one of this framework's own requirements.

**The denominator deliberately does not move.** A sibling representation can
carry obligations the requested framework does not declare; folding those into
`total` would inflate the report with requirements nobody asked about. Only
which requirements count as MAPPED expands. `tests/integration/framework-representation-coverage.test.ts`
pins `total === 2` against a 4-row family for exactly this reason.

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

`usecases/gap-analysis.ts` is the only caller and now loads the registry.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/framework/coverage.ts` | family alias map; both link queries widened and re-pointed |
| `src/app-layer/services/cross-framework-traceability.ts` | `FrameworkIdentityRegistry`, `frameworkFamilyKeys`, family + obligation matching |
| `src/app-layer/usecases/gap-analysis.ts` | loads the registry and passes it through |
| `tests/integration/framework-representation-coverage.test.ts` | the behavioural test, two families, real DB |

## Decisions

- **Two families in the fixture, not one.** A single-representation fixture
  passes before and after the fix. One two-representation family cannot
  separate the two axes either. So ISO 27001 (seed row with NO `sourceUrn`,
  Annex A spelled `5.15` vs `A.5.15`, clause `7` spelled identically in both)
  isolates identity from spelling inside one family, and SOC 2 (both rows carry
  `sourceUrn`, one spelling) proves the urn path needs no legacy key. Emptying
  `LEGACY_KEY_FAMILY_URNS` reddens the two ISO 27001 assertions and leaves SOC 2
  green; neutering `canonicalRequirementCode` reddens ONLY the Annex A one.
- **`requirementCodeSpellings` is not used by either consumer.** It is the
  query-side twin — "ask the database for every spelling of this named code".
  Both consumers here load a whole framework rather than named codes, so the
  in-memory `canonicalRequirementCode` is the correct half. Using the other
  would have been a wider query for the same answer.
- **The source side of gap analysis is NOT expanded.** `performGapAnalysis`
  still traverses from the requested source framework's own requirement rows,
  so a mapping set authored against the other representation of the SOURCE is
  still unreachable. That is a distinct defect in a third file, and
  `performGapAnalysis` has no production caller today — it also filters on
  `FrameworkRequirement.assessable`, a column the schema does not have, so its
  default path is a Prisma validation error against a real database. Both are
  left alone and recorded here rather than fixed silently.
