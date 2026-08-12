# 2026-08-12 — Calendar: the filter moves into the day panel, and the URL learns the view

**Commit:** `<pending>` refactor(calendar): fold the filter into the day-events panel

The operator's request: move the filter bar into the right-hand day-events
panel. Two of the brief's supporting premises turned out to be wrong, and
saying so is most of this note.

## Design

### The chips were two controls wearing one coat

The filter bar's category chips were simultaneously the **colour legend** for
the grid's event dots and the **filter**. Moving them wholesale would have taken
the key away from the thing it explains — a grid of coloured dots with no key
anywhere is a worse surface than one with an awkwardly-placed filter.

So they split:

- a **non-interactive colour key** (`#calendar-legend`) stays with the grid;
- the **interactive filter** (`#calendar-filter-group`) moves into the aside.

Both render from `getCategoryTone`, so the swatch beside a legend entry and the
swatch beside its checkbox cannot drift to different colours. The rendered test
asserts the legend contains **zero** interactive elements and the filter group
contains the controls — the split is the claim, so it is what gets tested.

### Layout constraints, and which answer each got

| Constraint | Answer |
| --- | --- |
| 8 categories at ~288px would stack 5-6 rows and push the day's events below the fold | two-column checkbox grid |
| below `lg` the aside renders AFTER a 42-cell month grid in document order | `order-first lg:order-none` — the filter is the first thing on mobile, not something behind a full month of scrolling |
| the aside had no sticky, no max-height, no overflow — a busy day pushes the filter arbitrarily far down | `lg:sticky` + `max-h-[calc(100vh-2rem)]`, and the events list gets its **own** scroll region |
| `countTotal` is the filter's only feedback | moved with it |
| interactive controls inside `<aside>` change the a11y tree | own labelled `role="group"` |

The mobile answer is stated rather than implied because the brief asked for it
explicitly: **order utilities**, not sticky. Sticky solves the desktop
overflow; it does nothing about document order in a collapsed single column.

### Epic 53: the brief's instruction rests on a false premise

The brief said to adopt `FilterToolbar` + `FilterProvider`, **or** add the page
to `EXEMPTIONS` in `tests/guards/filter-toolbar-coverage.test.ts` with a written
reason.

That guard only scans files mounting `<DataTable>`:

```ts
if (!/<DataTable\b/.test(content)) continue;
```

The calendar mounts **zero** `DataTable`s — it renders `CalendarMonth`,
`CalendarHeatmap` and `GanttTimeline`. It is not flagged by that ratchet and
cannot be. An `EXEMPTIONS` entry would be a key the guard never looks up: dead
config in a map whose entries are supposed to justify a live suppression.

Adoption on its own merits also fails after the fold. `FilterToolbar` is a
full-width horizontal bar primitive, mounted through `ListPageShell.Filters`.
The filter now lives in a 320px sidebar. Wrapping a bar primitive in a sidebar
to satisfy a guard that does not apply would be worse than the hand-rolled
control it replaced.

**What the brief was actually right about is the URL**, and that is delivered
directly: `view`, `month`, `categories` and `mine` are now query params. None of
them were — on a page whose entire purpose is "what is due" and whose links get
pasted into chat, a shared link dropped the recipient on the current month with
no filters, whatever the sender was looking at. `router.replace` rather than
`push`, so toggling a category does not stack history entries.

### The nine `data-testid`s are deferred, not ignored

`CalendarClient` carries nine, and **not one** is referenced by an executing
test — the two apparent hits are source-greps inside a guard, which assert the
string exists rather than using it. CLAUDE.md says to use `id` attributes.

The brief couples this to its own item 4 ("*see item 4 — there is no calendar
E2E at all*"), which is a separate task. Deleting the selectors here and
re-adding them next PR is churn; they are resolved with the E2E that gives them
a purpose or removes the need for them.

## Files

| File | Role |
| --- | --- |
| `src/app/t/…/calendar/CalendarClient.tsx` | legend/filter split, panel fold, scroll region, URL sync |
| `tests/rendered/calendar-filter-panel.test.tsx` | first executing test of this component |
| `messages/{en,bg}.json` | `legendAria` |

## Decisions

- **Both premises were checked, not trusted.** The brief said zero tests
  reference the moved ids — true, though `filterClear` appears in
  `data-table.test.ts` as an unrelated escape-key priority variable, which a
  grep-and-believe would have read as a hit. And the Epic 53 exemption
  instruction did not survive reading the guard.

- **A ratchet caught a hand-rolled checkbox.** The first pass used raw
  `<input type="checkbox" className="size-3">`, which trips the icon-size
  discipline guard (12px, below the `sm` token) — and, more to the point, the
  repo has a `<Checkbox>` primitive (Epic 55). Using it was the correct answer
  and the guard is why it happened.

- **The tests assert containment, not co-existence.** `expect(panel.querySelector(…))`
  rather than `expect(container.querySelector(…))` — the latter passes while the
  filter sits anywhere on the page, which is exactly the state this change was
  meant to leave behind. Verified by moving the id off the panel and confirming
  five tests fail.
