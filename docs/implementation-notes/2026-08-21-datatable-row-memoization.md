# 2026-08-21 — DataTable body-row memoization (#101)

**Commit:** `<sha> perf(table): make the body-row memo actually bite`

## Design

`ResizableTableRow` — the only memoized row component in `table.tsx` — mounts
only when `enableColumnResizing && sizingFrozen`. Column resizing has been
default-off since 2026-06-04, so in practice **no production table had a
memoized row**: every `<tr>`, every `<td>`, both wrapper divs and every consumer
cell renderer re-ran on any ancestor re-render, across the whole accumulated row
set.

Windowing does not cover this case. `VIRTUALIZE_DEFAULT_THRESHOLD` is 1000, and
the Controls list pins `virtualize: false` as a documented Epic 68 contract — so
memoization is the only lever there.

Two halves:

1. **`TableBodyRow`** — the standard row extracted into a `memo()`'d component
   (written earlier on this branch, rebased here). Equality is React's DEFAULT
   shallow comparison, deliberately not a hand-written comparator: a bespoke
   comparator has to be re-audited on every new prop and renders **stale rows**
   when that audit is missed, which is materially worse than slow ones. The
   invariant is instead local and checkable — *everything the row body paints
   with arrives as a prop*. Every live-state read (`row.getIsSelected()`,
   `row.getIsExpanded()`, `row.getCanExpand()`, the row-count-derived last-row
   flags, the visible cells) is snapshotted at parent-render time.

2. **The one prop that was killing it.** Extraction alone left the memo inert —
   five rows still re-rendered 5 → 10 → 20 across three parent re-renders. The
   churning prop was `cells`.

   `row.getVisibleCells()` is TanStack-memoized on
   `[getLeftVisibleCells(), getCenterVisibleCells(), getRightVisibleCells()]`,
   and each of those is memoized on `table.getState().columnPinning.left` /
   `.right`, **compared by identity**. `useTable` spelled that state slice
   inline:

   ```ts
   state: { …, columnPinning: { left: [], right: [], ...columnPinning }, … }
   ```

   so `.left` was a fresh `[]` on every render, all three cell memos missed,
   `getVisibleCells()` returned a new array, and the row's shallow comparison
   saw a changed prop every single time. One `useMemo` around that object is the
   whole fix.

## The measurement

```bash
npx jest tests/rendered/data-table-row-memoization.test.tsx --maxWorkers=1 --forceExit
```

40 rows, one consumer cell renderer per row, counted across N ancestor
re-renders that leave the table's data untouched:

| scenario | consumer cell renders | distinct `getVisibleCells()` arrays |
| --- | --- | --- |
| before (branch as parked: row extracted, memo inert) | 3 bumps → **160**, 12 bumps → **520** | 4 |
| after (`columnPinningState` memo) | 3 bumps → **40**, 12 bumps → **40** | 1 |
| selecting one row | before **80**, after **41** | — |

Both mutations were run against the finished tree to confirm the test bites:
reverting the `columnPinning` memo fails 4 of 6; deleting `memo()` from
`TableBodyRow` fails 3 of 6 (the cells-identity assertion correctly survives —
it locks the root cause, not the memo).

## Files

| File | Role |
| --- | --- |
| `src/components/ui/table/table.tsx` | `TableBodyRow` (memoized standard row) + the `columnPinningState` memo that makes the cells prop stable |
| `src/components/ui/table/data-table.tsx` | Per-row prefetch handlers cached by row id, so wiring `onRowPrefetch` no longer hands every row a fresh `rowProps` object |
| `tests/rendered/data-table-row-memoization.test.tsx` | The measurement + the staleness guards |

## Decisions

- **No custom comparator.** See above — the asymmetry (stale rows across ~30
  list pages vs. slow rows) is why the default shallow compare stays.
- **`cells` is passed in rather than derived inside the row.** It is the single
  precise signal for every column-derived render input: rebuilt consumer
  `columns`, `columnVisibility`, and `columnPinning` all reach the memo through
  it. Deriving it inside the body would hide all three from the comparison.
- **Stable row-callback proxies, not the consumer's raw callbacks.** Most list
  pages rebuild `onRowClick` arrows on some renders; comparing that identity
  would drop the memo on every parent render. The proxy reads a ref refreshed in
  a layout effect, so the call always lands on the newest closure — a click
  cannot be dispatched before the commit that refreshed the ref.
- **Aligned sub-rows stay OUTSIDE the memo.** `renderAlignedSubRows` is a render
  closure the consumer rebuilds freely; freezing it behind a props comparison
  would paint stale sub-rows.
- **The test counts header renders alongside cell renders.** A flat cell count
  is ambiguous — it looks the same whether the memo worked or the table never
  re-rendered at all. Headers are deliberately not memoized, so a *growing*
  header count is the positive control that the table subtree really did render.
- **A separate test asserts `getVisibleCells()` identity directly.** That is the
  root-cause lock: it fails the moment the `columnPinningState` memo is reverted,
  independent of anything React does with bail-outs.
