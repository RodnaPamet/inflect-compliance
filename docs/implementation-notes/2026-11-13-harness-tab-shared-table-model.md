# 2026-11-13 — The harness tab reads the shared table model

**Commit:** `feat(agents): the harness tab builds its rows from the shared table model`

## Design

Owner decision, 2026-11-13: one shared table model. scanent's contract package
(0.15.0) ships `@rodnapamet/scanent-contract/harness-matrix-model`, a pure,
browser-safe module: `buildHarnessMatrix(input)` turns one scan into rows of
cells, a judgement, a level, a bar and a bar standing, and
`compareHarnessMatrixRows` orders them. scanent's local results are built from
it. Until now the harness tab on `/agents/reports?tab=harness` kept its own
four-state cells (`criterionState` in `MatrixCell`) and its own order
(`compareMatrixRows`: rung first, then below the bar).

The tab now builds its rows from the model:

```
latest scan items (whole scan)      ── verdicts re-read (null = unreadable),
  + scan sources (null = unreadable)    discoveredVia, reach, stored level
        │
        ▼
buildHarnessMatrix (ranking pass, no class, no register link)
        │  compareHarnessMatrixRows → first MATRIX_ROW_CAP ids
        ▼
heavy read of the displayed rows only (tools, models, register, lastLevel)
findings on record → class (unregisteredIdentitiesOnRecord)
        │
        ▼
buildHarnessMatrix (displayed agents, register link + class + model signs)
        │  each model row joined by discoveredId to Inflect's own columns
        ▼
MatrixRow { matrix: HarnessMatrixRow, registered, models,
            latestIngestedLevel, acceptance, acceptAffordance }
```

The model is given no `readers` and no `declared` verdicts: which readers a
scanner ran is not stored, and Inflect has no inventory. So of the seven cell
states only EVIDENCED, MET_UNEVIDENCED, NOT_MET and UNANSWERED occur, and no
coverage is stated. `MatrixCell` is still keyed on all seven through a
`Record<HarnessMatrixCellState, StatusBadgeVariant>`, so a state the model adds
fails `tsc` rather than rendering as nothing.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/agent-harness-matrix.ts` | Builds each section's rows with `buildHarnessMatrix`; ranks the whole latest scan with `compareHarnessMatrixRows` |
| `src/lib/agentic/harness-read-model.ts` | `MatrixRow` carries the model's row plus Inflect's columns; `compareMatrixRows` removed |
| `src/app/t/[tenantSlug]/(app)/agents/reports/harness/MatrixCell.tsx` | Renders the model's cell state; exhaustive over the seven |
| `src/app/t/[tenantSlug]/(app)/agents/reports/harness/MatrixGrid.tsx` | Renders NOT JUDGED with its reasons; badges from the model's class; bar from `heldToBar` / `countsAsShortfall` |
| `src/app/t/[tenantSlug]/(app)/agents/reports/harness/HarnessTab.tsx` | Label from the model row's `discoveredId` |
| `messages/en.json`, `messages/bg.json` | Three new cell states; `harness.notJudged.*` replaces `harness.verdictsUnreadable` |
| `tests/helpers/harness-matrix-row.ts` | Rendered fixtures built through the model, never by hand |
| `docs/user/guide/manage/agent-reports.md` | The new order and the "Not judged" badge |

## Decisions

- **The rows are chosen from the whole scan by the model's order.** "Not
  judged" sorts first, and whether an agent is judged depends on whether its
  stored verdicts re-read, so the latest scans' items are now read with their
  verdicts and `discoveredVia` (the previous scans' read, which only drift
  needs, stays light). This makes the latest-scan read heavier; it is still the
  same bounded read (`ITEM_CAP`, one past it), and a scan holds at most
  `MAX_AGENTS`. The alternative, ranking by the stored level and discovering
  unreadable verdicts only for the displayed rows, would let a not-judged agent
  fall outside the row cap, which breaks "rows are the worst of a WHOLE latest
  scan".
- **Two builds, one order.** The ranking pass supplies no class and no register
  link, because the comparator reads only the judgement, the level and
  `barStatus`. The displayed rows are built again with both, in the ranked
  order; the model keeps the order it is given and neither input moves a row
  in it, so no re-sort follows. The class is still read only for the rows
  shown, as before.
- **The class is supplied, never derived.** The model's
  `unregisteredIdentity` input is the class on record
  (`unregisteredIdentitiesOnRecord`), as every reader of the record asks it.
  An unregistered identity is held to no bar: `heldToBar` and
  `countsAsShortfall` are false, so it is never shown below one, while
  `barStatus` still places it among the agents below the bar in the order.
- **What Inflect does not store is passed as unknown.** `linkBasis` is `null`
  (Inflect does not record whether a report claim or an intake linked the row)
  and `paymentCapabilities` is `null` (NOT REPORTED). Model signs are the
  planner's `modelSignsOf` over the stored tools and models; a column that does
  not re-read contributes no sign. The tab renders none of the three.
- **Unreadable stored JSON is the model's reason, not a separate flag.**
  `verdictsUnreadable` is gone: such a row is NOT JUDGED with
  `VERDICTS_UNREADABLE`, every cell UNANSWERED. Stored sources that do not
  re-read make every agent of the scan NOT JUDGED (`SOURCES_UNREADABLE`).
  Before, those agents showed the stored level beside an "incomplete scan"
  notice.
- **Reasons are shown as sentences with the code beside them**, the words
  scanent's page uses, so an unfamiliar code is stated rather than dropped. A
  judged row's caveats (`OTHER_SOURCE_INCOMPLETE:<kind>`) are shown under its
  level.
- **Unchanged:** drift still compares the stored levels of two scans; the
  accept affordance still follows `DiscoveredAgent.lastLevel`, because that is
  what `acceptHarnessShortfall` reads; the evidence emitter's tallies are not
  part of this change.
