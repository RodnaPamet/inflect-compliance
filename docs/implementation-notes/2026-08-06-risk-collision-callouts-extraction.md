# 2026-08-06 — Extracting the collision callouts (B3-5, second component)

**Commit:** _(see branch `test/risk-collision-callouts`)_

Second component out of `RisksClient`, after `RiskAleChip` (#1801). Same
motive: the drill-down contract could only be regex-matched while the markup
lived inline, and the regex could not observe the thing that matters.

## Design

`RQ3-5`'s range-compression callouts list the cell collisions the heatmap
flags — two risks sitting in the same matrix cell but priced an order of
magnitude apart — and clicking one drills into that cell.

The guard sliced a JSX byte window (`indexOf('risk-collision-callouts')` to
the literal `view === 'heatmap'`) and regexed inside it. #1797 replaced that
with a file-wide negative (`filterCtx.set('score'` appears nowhere), which was
a genuine improvement — but the **positive** half still could not be asserted
without clicking.

### Why cell-not-score is the whole point

A score is a **product** shared by many cells: `L1×I6` and `L2×I3` are both 6.
The callout's entire claim is "these two risks occupy the same box and are
priced 40× apart". Drilling by score would therefore show the user rows from
cells they never clicked on — in the one view whose premise is that the rows
share a box. The register would quietly contradict the callout that opened it.

`tests/rendered/risk-collision-callouts.test.tsx` clicks two colliding cells
that **share the score 6** and asserts they emit `L1xI6` and `L2xI3` — distinct
tokens. That is the assertion the byte window was reaching for and could never
make: source text can show that `filterCtx.set('cell', …)` is *written*, not
that clicking a given callout produces the token for *that* cell.

The component takes `onDrillToCell(cellToken)` rather than the filter context
itself, so the test observes the emitted token directly and the page keeps
ownership of what a drill-down does (set the filter, switch to the register).

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/risks/_shared/RiskCollisionCallouts.tsx` | NEW — extracted from `RisksClient` |
| `src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx` | Mounts it; ~30 lines of inline JSX gone |
| `tests/rendered/risk-collision-callouts.test.tsx` | NEW — the cell/score distinction, the empty case, keyboard reachability |
| `tests/guards/rq3-5-histograms.test.ts` | Byte-window slice replaced by a component-mount check; the file-wide negative stays |

## Decisions

- **The file-wide negative stays in the guard.** "Nothing *anywhere* in the
  register narrows by score" is a whole-file claim; a component test can only
  speak for the component it renders. This is the same split as the `linddun`
  guard — behavioural for what the code does, structural only for what no
  code path may do.
- **The empty case renders `null`, and that is tested.** Zero collisions is
  the healthy state, and an empty heading with an explanatory paragraph and no
  rows underneath would read as a broken widget.
- **The callouts stay `<button type="button">`.** Asserted explicitly, because
  the obvious "simplification" when extracting a clickable row is a `<div
  onClick>`, which silently drops keyboard and screen-reader access.
- **No ceiling change.** `rq3-5` is reduced, not deleted — it still holds the
  histogram assertions and the file-wide negative. The `rq` count stays 36.
