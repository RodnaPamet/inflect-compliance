# 2026-11-23 — Mobile lists: filter toolbar, segmented controls, list cards

Three shared primitives that every list page renders, fixed once each so the
pages need no workaround (#5816, #5817, #5818; audit findings A-S5, A-S7,
A-S8, A-S9, B-S6, B-S7, B-S9, C-S9, C-S16).

## Design

**Filter toolbar.** On a desktop row the active-pill slot is the `flex-1`
spacer that right-pins the icon buttons. On a phone it was the same spacer,
squeezed to about 80px between the Filter trigger and the icons, so the pills
crushed and "Clear Filters" was clipped by the shell's `overflow-x-clip`.
Below `md` the slot is now `basis-full order-last`: a row of its own, below
the controls, and not laid out at all when no filter is active. The leading,
secondary and primary clusters wrap. Inside `FilterList` the Clear button is
`shrink-0`, translated (`ui.filterList.clearFilters`), drops its ESC hint on a
coarse pointer and is 44px tall there; a pill is `min-w-0 max-w-full` and its
value segment ellipsises, so the remove button (now named, `removeFilter`)
never leaves the screen.

**Segmented control.** Labels are `whitespace-nowrap` and options `shrink-0`;
the radiogroup is the scroller (`overflow-x-auto`, scrollbar hidden) inside a
frame that carries the caller's layout classes and the two edge cues. The cues
(a token gradient plus a chevron) are switched by `data-scroll-start` /
`data-scroll-end` written imperatively from a scroll listener and a
`ResizeObserver`, so scrolling re-renders nothing. The selected option is
scrolled into view by setting `scrollLeft`, never `scrollIntoView`, which
would also scroll the page to a group below the fold. Below `sm`, a group of
`SELECT_MIN_OPTIONS` (4) or more renders as the existing `<Combobox>` (a
bottom sheet on a phone); a link-mode option navigates with `router.push`.
Contrast: unselected options are `text-content-muted`, the selected one
`text-content-emphasis`, and the pill is `bg-bg-elevated` with
`border-border-strong` (3.5:1 in both themes) instead of a `bg-bg-muted` pill
that was a faint beige on the light theme's track.

**List cards.** A card is now a title row and a field list.

- The title row holds the selection checkbox, the first field and a "⋯" menu.
  The checkbox sits in a 44px box pulled into the card padding, at 20px with
  `border-border-strong`, set through a descendant selector because the
  select column belongs to `table.tsx` and `Checkbox` is not this batch's.
- The field list puts the label above the value below `sm`, and beside it
  (label capped at 40%) from `sm`.
- A field whose rendered value is only a dash is hidden. A page's inline
  `truncate` span becomes block-level, so it ellipsises.
- Columns marked `meta.cardAction` go into the "⋯" menu, built on the shared
  `<Popover>`. There each control's `aria-label` is painted as its visible
  text (`after:content-[attr(aria-label)]`), and each control is a full-width
  44px row.

## Files

| File | Role |
|---|---|
| `src/components/filters/FilterToolbar.tsx` | Pill row of its own below `md`; clusters wrap |
| `src/components/ui/filter/filter-list.tsx` | Translated, unsqueezable Clear; shrinkable pills; named remove buttons |
| `src/components/ui/toggle-group.tsx` | No-wrap labels, scroller + edge cues, select below `sm`, contrast |
| `src/components/ui/table/data-table-cards.tsx` | Title row, stacked labels, empty-field omission, ellipsis, actions menu |
| `src/components/ui/table/data-table.tsx` | One prop: tells the cards whether anything acts on a selection |
| `src/types/tanstack-table.d.ts` | `ColumnMeta.cardAction` |
| `evidence/EvidenceClient.tsx`, `tasks/TasksClient.tsx` | Mark their icon-only action columns `cardAction` |
| `messages/{en,bg}.json` | `ui.filterList`, `ui.dataTableCards` |

## Decisions

- **Label above value, always, below `sm`.** The issue offered "when the
  label is long" as the alternative. The same label is short in English and
  long in Bulgarian, a character count does not predict rendered width, and a
  card whose rows switch layout from one field to the next is harder to scan
  than one that never does. From `sm` (a 640-767px card) there is room for
  both, so the side-by-side layout stays there.
- **Read-only means "nothing acts on a selection",** decided where the facts
  are. The select column is default-on (`selectionEnabled ?? true`) and so
  says nothing about whether a list has bulk actions; `<DataTable>` knows
  whether it has `onRowSelectionChange`, `selectionControls` or
  `batchActions`, and passes that as `selectable`. Only the cards honour it.
  The desktop column is untouched, because changing it is a product decision
  about every desktop list.
- **Empty fields are judged by what rendered, not by the cell value.** A
  `null` value often renders as something meaningful ("Unassigned"), and a
  display column has no value at all. The check reads the DOM in a layout
  effect and writes the `hidden` attribute directly: no state, no second
  render, no flash. Anything with an icon, image or control is never empty.
- **The actions menu is opt-in (`meta.cardAction`), not inferred** from a
  blank header. Blank-header columns also hold content (status icons, a kebab
  menu that is already a menu), and the visible-label technique is only right
  for icon-only controls; a text button with an `aria-label` would show its
  name twice.
- **The action cells render exactly once.** While the menu is closed they sit
  in a `hidden` probe (so the trigger's wrapper can hide when no action
  applies to the row); while open they render in the menu instead. Rendering
  both would duplicate the ids pages put on those buttons. The wrapper, not
  the trigger, is hidden, because `<Popover>` replaces its trigger element
  when it switches between a dropdown and a bottom sheet.
- **The select below `sm` is chosen in JS** (`useMediaQuery().isMobile`,
  false on the server and in jsdom) rather than by rendering both and hiding
  one with CSS: both in the DOM would duplicate every option label for tests
  and for the `id`s link-mode options carry.
- **`ScrollCueStrip` (#5846) had not merged,** so the toggle group carries its
  own edge fade. Once it lands, the frame can be replaced by it.
