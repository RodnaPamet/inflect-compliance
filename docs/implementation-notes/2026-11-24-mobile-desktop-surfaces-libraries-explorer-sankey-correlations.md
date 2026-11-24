# 2026-11-24 — Desktop-shaped surfaces on a phone: template libraries, requirement explorer, Sankey, correlations

**Commit:** see the pull request for #5888, #5889, #5892 and #5893 (Mobile 4.3, 4.4, 4.7, 4.8 of epic #5868).

## Design

Four surfaces drawn for a wide screen, per the owner decisions of 2026-11-23:
the template libraries and the requirement explorer get phone layouts; the
Sankey chart and the correlation matrix get a "larger screen" notice and a
readable list. Everything is gated below `md`; a larger screen renders what it
did.

- **Template libraries** (`controls/templates`, `frameworks/[key]/templates`).
  Shared parts in `src/components/controls-shared/template-library-phone.tsx`:
  `useProgressiveCount` (one page of 20 cards, a page more per "Show more",
  back to one page whenever the search or a filter changes),
  `TemplateSelectBox` (the `Checkbox` primitive at 24 px with
  `TOUCH_HIT_AREA_CLASS`, so the tap is 44 px), and `TemplateInstallDock` (a
  bar pinned to the bottom of the screen, clear of the home indicator, with
  the count in its Install button and a Clear button while anything is
  selected). On a phone the controls library renders its own card list in
  place of `DataTable` (whose card fallback showed no selection at all), its
  desktop install card is `max-md:hidden`, and the search is the first thing
  under the title. The framework library keeps its cards, with the native
  13 px checkbox swapped for the shared box below `md`, the title on its own
  line and wrapping (`md:truncate`), and the code `whitespace-nowrap`, which
  overrides the global `overflow-wrap: anywhere` that split "A-/5.1". The
  header's bulk button is the larger screen's. A refused install is scrolled
  into view, since Install is tapped at the bottom of the page.
- **Requirement explorer** (`FrameworkExplorer`). Below `md` the tree is the
  page; a tap on a requirement shows its detail IN PLACE of the tree
  (`max-md:hidden` on whichever pane is not current), scrolls it into view
  under the sticky top bar and tab strip (`max-md:scroll-mt-32`) and moves
  focus to a 44 px "Back to requirements". Back restores `window.scrollY` as it
  was at the tap and focuses the row. The tree stays mounted, so its expansion
  survives. A tap on a section opens or closes it, as its chevron does. On a
  touch screen a tree row is 44 px tall and its chevron spans the row
  (`pointer-coarse:` in `TreeViewItem`), and a title wraps below `md` instead
  of being cut. The minimap was already `hidden lg:block`.
- **Sankey** (`controls/sankey`). `SankeyFlowSummary`: an info notice, then
  every flow the chart draws, band by band (Assets → Risks, Risks → Controls,
  Controls → Requirements), grouped by source, each end a 44 px link to its
  record (a record with no page is plain text). It reads the chart's own
  projection (`buildSankeyDataset`), so the two cannot disagree; two edges
  between one pair are one row marked "×2".
- **Correlations** (`risks/correlations`). Below `md` the grid is hidden and a
  list shows: a notice, the correlated pairs strongest first (by absolute
  figure), each with both risks as links, the figure on the grid's heat
  colour and, for a writer, Edit; then the uncorrelated pairs folded in one
  `<details>`, so the list holds every pair the grid does. The editor opens
  inside the tapped row on a phone and below the grid on a larger screen; the
  same element either way, rendered once.

- **An install invalidates the cached lists.** The new mobile E2E (two
  templates ticked and installed in an isolated tenant) found that neither
  install path — `installControlsFromTemplate`, `installSingleTemplate`,
  `bulkInstallTemplates`, nor a pack install — bumped the list-cache version,
  so for up to the cache's 60 s TTL the controls page an install redirects to
  said "no controls yet". Each now bumps `control` and `task` after its
  transaction commits.

## Files

| File | Role |
| --- | --- |
| `src/components/controls-shared/template-library-phone.tsx` | Progressive count, 44 px select box, pinned install bar |
| `src/app/t/[tenantSlug]/(app)/controls/templates/page.tsx` | Phone card list, dock, desktop install card hidden on a phone |
| `src/app/t/[tenantSlug]/(app)/frameworks/[frameworkKey]/templates/page.tsx` | Paged cards, shared box, wrapping title, unbroken code, dock |
| `src/components/frameworks/FrameworkExplorer.tsx` | Drill-in, Back with scroll restore, section tap toggles |
| `src/components/ui/TreeViewItem.tsx` | 44 px rows and chevrons on touch; wrapping titles below `md` |
| `src/app/t/[tenantSlug]/(app)/controls/sankey/SankeyFlowSummary.tsx` | The flows as a list, and `sankeyFlowBands` |
| `src/app/t/[tenantSlug]/(app)/controls/sankey/ControlsSankeyClient.tsx` | CSS switch between the list and the chart |
| `src/app/t/[tenantSlug]/(app)/risks/correlations/page.tsx` | Phone list, editor beside the pair |
| `src/app/t/[tenantSlug]/(app)/risks/correlations/correlation-pairs.ts` | The pairs above the diagonal, split and ordered |
| `src/app-layer/usecases/control/mappings.ts`, `.../framework/install.ts` | Bump the control and task list caches after an install |
| `tests/e2e/mobile-template-install.spec.ts` | Two templates ticked and installed on a phone, in both phone configurations |
| `messages/{en,bg}.json` | `controls.sankey.phone`, `risks.correlations.phone`, `panels.framework.backToRequirements`, `controls.templates.phone`, `frameworks.templates.phone` |

## Decisions

- **CSS switches where the server can paint the right thing.** The Sankey and
  correlation lists are `md:hidden` beside a `hidden md:block` / `max-md:hidden`
  original, so a phone's first paint is already right and nothing new ships to
  the client but the list. `useIsBelowMd` is used only where behaviour, not
  layout, differs: where the correlation editor opens, whether a tap drills
  in, and the template libraries' page size and card list (the controls
  library's `DataTable` already makes the same switch).
- **"Show more", not pages.** The libraries are searched first; a pager would
  put the next page's first card at the top of a new page and lose the
  reader's place, while "Show more" appends.
- **The install bar is there before anything is selected.** Its button reads
  "Install selected (0)" and is disabled, so the count is visible throughout
  and the action never moves or appears from nowhere.
- **Correlations list every pair, not only the correlated ones.** The issue
  asks for every pair the matrix shows; a list of 0.00s would bury the ones
  that matter, so they fold behind one control that says how many there are.
- **A section tap toggles only on a phone.** On a larger screen a section tap
  still selects it and shows its summary in the detail pane, as before.
