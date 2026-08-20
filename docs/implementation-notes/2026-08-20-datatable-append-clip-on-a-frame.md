# 2026-08-20 — DataTable whole-row clip: measure on a frame, not on the commit

**Commit:** `perf(table): stop the whole-row clip forcing layout on every append`

## Design

`<DataTable>` clamps its scroll wrapper to a whole multiple of the row
height so the bottom of the card never cuts a row in half. The
measurement that computes that clamp reads three layout properties back
to back:

```
firstRow.offsetHeight        → forces layout
allocAncestor.clientHeight   → forces layout
tbody.scrollHeight           → forces layout
```

and may then commit `maxScrollHeight` state.

That pass lived in a `useLayoutEffect` keyed on the **row count**. A
layout effect runs synchronously after commit and *before paint*, and
the row count is exactly what changes when load-on-scroll appends a
batch:

```
InfiniteScrollSentinel → consumer loadMore
  → useThresholdLoadMore.setWindowSize
    → rows.slice(0, windowSize) grows
      → table.getRowModel().rows.length changes
        → layout effect re-runs → three forced reads, before paint
```

So every appended batch forced a full re-layout in the frame the user's
finger was still on the trackpad. The same effect also tore down its
`ResizeObserver` in cleanup and rebuilt it around the *same two
elements* on each append.

The measurement now goes through `scheduleRowClip`, which keeps at most
one `requestAnimationFrame` in flight — a burst of appends collapses to
one measurement that runs once layout has already settled, rather than
forcing it. This is the same shape as the sibling fix in
`src/components/ui/hooks/use-scroll-progress.ts`.

The **first** pass is deliberately still synchronous. That is what the
layout effect was for: deferring it would paint the card unclipped for a
frame and then snap. A `clipMeasuredRef` flag flips once a real
measurement (row height > 0) has landed; every pass after that is
deferred.

The `ResizeObserver` is now created once and kept in a ref, torn down
only on unmount. Targets are re-registered only when the element
identity genuinely changes — an append replaces neither the card nor the
leading row, so an append re-registers nothing.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/table/table.tsx` | Clip pass moved off the commit onto a frame; observer made persistent |
| `tests/rendered/data-table-append-reflow.test.tsx` | Counts LAYOUT READS across an append; hand-driven frame queue |

## Decisions

- **Count layout reads, not renders.** A render-count assertion passes
  against the unfixed code — React batches the state updates into one
  commit either way. What moves is *when the element is measured*, so
  the test overrides `HTMLElement.prototype.offsetHeight` and counts
  reads on `TR` nodes: that property is read exactly once per
  measurement pass and nowhere else in the table.
- **Each append gets its own `act()`.** Three `rerender` calls inside a
  single `act()` collapse into one React commit, so the unfixed code
  measures once too and the "collapses to one measurement" assertion
  passes against it. Separate `act()` calls give separate commits, which
  is also what three real load-more batches produce.
- **The frame queue is hand-driven.** jsdom's `requestAnimationFrame`
  fires on a wall-clock timer, so "several appends within one frame"
  would be a race against ~16 ms of real time on a loaded CI box.
- **The queue length is not asserted.** Other libraries in the tree
  share the frame loop, so the global queue is not a private channel —
  one read after the flush carries the collapse claim instead.
- **Unmount-only observer teardown.** Disconnecting in the layout
  effect's cleanup is what made an append rebuild the observer; moving
  teardown to a `[]`-keyed effect is what keeps it stable.
