# 2026-11-23 — Desktop-shaped surfaces on a phone: SoA, SoA print, calendar, RBAC

**Commit:** see the pull request for #5886, #5887, #5890 and #5891 (Mobile 4.1, 4.2, 4.5, 4.6 of epic #5868).

## Design

Four pages designed for a wide screen get a phone layout of their own below
`md` (owner decisions of 2026-11-23). Desktop renders exactly what it did.

- **Statement of Applicability** (`reports/soa`). Below `md` the 7-column
  table becomes one card per requirement (`SoACard`): code, title and group,
  then applicability, status, the requirement's own justification and its gap
  badges, and the mapped controls behind a "Show N controls" button. The seven
  KPI tiles, which filled the first screen in a two-column grid, become one
  `ScrollCueStrip` of fixed-width tiles. The table row's expansion and the
  card's share `MappedControlsDetail`; on a card it stacks, and a control's
  reason wraps instead of truncating behind a hover tooltip a phone has no way
  to open. The requirement's group (`section || category`) was printed as
  stored — `ORGANIZATIONAL`, or a taxonomy key such as `Access control` — and
  now reads `controls.categoryLabels.*` / `controls.isoDomainLabels.*`
  (`useSoASectionLabel`, `reports/soa/section-label.ts`), on the desktop row
  and in the printed statement's section headings too. The switch is `useIsBelowMd()`, as DataTable's card
  fallback: `false` on the server and the first render.
- **SoA print view** (`reports/soa/print`). A notice, not a phone layout: on a
  phone SCREEN an `EmptyState` says the view is for printing and offers Print /
  Save as PDF, the readable SoA (`?framework=` kept) and Back. The document
  stays in the page. Both gates are `@media screen and (max-width: 767.98px)`
  arbitrary variants, never a bare `max-md:`: a printed page (A4 is ~720 CSS
  px) is narrower than `md` too, so a breakpoint gate would have hidden the
  tables from every printout, desktop included.
- **Calendar.** A fourth view, `agenda` (`_components/CalendarAgenda.tsx`): day
  headings in date order, each event a link with its title, category and
  status. It reads the month grid's window, so it has month navigation and a
  switch between agenda and grid refetches nothing. It is the DEFAULT below
  `md`; the month grid stays one tap away. Days before today in the current
  month fold behind one "Show N earlier days" button, so the first screen is
  today and the rest of the week. On a phone the category filter folds behind
  one button (eight touch-sized rows above the list pushed the first deadline
  off the first screen); the fold is CSS (`md:hidden` / `max-md:hidden`), so
  the server's paint is already folded.
- **RBAC matrix** (`admin/rbac`). A server page, so the split is CSS: the table
  is `hidden md:block`, and below `md` a client island
  (`RolePermissionsByRole`) shows one role at a time — a tab strip of the six
  roles in a `ScrollCueStrip`, then that role's permissions grouped by resource,
  each line saying "Allowed" / "Not allowed" in words. Both are built from the
  same rows on the server, so they cannot disagree.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/reports/soa/SoAClient.tsx` | Phone cards, KPI strip, translated group, shared mapped-controls detail |
| `src/app/t/[tenantSlug]/(app)/reports/soa/print/SoAPrintView.tsx` | Phone-screen notice; the document kept for print |
| `src/app/t/[tenantSlug]/(app)/reports/soa/print/page.tsx` | Passes the SoA link to the notice |
| `src/app/t/[tenantSlug]/(app)/reports/soa/section-label.ts` | A requirement's group in words, for the page and the printout |
| `src/app/t/[tenantSlug]/(app)/calendar/_components/CalendarAgenda.tsx` | The agenda renderer |
| `src/app/t/[tenantSlug]/(app)/calendar/CalendarClient.tsx` | `agenda` view, per-screen default view and offered views, touch-sized filter rows |
| `src/app/t/[tenantSlug]/(app)/admin/rbac/RolePermissionsByRole.tsx` | One role at a time |
| `src/app/t/[tenantSlug]/(app)/admin/rbac/page.tsx` | Builds the grouped rows; CSS split between the two |
| `messages/{en,bg}.json` | `reports.soaMobile`, `reports.soaPrintMobile`, `calendar.agenda`, `admin.rbac.byRole` |

## Decisions

- **Only the calendar's DEFAULT is per screen.** A view named in the address is
  honoured on any screen and is always among the offered options, so a link
  pasted from a phone opens the agenda on a desktop and the toggle still shows
  what is selected. `setView` drops `?view=` only for the current screen's
  default.
- **With no view in the address, no view renders until the first client
  effect.** The server cannot know the screen, and rendering the desktop's
  grid and then swapping it for the agenda flashed 42 empty cells on a phone
  (the mobile audit measured the grid's day buttons on a slow load). The fetch
  does not wait: both defaults read the same window.
- **A phone offers agenda and month, not heatmap and timeline.** The year
  heatmap and the twelve-month timeline are wide by nature; they remain
  reachable by address and on larger screens.
- **The agenda shows no time of day.** Calendar events are day-resolution
  (`CalendarEvent.date` is truncated to the day); the issue's "time" is the
  day heading, plus "until <date>" for a duration event.
- **The agenda is not a shared calendar core.** Like the three renderers before
  it (`docs/calendar-surface-do-not-touch.md` §4) it shares no layout code: a
  list of days has no grid maths. The per-source authorization, tenant scoping
  and truncation notices are untouched; it renders what the same fetch returns.
- **The filter checkboxes grow on touch only** (`pointer-coarse:min-h-11` on the
  row, `TOUCH_HIT_AREA_CLASS` on the box), so the desktop panel keeps its
  density and no two hit areas overlap on a phone.
- **RBAC tabs, not a select.** The issue allowed either; a tab strip in the
  shared `ScrollCueStrip` shows several roles at once, says when it scrolls,
  and keeps the tablist keyboard contract (arrows, Home, End). It opens on the
  viewer's own role.
- **SoA text below 12 px went to 12 px** (the epic's "12 px everywhere"): the
  group line, the KPI labels and the expansion's captions, on desktop too.
