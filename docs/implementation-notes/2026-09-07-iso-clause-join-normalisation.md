# 2026-09-07 — One ISO clause, three spellings, two dead joins

**Commit:** `(this commit)` fix(mapping): normalise ISO clause identifiers so the readiness join resolves

## The defect

An ISO 27001 Annex A clause is written three different ways in this codebase,
and nothing reconciled them:

| where | spelling | example |
|---|---|---|
| `FrameworkRequirement.code` | bare clause | `5.1` |
| `ControlTemplate.code`, and so `Control.code` | hyphenated | `A-5.1` |
| `src/data/frameworks.ts` guidance table | dotted | `A.5.1` |

Two joins compared two of these directly, and so matched nothing.

**1. `usecases/mapping.ts` — production, user-visible.** The SOC 2 and NIS2
readiness folds matched `m.isoControlId === c.annexId`, i.e. `'A.5.1'` against
`Control.annexId`. Nothing populates `annexId` on a control installed from a
framework catalogue — `template-projection.ts` writes `code` and never
`annexId` — so the join matched only controls a user had created by hand and
typed an annexId into. For every tenant whose controls came from the
catalogue, which is all of them, `/mapping` reported `controlCount: 0` and
`coverage: 0%` against every SOC 2 requirement and every NIS2 area.

**2. `prisma/seed.ts` — dev and E2E only.** `annexMap` was keyed by
requirement code (`5.1`) and looked up with `ctrl.annexId` (`A.5.1`), so
`ControlRequirementLink` had zero rows in a fresh dev database. This one was
already known: a note in place recorded it as a no-op and deliberately left it
for a separate change, so as not to mix a behaviour change into a delivery
proof. This is that separate change.

## Why the test suite did not catch it

`tests/unit/mapping-usecase.test.ts` covered the fold thoroughly — join,
counting, evidence qualification, division-by-zero — and passed throughout.
Every one of its cases builds controls carrying `annexId: 'A.5.1'`.

That is not a shape production creates. The test proved the fold works for
hand-created controls, and there was nothing to notice, because a control's
`annexId` being null is not an error state — it reads exactly like a control
that legitimately matches no requirement.

## Design

`parseIsoClause` in `src/lib/controls/control-taxonomy.ts` already accepted all
three forms and returned the bare clause. It was already used this way by
`categorizeControl`, which resolves `annexId` first and falls back to `code`.
Both join sites now do the same thing, so no second normaliser was introduced.

## Decisions

- **`annexId` keeps priority over `code`**, mirroring `categorizeControl`. The
  fix must not trade the hand-created population for the catalogue one, and a
  test asserts the hand-created shape still joins.

- **A non-ISO code must not collide.** `parseIsoClause('CC5.1')` returns null
  rather than `5.1`, so a SOC 2 control code cannot be mistaken for Annex A
  clause 5.1. Asserted directly.

- **The seed fix creates rows that have never existed.** E2E coverage-metrics
  specs have always taken a "not installed" skip branch. They will now execute
  against real `ControlRequirementLink` rows for the first time.

## Files

| file | role |
|---|---|
| `src/app-layer/usecases/mapping.ts` | `controlIsoClause` helper; both readiness folds normalise before comparing |
| `prisma/seed.ts` | coverage-link block keys and looks up by bare clause |
| `tests/unit/mapping-usecase.test.ts` | four cases on the catalogue-shaped control; two fail without the fix |
