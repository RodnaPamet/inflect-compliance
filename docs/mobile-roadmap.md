# Mobile view — audit (2026-11-22) and roadmap to a flawless phone experience

> **Status: living design** — the audit below describes the product as it renders on a phone today; the roadmap is the plan to fix it. See the "Current state" and "Roadmap" sections for what is and isn't true today.

## Why this exists

The owner opened the agent detail page on an iPhone (Bulgarian, dark) and it was
visibly broken: the header's five actions wrapped into a ragged three-row stack,
the tab bar showed three of nine tabs with nothing to say there were more, the
assistant button sat on top of the content, and the back link read
"Обратно към Agents". No mobile audit had been run for a long time, so one was
run across the whole product before anything was fixed.

## How the audit was run

- **Pages.** Every `src/app/**/page.tsx` route was enumerated: 183 in all. 178
  were captured (153 render at their own URL, 25 redirect and were captured at
  their destination). Five need data the E2E seed does not create (an
  integration connection ×3, an A2A peer, a NIS2 assignment) and were not
  captured. The `policies/[policyId]` capture produced empty images and was read
  from its measurements only.
- **Configurations.** iPhone 14 (390×844, device scale 3, touch) in dark +
  Bulgarian and light + English, and a small phone (360×780) in dark +
  Bulgarian. Bulgarian is the longer language, so it is where wrapping breaks
  first. Eight open states were captured as well: the navigation drawer, user
  menu, command palette, assistant sheet, a create modal, an inspector sheet and
  the agent tab bar scrolled to its end.
- **Build.** The E2E production build (`next build` + `next start`) against the
  E2E seed plus extra records created through the product's own APIs, signed in
  as the seeded OWNER (tenant pages) and ORG_OWNER (org pages), anonymous for
  auth and public pages.
- **Measurements, per page and configuration.** Content clipped at the right
  edge outside a scroll container; the assistant button covering text or a
  control; tap targets under 24 px and under 44 px; text under 12 px; inputs
  under 16 px (iOS zooms on focus); tab bars that overflow with no cue; button
  groups on three or more lines; tables wider than the screen; English strings on
  Bulgarian pages; console errors.
- **Review.** Three reviewers then looked at every screenshot, area by area, and
  traced each defect to the component that causes it.

## Current state (true today)

### Progress since the audit (2026-11-24)

Phases 0–5 and every P0 page have shipped. Epic #5805 (Phases 0–2) and its 30
issues are closed, and so is epic #5868 (Phases 3–5). The real-device pass was
not run: on 2026-11-25 the owner decided to rely on the automated phone checks
alone (see Phase 5 below).

| Work | Pull requests |
|---|---|
| Phase 0: the audit harness (`scripts/mobile-audit/`), the `mobile` Playwright project, its ratchet, the 360 px checklist item | #5860, #5862, #5864 |
| Phase 1: overlays stack and clear the home indicator, the bulk bar fits; 16 px fields on touch; the tab strip shows that it scrolls; assistant and search in the top bar, 44 px chrome targets; filter toolbar, segmented controls and list cards; page header with a "⋯" menu and one way back | #5845, #5846, #5847, #5850, #5853 |
| Phase 2: back links, dates, helper copy, server-built text, raw enums and the shell's remaining strings in Bulgarian, with a ratchet per leak class | #5853, #5858, #5859, #5864 |
| P0 pages: task detail, test-plan detail, integrations, agent runs, vendor template editor, audit-cycle readiness, BIA detail | #5853, #5856 |
| Phase 3, shared fixes: harness accuracy; 12 px text everywhere (a lint rule refuses smaller); clipping; 44 px tap targets for card titles, text links, choice inputs and small controls (lint rules refuse native choice inputs and a literal `aria-label`); chart legends and marks | #5901, #5905, #5907, #5906, #5911, #5920, #5927 |
| Phase 3, the pages: core GRC, agents and admin, vendors / audits / incidents / org | #5915, #5916, #5917 |
| Phase 3, Bulgarian: pages hydrate in Bulgarian; the onboarding tour, the four-eyes refusals, numbers, and the tldraw canvas in the reader's language; tldraw's fonts self-hosted | #5903, #5915, #5923, #5925, #5928, #5914 |
| Phase 4, desktop-shaped surfaces: SoA cards and print notice, calendar agenda, RBAC one role at a time; template libraries, the requirement explorer drill-in, the correlations and Sankey lists; KPI strip, Internal Audit hub list-first, vendor questionnaire, shared-audit picker, agent tabs grouped | #5902, #5908, #5909 |
| Phase 5: six phone journeys plus the questionnaire journey in the `mobile` project; the nightly whole-product audit (`.github/workflows/mobile-audit.yml`) with fixtures for every dynamic route; the real-device checklist in `docs/mobile-audit.md` | #5922, #5926, #5928 |
| Bugs found on the way: the vendor questionnaire could not be submitted; shared audit links showed no item content | #5918, #5922 |

**The fixed-route ratchet** (`tests/e2e/mobile-ratchet.ts`, `DRIFT_ALLOWANCE` 0)
is at 0 on every metric, at 390 dark and 360 light, in Bulgarian, on both the
seeded routes and the record routes: nothing clipped, no field under 16 px, no
overlay over a control or text, every overflowing tab bar cued, no tap target
under 24 px, no English string.

**The whole product**, from the nightly audit on `main` (run 45474207244, commit
`ad85f7f91`), every route captured with its fixtures:

| Check (pages failing) | 390 bg | 390 en | 360 bg |
|---|---|---|---|
| Routes captured / not captured | 183 / 0 | 183 / 0 | 183 / 0 |
| Page scrolls sideways | 0 | 0 | 0 |
| Content clipped at the screen edge | 0 | 0 | 0 |
| Overlay covers text / a control | 0 / 0 | 0 / 0 | 0 / 0 |
| Tap target < 24 px | 0 | 0 | 0 |
| Tap target < 44 px (advisory) | 68 | 63 | 68 |
| Text < 12 px | 0 | 0 | 0 |
| Tab bar overflows with no cue | 0 | 0 | 0 |
| Button group on 3+ lines | 0 | 0 | 0 |
| Input font < 16 px | 0 | 0 | 0 |
| Table wider than the screen | 0 | 0 | 0 |
| English strings on a Bulgarian page | 0 | – | 0 |
| Console errors | 0 | 0 | 0 |

Every open state the harness opens (assistant sheet, command palette, create
modal, inspector sheet, nav drawer, onboarding tour, selection toolbar, user
menu) is at 0 too. A count that rises fails the nightly and opens an issue.

Known limits, each written down where it applies:
- **tldraw's "made with tldraw" link** stays a small target: its licence asks
  that it stay visible and interactive. The harness leaves it out with that
  reason (`LICENCE_BOUND` in `scripts/mobile-audit/measure.ts`).
- **The English-leak detector** recognises interface text by its catalogue
  template, so a stock sentence with no template reads as tenant data. #5929
  (assignment notifications stored in English) was found that way, by hand.

The sections below record the product as the audit found it on 2026-11-22.

### The headline numbers at the audit (2026-11-22)

Pages failing each check (390 dark bg / 390 light en / 360 dark bg):

| Check | 390 bg | 390 en | 360 bg |
|---|---|---|---|
| Page scrolls sideways | 0 | 0 | 0 |
| Content clipped at the right edge | 28 | 13 | 35 |
| Assistant button covers text | 63 | 63 | 75 |
| Assistant button covers a control | 63 | 57 | 59 |
| Tap target < 24 px in the page body | 145 | 145 | 145 |
| Text < 12 px | 61 | 62 | 61 |
| Tab bar overflows with no cue | 12 | 11 | 12 |
| Button group on 3+ lines | 7 | 4 | 7 |
| Input font < 16 px (iOS zoom) | 44 | 44 | 44 |
| English strings on a Bulgarian page | 116 | – | 116 |

"Page scrolls sideways: 0" is not good news. The app shell clips horizontal
overflow (`overflow-x-clip` on the main column), so whatever does not fit is
cut off silently instead of scrolling. The "clipped" row is the real overflow
signal, and it is why controls vanish rather than misbehave visibly.

### What already works

- **List pages collapse to cards** below `md` (`DataTableCards`): labelled
  fields, a chevron on clickable rows, a 44 px floor.
- **Create flows open as bottom sheets** with a drag handle, a scrolling body
  and a sticky Cancel/Create footer; the modal drawer handles the keyboard.
- **KPI grids reflow** to two columns; the risk heatmap fits.
- **The viewport is set correctly** (`viewport-fit=cover`, pinch-zoom allowed)
  and the top bar and assistant button respect the safe-area insets.
- **The navigation drawer** is full height with 44 px rows.
- **Public pages** — trust center, invites, SSO hand-off error, the org
  "new workspace" form — read well.
- **Light theme** introduces no layout breakage of its own.

### P0 — a phone user cannot do the thing at all

| # | Where | What the user sees | Cause |
|---|---|---|---|
| 1 | User menu, every page | Opens as a bottom sheet with everything in one row: name and email cut off on the left, Profile / Account security / MFA on the right. Only "Sign out" is readable. | `ui/popover.tsx` mobile drawer wraps content in `flex items-center justify-center overflow-hidden`; the user menu passes a fragment. |
| 2 | Bulk actions, every selectable list | After ticking cards the action bar is one non-wrapping ~408 px row; **Apply** is off-screen. | `ui/table/selection-toolbar.tsx` + `ui/bulk-action-bar.tsx`. |
| 3 | Task detail | **Assign** and **Set reviewer** are pushed off-screen by a fixed `w-64` picker in a non-wrapping row. | `tasks/[taskId]/page.tsx`. |
| 4 | Test-plan detail (two routes) | Title one word per line; **Run test / Continue run** clipped. | `test-plans/TestPlanDetailView.tsx` header row. |
| 5 | Integrations | "Enable internal checks" half off-screen; the links to identity accounts, leaver passes, joiner passes and write policy are invisible — the only way to those pages from here. | `admin/integrations/page.tsx` five-button `justify-between` row. |
| 6 | Agent runs | Workflow link squeezed; the steps/tokens/date line is clipped. | `agents/runs/AgentRunsClient.tsx`. |
| 7 | Vendor template editor | Every question wraps one word per line (page ≈ 11,000 px). | `VendorTemplateBuilderClient.tsx` badges beside the prompt. |
| 8 | Audit-cycle readiness | Gauge and breakdown never stack; at 360 the percentages are cut off. | `audits/cycles/[cycleId]/readiness/page.tsx`. |
| 9 | BIA detail | Every section card has zero padding; text touches the border. | `BiaDetailClient.tsx` `density: 'none'`. |

### Systemic P1 — one shared component, many pages

| ID | Defect | Component | Reach |
|---|---|---|---|
| S1 | Assistant button floats over the last row, a select or the primary action; the shell reserves no space for it. Also shown on the MFA gate. | `assistant/AssistantLauncher.tsx`, `<main>` in `layout/AppShellFrame.tsx` | ~63 pages |
| S2 | Detail tab bar shows 2–3 of up to 9 tabs; no fade, arrow or scrollbar; active tab not scrolled into view; last tab still cut when scrolled fully; not sticky. | `layout/EntityDetailLayout.tsx` (copied in `ProcessesClient.tsx`) | every entity detail page |
| S3 | Header actions wrap right-aligned, ragged and in **reverse reading order**; title and description squeezed into a half-width column. Pages that wrap their actions in their own `flex` div defeat the wrapping and get clipped. | `layout/PageActions.tsx` (`flex-wrap-reverse justify-end`), `layout/PageHeader.tsx` | agent, framework, BIA, NIS2, vulnerabilities, access reviews, … |
| S4 | Every input, select and textarea is 14 px, so iOS Safari zooms the page on focus — including sign-in. | `.input` in `globals.css`, `ui/input.tsx`, `ui/textarea.tsx`, ad-hoc inputs | 44 pages, every create sheet |
| S5 | Filter toolbar's secondary row never wraps; active-filter chips are crushed; "Clear Filters" clipped. | `filters/FilterToolbar.tsx`, `ui/filter/filter-list.tsx` | every list with a filter |
| S6 | Segmented controls wrap each label onto two lines or run past the card. | `ui/toggle-group.tsx` | risks, tests, agents/decisions, agents/reports, loss events |
| S7 | Mobile cards: long `shrink-0` labels squeeze values; a lone selection circle on its own row; all-"—" rows printed; selection offered on read-only lists; `truncate` on an inline span never truncates; icon-only actions stacked with tooltip-only labels. | `ui/table/data-table-cards.tsx` | every list page |
| S8 | Hand-rolled `flex justify-between` rows with no wrap, made invisible by the shell's clip. | page code; enabled by `overflow-x-clip` | integrations, notifications, risk matrix, AI features, SCIM, onboarding banner, correlations, org dashboard, … |
| S9 | Bottom drawers ignore the home-indicator inset; sheets size with `vh`, not `dvh`. | `ui/popover.tsx`, `ui/modal.tsx`, `ui/sheet.tsx` | every bottom sheet |
| S10 | Small tap targets in shared chrome: bell and brand link 22 px; breadcrumbs, back link and record pager 16 px; checkboxes 13–16 px; `InfoTooltip` 16 px. | `nav-bar.tsx`, `notifications-bell.tsx`, `entity-prev-next-nav.tsx`, `Checkbox`, `InfoTooltip`, `BackAffordance` | every page |
| S11 | Shell gaps: the drawer's title reads "Open navigation menu"; there is no way to open the command palette on a phone; the toaster is fixed to the dark theme and top-right, over the page header. | `MobileNavDrawer.tsx`, `TopChrome.tsx`, `providers.tsx` | every page |
| S12 | Breadcrumbs and a back link to the same parent, in an order that changes from page to page. | `PageHeader` + `BackAffordance` placement | every subpage |

### i18n — English on Bulgarian pages

| ID | Leak | Source |
|---|---|---|
| I1 | "Обратно към Agents / Controls / Vendors / Internal Audit…" on ~60 subpages | `src/lib/nav/canonical-parents.ts` stores English labels; `SECTION_LABELS` has no `/agents` entry |
| I2 | Dates and relative times always English ("20 minutes ago", "29 November 2026"), on invites and the vendor questionnaire too | `packages/ui/src/lib/format-date.ts` pinned to `en-GB`; date-fns called with no locale |
| I3 | Literals in shared helpers: "Clear Filters", "Expand all", the ROI hint, risk-matrix default level and scale names | `filter-list.tsx`, `TreeExpandCollapseToggle.tsx`, `control-roi.ts`, `risk-matrix/defaults.ts` |
| I4 | Server-built English: BIA rationale, agent control-test text, agentic notifications, audit procedures, report metric labels, workflow names, audit-log action chips, dashboard activity feed | `bia-recovery-priority.ts`, `agent-control-tests.ts`, `notifications/agentic.ts`, `audit-procedure-library.ts`, … |
| I5 | Org dashboard widget titles stored in English; celebration toasts | `org-dashboard-widget-titles.ts`, `celebrations.ts` |
| I6 | Raw enum values (ACTIVE, DRAFT, ORGANIZATIONAL…), a Latin "d" in "(30d)", `auth.forgot.emailPlaceholder` still English | various, `messages/bg.json` |

### Desktop-shaped surfaces

These are not bugs in a primitive; the page was designed for a wide screen and
needs a phone layout of its own.

- Statement of Applicability (an 849 px table, no card fallback) and its print
  preview (tables clipped, no scroller).
- The control and framework template libraries (262 and 233 rows on one page,
  ~180,000 px; native 13 px checkboxes; titles truncated to ~10 characters).
- The framework requirement explorer (master/detail stacked: tapping a
  requirement changes content off-screen).
- The calendar month grid (45 px cells; events read "● П..").
- Risk correlations matrix, the RBAC permission matrix (one of six role columns
  visible), the Sankey chart (6 px labels in fit-to-view).
- The Internal Audit hub (the list starts ~1,100 px down), KPI tile rows that
  fill the first screen before any data.
- The agent detail page itself: five ungrouped actions, nine tabs, and the kill
  switch rendered as a ghost text button.
- The public vendor questionnaire: one ~7,300 px form, errors shown only at the
  top with no scroll to them (Submit appears to do nothing), 20 px radio rows,
  no progress or sticky submit.
- The shared-audit "Regarding" picker: one chip per pack item.

The full per-area lists (about 70 local defects, with file and line) are in
[docs/implementation-notes/2026-11-22-mobile-audit.md](implementation-notes/2026-11-22-mobile-audit.md),
and are the source for the Phase 3 work.

### Owner decisions (2026-11-22)

- **Detail tabs on a phone:** a scrolling strip with cues (fade, chevron, active
  tab in view, sticky), not a dropdown.
- **Header actions on a phone:** the primary action plus a "⋯" menu; a
  destructive action stays visible.
- **Assistant on a phone:** an icon in the top bar, no floating button.
- **Tracking:** an epic issue plus one issue per Phase 0–2 item and per P0 page.

## Roadmap (future direction)

The order is chosen so that each phase removes the most broken pages for the
least code, and so that nothing fixed can quietly regress.

### Phase 0 — measure, and stop it getting worse (shipped)

1. **Commit the audit harness** as `scripts/mobile-audit/`: route enumeration,
   id resolution, capture and the measurement pass, runnable against the E2E
   build with one command and producing the same report.
2. **A mobile Playwright project in the E2E suite** (iPhone 14 profile) that
   loads a fixed set of routes — one per shared primitive, plus the P0 pages —
   and asserts: nothing interactive is clipped outside a scroll container, no
   input below 16 px, the assistant button covers no control at full scroll,
   every overflowing tab bar shows a cue.
3. **A downward ratchet** on the whole-product counts (clipped elements, inputs
   under 16 px, assistant overlaps, small tap targets, Bulgarian leaks), with
   `DRIFT_ALLOWANCE` 0 in the repo's usual style: each fix lowers the baseline in
   the same diff, and a new page that breaks on a phone fails CI.
4. **Add "renders on a 360 px phone" to `docs/new-subsystem-checklist.md`** and
   the page conventions in `CLAUDE.md`, with the patterns below as the rules.

### Phase 1 — the shell and the shared primitives (shipped)

Each item is one PR in a shared component; together they fix most of the
pages in the tables above.

1. **Popover mobile drawer** stacks its content (`flex-col items-stretch`) — the
   user menu (P0 #1).
2. **Selection toolbar** gets a phone layout: count and Clear on the first row,
   the action picker and Apply full width on the second, pinned above the bottom
   inset (P0 #2).
3. **Inputs at 16 px on touch** — one coarse-pointer rule for input, select and
   textarea plus `text-base md:text-sm` in the cva variants (S4).
4. **Assistant entry point moves to the top bar on a phone** (owner decision):
   below `md` there is no floating button; an assistant icon sits in the top bar
   beside the bell and opens the same bottom sheet. Nothing on any page is
   covered, and pages need no bottom clearance. The floating button stays on
   larger screens (S1).
5. **Detail tab bar** (owner decision: keep a scrolling strip, not a dropdown): edge fades and a chevron when it overflows, the active
   tab scrolled into view, end padding so the last tab is reachable, sticky under
   the top bar on long tabs (S2).
6. **Page header** (owner decision): title and description full width below
   `sm`; on a phone the primary action (and at most one more) shows as a button
   and the rest go into a "⋯" menu; a destructive action such as "Stop agent"
   stays visible as a destructive button rather than hiding in the menu;
   actions are in reading order, primary first; `PageActions` handles a single
   wrapped child so a page cannot defeat it (S3).
7. **Filter toolbar**: secondary row wraps; active chips get a row of their own;
   "Clear filters" translated (S5).
8. **Toggle group**: labels never wrap; overflow scrolls with a cue, and a group
   of four or more becomes a select below `sm` (S6).
9. **Mobile cards**: label above value when the label is long, selection inline
   with the title, empty fields omitted, no selection on read-only lists, a
   real ellipsis, icon-only actions in a labelled "⋯" menu (S7).
10. **Bottom insets and dynamic height** on every drawer, modal and sheet (S9).
11. **Touch targets in shared chrome** reach 44 px through hit-area padding, not
    visual size: bell, brand link, breadcrumbs, back link, pager, `Checkbox`,
    `InfoTooltip`; tooltips open on tap (S10).
12. **Shell gaps**: the drawer gets its own title, the top bar gets a search
    button that opens the command palette, the toaster follows the theme and
    sits bottom-centre on a phone (S11).
13. **One back affordance per subpage**: breadcrumbs collapse to the back link
    below `md`, in a fixed position (S12).

### Phase 2 — Bulgarian chrome is Bulgarian (shipped)

1. **Back-link labels** become message keys (I1).
2. **Locale-aware dates**: `format-date.ts` takes the active locale, keeping its
   UTC pinning so server and client still render the same string; date-fns gets
   the matching locale (I2).
3. **Helper literals** move to `messages/` (I3); the risk-matrix defaults are
   translated at display time unless the tenant renamed them.
4. **Server-built text** returns codes and parameters that the client renders,
   or is rendered in the requester's locale (I4, I5).
5. **Raw enums** go through the existing label maps; the remaining `bg.json`
   values are translated (I6).
6. The existing Bulgarian-strings ratchet is extended to the strings the audit
   found, so they cannot come back.

### Phase 3 — the pages (shipped)

1. **The P0 pages first** (#3–#9 above). Shipped in #5853 and #5856.
2. **Then the local P1s, area by area** — core GRC, agents and admin, vendors /
   audits / incidents / org — each PR closing every local defect in its area and
   lowering the Phase 0 baseline.
3. **The agent detail page** gets the treatment the owner's screenshot asked
   for: one primary action plus a "⋯" menu, the kill switch as a destructive
   button, and its nine tabs grouped so a phone shows them without a hunt.

### Phase 4 — phone layouts for desktop-shaped surfaces (shipped)

For each surface in "Desktop-shaped surfaces" above, decide between a phone
layout and an honest "open this on a larger screen" notice (the process canvas
already does the latter well). Proposed:

- **Phone layout:** SoA (cards per requirement), template libraries (search
  first, paginated, a real checkbox per row), the framework explorer (drill-in
  instead of master/detail), the calendar (agenda list below `md`), the RBAC
  matrix (one role at a time), the Internal Audit hub and KPI rows (KPIs as a
  horizontal strip), the vendor questionnaire (inline errors, scroll to the
  first one, progress, sticky submit), the shared-audit "Regarding" picker (a
  combobox).
- **Larger-screen notice:** the process canvas (already), the Sankey chart and
  the correlations matrix, each with a readable summary list in its place.

### Phase 5 — "flawless", defined and held (shipped; the real-device pass skipped by owner decision)

The product is mobile-flawless when, at 360 and 390 px, in both themes and
both languages:

- the Phase 0 ratchets sit at zero and the mobile E2E project is green;
- every page's primary action is visible without horizontal movement and is at
  least 44 px tall;
- nothing interactive is clipped, covered or reachable only by hover;
- no input causes iOS zoom, no bottom control sits in the home-indicator zone;
- no English UI string appears on a Bulgarian page;
- the key phone journeys pass end to end in the mobile E2E project: sign in with
  MFA, triage a task (assign, comment, close), approve or reject an agent
  proposal, stop an agent, decide an access review, answer a vendor
  questionnaire, open a shared audit link;
- a real-device pass on iOS Safari and Android Chrome finds nothing the
  harness missed.

Every criterion but the last is held by CI today: the ratchets are at zero, the
journeys pass in the `mobile` project, and the whole-product harness runs
nightly against `main` (`.github/workflows/mobile-audit.yml`), failing and
opening an issue when a count rises. The last one was not run: on 2026-11-25
the owner decided to close Phase 5 on the automated checks alone (#5899). The
real-device checklist stays in `docs/mobile-audit.md` for whoever wants to run
it, for example after a change to the app shell.
