# List virtualization — the windowed-rendering convention

Epic 68 introduced a single shared windowing primitive
(`<VirtualizedList>`) and rolled it out across two high-volume
surfaces (`<DataTable>` row bodies + `<Combobox>` / `<UserCombobox>`
dropdowns). Every future high-scale list MUST use the same primitive.

This doc is the contract. If you find yourself importing
`react-window` directly, or hand-rolling a windowed renderer in a
component file, you're inventing a one-off and review will ask you
to convert it.

## Why this pattern

A non-virtualized 1000-row table or 1000-option dropdown puts every
row/option in the DOM:

- Initial render scales O(n) — expensive for large datasets.
- Browser layout + paint costs scale with DOM count.
- Memory + GC pressure scale with React's virtual DOM size.
- Scroll perf degrades as the browser re-paints sticky decorations
  on every scroll event.

Virtualization renders only the visible window plus a small overscan.
Initial render is constant-time relative to the viewport. The DOM
stays under ~30 nodes regardless of dataset size.

## The primitive — `<VirtualizedList>`

```tsx
import { VirtualizedList } from '@/components/ui/virtualized-list';

<VirtualizedList
  itemCount={1000}
  itemSize={44}
  renderItem={({ index, style }) => (
    <div style={style}>{rows[index].name}</div>
  )}
/>
```

Rules:

1. **Spread `style` on the outer element of `renderItem`.** react-window
   absolute-positions rows; without `style` they all stack at top.
2. **Provide `height` (and optionally `width`) when AutoSizer can't
   reach a sized parent.** In production code paths (inside
   `<ListPageShell.Body>`'s flex chain) AutoSizer measures correctly.
   In test harnesses or ad-hoc layouts, pass `height` explicitly.
3. **Use the `ref` for keyboard-driven surfaces.** The exposed
   `VirtualizedListHandle` carries `scrollToItem(index)`,
   `scrollTo(offset)`, and `resetAfterIndex(index)` (variable-size).
4. **Use `itemKey` only when row identity matters across sorts/shuffles.**
   For static lists the index-keyed default is fine.
5. **Don't import `react-window` directly.** The primitive is the
   single seam — replacing the engine later is a one-file change.

## Rolled-out surfaces

### `<DataTable>` rows (auto above 1000)

`<DataTable>` accepts `virtualize?: boolean | { threshold: number }`:

| Caller passes | Result |
|---|---|
| Nothing (default) | Auto-virtualize when `data.length > 1000` |
| `virtualize={true}` | Always virtualize |
| `virtualize={false}` | Never virtualize (Controls page contract) |
| `virtualize={{ threshold: N }}` | Auto with custom threshold |

The default threshold was raised from 100 → 1000 in a follow-up
because the lower threshold caused click-intercept regressions in
medium-sized tables (100-1000 rows) where the virtualized div
wrapper sat above row interactions in Playwright. The 1000 default
scopes auto-virtualization to genuinely large unpaginated tables;
pages that need it for smaller datasets should opt in explicitly.

When virtualized, `<DataTable>` renders via `<VirtualTable>` (file:
`virtual-table-body.tsx`):

- `display: grid` for headers + every body row.
- A single `gridTemplateColumns` value derived from
  `column.getSize()` — header + body share it, alignment cannot drift.
- Sticky header inside react-window's outer scroll container.
- Identical contract for: `data-selected`, `group/row`, click handlers
  with `isClickOnInteractiveChild` guard, sort buttons.

Auto-disable conditions (even when threshold met): server-side
pagination, `error` / `loading` / empty states. The non-virtual
`<Table>` retains the richer chrome.

Limitations vs `<Table>` — DataTable falls back automatically:
- column resizing
- column pinning

### `<Combobox>` / `<UserCombobox>` dropdowns (auto above 50)

`<Combobox>` switches to `<VirtualizedComboboxOptions>` when the
visible (post-search-filter) option count exceeds
`COMBOBOX_VIRTUALIZE_THRESHOLD = 50`.

What's preserved:
- Selection state (single + multi).
- Search filtering (cmdk's input + our internal `sortOptions`).
- Keyboard nav: ArrowDown / ArrowUp / Home / End / Enter — bound to
  the search input via a CAPTURE-phase listener that runs BEFORE
  cmdk's nav.
- Hover ↔ keyboard agreement: hovering a row updates the active
  index just like ArrowDown would.
- Scroll-to-active: `VirtualizedListHandle.scrollToItem(activeIndex)`
  fires every time the active index changes.
- ARIA: outer `role="listbox"` + `aria-activedescendant` pointing to
  a stable id; each option is `role="option"` + `aria-selected`.

What changes for users: nothing visually. The visual-parity test
(`tests/rendered/combobox-virtualize.test.tsx::"first option's visual
contract matches at the 50/51 boundary"`) locks the visual contract
in: the same flex structure, padding, and class fragments at 50 vs
51 options.

`<UserCombobox>` is a thin wrapper over `<Combobox>` — it
auto-virtualizes for free when an org has >50 members.

## Performance budget

The test in `tests/rendered/combobox-virtualize.test.tsx::"mounts and
opens rendering at most 30 option nodes"` guards one invariant:

**DOM count** — for any list above the threshold, the visible
option/row count is `<= 30`. This is the load-bearing perf win; if it
regresses (e.g. accidental `data` prop carrying all rows), the test
fails. The count is a pure function of the windowing maths, so it
reads the same integer on any machine under any load.

That test also carried a `<2s` wall-clock budget over the same
render+open until 2026-09-06. It was removed rather than widened,
because its verdict on the regression it named was a coin flip. With
`overscanCount` raised so every row renders, eight samples on one
8-core box measured 1318 / 1405 / 1839 / 1917 / 2192 / 2303 / 2334 /
2397 ms — four over the ceiling, four under — while the DOM-count
assertion read 1000 against `<=30` on all eight. Healthy on the same
box is 284-329 ms, so in the passing case the budget carried ~6x of
slack that only a loaded runner could spend.

What the DOM count gives up in exchange: it sees the wrong *number* of
nodes, not nodes that each became more expensive to build.

The DataTable side has its own DOM-count test
(`tests/rendered/data-table-virtualize.test.tsx::"5000-row virtualized
table renders far fewer than 5000 row nodes"`).

## Adding a new high-scale list

Decision tree:

1. **Is it a table?** Use `<DataTable>` — virtualization is automatic
   above 100 rows. Don't think about it.
2. **Is it a combobox-style picker?** Use `<Combobox>` — virtualization
   is automatic above 50 options. Don't think about it.
3. **Is it neither (e.g. activity feed, comment list)?** Use
   `<VirtualizedList>` directly with the contract above. Add the
   surface to a structural ratchet so future PRs can't silently swap
   in a non-windowed renderer.

When NOT to virtualize:

- Lists with **inherently variable, hard-to-measure row heights** that
  change AFTER mount (e.g. content with images that finish loading
  later). `VariableSizeList` mode requires deterministic per-index
  heights; for true dynamic measurement use the lower-level
  `react-window` API directly.
- Lists where **every row is independently focusable** in a way that
  needs roving tabindex across all items. The combobox bespoke
  keyboard layer covers most cases — but if you need full menu-style
  navigation, talk to the platform team first.
- Lists **smaller than the threshold**. Virtualization adds
  overhead; below the threshold the cost outweighs the benefit. Both
  primitives auto-disable for this reason.

## Foundation reference

| File | Role |
|---|---|
| `src/components/ui/virtualized-list.tsx` | Shared primitive — wraps `react-window` `Fixed/VariableSizeList` + `AutoSizer`; exposes `VirtualizedListHandle` (scrollToItem/scrollTo/resetAfterIndex) |
| `src/components/ui/table/virtual-table-body.tsx` | `<VirtualTable>` — DataTable's virtualized body + sticky header |
| `src/components/ui/table/data-table.tsx` | `decideVirtualization()` + threshold prop wiring |
| `src/components/ui/combobox/virtualized-options.tsx` | Combobox's virtualized option list with bespoke keyboard layer |
| `tests/rendered/virtualized-list.test.tsx` | 11-case primitive contract |
| `tests/rendered/data-table-virtualize.test.tsx` | 22-case DataTable rollout |
| `tests/rendered/combobox-virtualize.test.tsx` | 14-case Combobox rollout (threshold + DOM-count + keyboard + visual parity). The DOM count is the perf assertion; the `<2s` wall-clock budget that sat beside it was removed 2026-09-06 — see "Performance budget" above |
