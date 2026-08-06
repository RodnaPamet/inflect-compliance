# 2026-08-06 — Behavioural cover for the risk paths the ratchets only grepped

**Commit:** _(see branch `test/risk-behavioural-coverage`)_

Second tranche of the Box 3 work. #1797 established the rule and put the `rq*`
family on a downward ratchet; this replaces four sets of source-text
assertions with tests that execute the code, and lowers the ceiling 39 → 37.

## Design

The through-line: **a grep proves a line is spelled; only running the code
proves it does the thing.** Each item below picks the specific wrong answer
the old assertion could not distinguish from the right one.

### `bulkDeleteRisk` — the destructive cross-tenant path

The highest-severity gap. A multi-tenant destructive bulk operation whose only
cover was a structural grep for a tenant filter. The three bulk usecases do
not even guard themselves the same way:

- `bulkDeleteRisk` narrows to `rows.map(r => r.id)` — ids that survived the
  tenant-scoped read — before deleting.
- `bulkSetRiskStatus` / `bulkAssignRisk` pass the **caller's raw id array**
  straight to `RiskRepository.bulkUpdate`, relying on that method's own
  `tenantId` predicate.

The second shape is safe *today* only because `bulkUpdate` filters. Nothing
said so, and nothing would have noticed if a refactor moved that predicate.
Every test now asserts the **foreign tenant's row afterwards**, because
asserting that the call threw, or that the count was right, would pass for an
implementation that deleted the foreign row and then reported honestly.

**What the test measures was verified, not assumed.** Dropping the `tenantId`
predicate from `bulkDeleteRisk` makes the first test fail — the foreign risk
comes back with a non-null `deletedAt`. So in this harness the application
filter is load-bearing and RLS is not silently covering for it (the test
connection owns the tables, so `superuser_bypass` applies). A test that passed
only because of RLS would be measuring the database, not this code.

### `computeVelocity` — the orchestrator nobody executed

`velocityOf` and `classifyTrend` were unit-tested; the orchestrator around
them had never run. The deleted `rq9-trending.test.ts` regex-matched 41
fragments of risk source. It could see that a `.sort(` existed. It could not
see whether:

- the ranking orders by **percentage** or absolute delta (a `+900%` move on a
  small risk must outrank `+20%` on a large one);
- the snapshot join picks the **nearest earlier** row or the oldest;
- a snapshot *inside* the window counts as "previous" (it must not);
- a risk with **no prior snapshot** is excluded, rather than treated as rising
  from zero — which would make every newly-created risk an infinite riser and
  flood the widget.

Each is a distinct way for the dashboard to mislead, and each is now asserted.

### `getRiskPrivacyLens`

`Risk.linddunCategories` is a nullable `Json?`, so it arrives as anything:
null, `{}`, a bare string, an array with junk, duplicates, wrong order. A
guard asserting `risk.ts` contains the string `petTreatmentHints` sees none of
that. The unit test pins canonical ordering, unknown codes dropped,
de-duplication, and the honest-empty contract — an unclassified risk gets **no**
hints, rather than the full catalogue, which would read as advice the tool
never gave.

## Where the roadmap's premise didn't hold

Two items were checked before executing, and both needed adjusting:

**`bulk-delete-coverage.test.ts` — risk rows kept.** The instruction was to
delete them as superseded. They are not: that guard is a **set-completeness**
check across 8 entities, answering "does every selectable entity have a bulk
delete?" — a question no per-entity test can answer, because the failure it
catches is a *new* entity shipping without one. Removing the risk row would
have left it asserting 7 entities beside a sibling test asserting 8 routes,
punching a hole in the set to satisfy a rule aimed at a different class of
guard. Annotated instead, and the other seven entities are flagged as owing
the same behavioural depth.

**`rq2-9-matrix-movement` — redundant, but not entirely.** The instruction was
to verify then delete. `tests/rendered/risk-matrix-movement.test.tsx` does
cover the overlay (zero-cost gate, dedupe, same-cell skip, geometry, titles,
pointer events), but the guard also held two rules the rendered test cannot
reach, because it takes movements as a *prop*:

1. the list row carries both decomposed residual dimensions — **rehomed** to
   `risks-list-owner-attach.test.ts`, asserted on the returned row rather than
   on the select's source text;
2. `matrixMovements` in `RisksClient` admits a risk only when both dimensions
   are non-null — a legacy row with just a rollup `residualScore` has no
   destination cell, so inventing one draws a false arrow.

(2) is **not covered by anything now**. It is logged as an explicit follow-up
rather than dropped quietly: either a `RisksClient` render test (the harness
already exists — `risk-modal-fields.test.tsx` renders it) or extraction of the
derivation into a pure helper during the Box 2 refactor.

## Files

| File | Role |
| --- | --- |
| `tests/integration/risk-bulk-ops.test.ts` | NEW — two-tenant behaviour for all three bulk usecases |
| `tests/integration/risk-velocity-orchestrator.test.ts` | NEW — `computeVelocity` end to end |
| `tests/unit/usecases/risk-privacy-lens.test.ts` | NEW — `getRiskPrivacyLens` over hostile stored shapes |
| `tests/integration/risks-list-owner-attach.test.ts` | Rehomes the residual-dimension list assertion |
| `tests/guards/rq9-trending.test.ts` | DELETED — 41 source refs, superseded |
| `tests/guards/rq2-9-matrix-movement.test.ts` | DELETED — see caveat above |
| `tests/guards/rq2-4-assessment-ia.test.ts` | Reduced to detail-page IA; panel assertions superseded by the rendered test |
| `tests/guardrails/linddun-privacy-lens-coverage.test.ts` | Positive half dropped; the whole-file negative stays |
| `tests/guardrails/bulk-delete-coverage.test.ts` | Scope note — set-completeness, not depth |
| `tests/guards/no-epic-named-ratchets.test.ts` | Ceiling 39 → 37 |

## Decisions

- **Deleting a guard means finding out what it was the only cover for.** Two
  of the four in this tranche turned out to hold something real. The
  five-minute check is the difference between retiring a ratchet and quietly
  losing an invariant.
- **The `linddun` negative assertion stays source-text on purpose.** "No write
  path turns an advisory PET hint into a created treatment" is a claim about
  the *whole file*. A behavioural test can show that the paths it calls don't;
  only a scan can show that none exists. That is the narrow case where a grep
  is the right tool.
- **`computeVelocity` is tested against snapshot ages relative to the cutoff**
  the usecase computes, not fixed dates, so it cannot rot or flake on
  wall-clock rounding.
- **`makeRequestContext` grants `canRead` to every role**, so a permission
  test that picks a weak role never reaches `assertCanRead`. Both new
  permission tests override the permission object explicitly; one of them
  additionally asserts no query was issued.
