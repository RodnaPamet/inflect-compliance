# Roadmap Audit — 2026-05-13

> **Status: historical record (2026-05-13)** — describes the state of the system at the time of writing; kept for the record, not maintained. For current behaviour see the relevant subsystem doc in docs/.

One row per merged PR across every roadmap that shipped UI-visible work
between 2026-05-05 and 2026-05-13. **Why this exists**: structural
ratchets verify that source files contain certain class strings; they
don't verify the rendered result. We've hit three cases this week where
the ratchet was green but the feature didn't actually work (active band
yellow, lingering page searchbars, notifications-bell off-recipe). This
doc is the spot-check list so we can find the rest before users do.

## How to use

- **Status column** defaults to `?`. Fill in:
  - `OK`  — looked at it; works as claimed.
  - `BROKEN` 🚩 — claimed-but-doesn't-work. Add a one-line note in the row.
  - `PARTIAL` 🟡 — works on some surfaces / under some conditions.
  - `N/A` — the feature is structural-only (ratchet/budget/registry) and
    has no observable runtime effect, so visual audit doesn't apply.
- **Verify column** is the fastest way to tell. Usually a DOM thing
  to inspect in DevTools or a URL to load.
- Flag broken rows with 🚩 so we can grep `🚩` once you're done.
- Skip rows you're sure of — partial coverage is fine.

## Triage priority

When you find a broken row, file it into one of:

- **Visual chrome** — sidebar, top-bar, page headers, badges, buttons.
  High user-visibility; fix first.
- **List/detail surface** — DataTable, FilterToolbar, EntityListPage,
  EntityDetailLayout, modals. Medium-high.
- **Behavioural ratchet** — feature is structurally locked but the
  rendered effect is missing. Fix the call site OR convert the ratchet
  to a rendered test (Option C from the audit-lens question).
- **Already obsolete** — feature was retired by a later PR.

---

# Visible UI work (2026-05-08 onward)

## Interim Design Polish — PR-1..PR-10 (2026-05-08)

These shipped first. Foundation → Refinement → Delight.

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #182 PR-1 | Raw `text-{red,emerald,amber,…}-N` eradicated. `*-subtle` StatusBadge variants added. | Inspect any error / success / warning badge — bg/text should resolve through `--bg-success-emphasis` etc., not `bg-emerald-500`. | ? |
| #183 PR-2 | Legacy `.btn` + `.badge-*` CSS classes deleted. ~290 sites migrated. | Grep `globals.css` for `.btn`; should not exist. Inspect any tests-page result badge — should be `<StatusBadge>` markup. | ? |
| #184 PR-3 | `<Heading>` `<Eyebrow>` `<Caption>` `<TextLink>` primitives. ~280 inline `<hN>` migrated. | Inspect a page title — should be a `<Heading>` with semibold (not bold) at level 1. | ? |
| #185 PR-4 | EntityDetailLayout Wave 1 — 5 detail pages on shell (Asset, Framework, Access review, Audit cycle, Audit pack). | Load `/t/<slug>/assets/<id>` — back link + title + meta + tabs all from shell. | ? |
| #186 PR-4b | EntityDetailLayout Wave 2 — Risk, Task, Vendor, Policy, Test run migrated. Total 11 pages on shell. | Load `/t/<slug>/risks/<id>`, `/policies/<id>`, etc. — same shell shape. | ? |
| #188 PR-5 | Action label vocab — `Create / Add / Link` only; no leading `+ `. | Open any "create" button — label starts with `Create` (or `Add` for children, `Link` for cross-entity). | ? |
| #187 PR-6 | `<Card density="comfortable\|compact\|none">` primitive. 66 drift sites consolidated. | Inspect a dashboard card — `p-6` (comfortable) or `p-4` (compact); no `p-5` / `p-8`. | ? |
| #190 PR-7 | DataTable row hover deeper bg + sort headers focus-visible + selected-row brand left edge + pagination footer 24px gradient fade. | Hover a controls table row → solid bg (not 7% alpha). Tab into a sort header → ring appears. | ? |
| #189 PR-9 | Search placeholder vocab `Search {entityPlural}…`; trailing ` (Enter)` hint removed. | Inspect any list page's search input placeholder. Note: this entire mechanic was later retired by R14-PR7 + #443. | N/A (retired) |
| Polish PR-4..10 #218-225 | Various polish bundle: MetaStrip primitive (#220), no-nested-cards (#224), hover/focus ratchet (#222), motion language ratchet (#223), state-coverage ratchet (#225). Some overlap with Elevation Package. | Mostly ratchet-only. | ? |

## v2 Premium Polish — 15 PRs #193–207 (2026-05-09)

Foundation → Layout → Cards → Dashboard → Surfaces → Capstone.

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #193 v2-PR-1 | Button variant cull: 7 → 5 (`primary\|secondary\|ghost\|destructive\|destructive-outline`). | Grep for `variant="outline"` or `variant="success"` — should be 0 hits. | ? |
| #194 v2-PR-2 | Semantic spacing tokens `tight\|compact\|default\|section\|page`. Raw `gap-{2..6}` codemodded. | Grep `gap-section`, `space-y-default` — many hits across pages. | ? |
| #195 v2-PR-3 | StatusBadge `size="sm\|md"` + `tone="subtle\|solid"`; pill-only; className overrides eradicated. | Inspect any StatusBadge — `rounded-full`, no `rounded-md` overrides. | ? |
| #196 v2-PR-4 | Motion language: 150ms ease-out, bg/border only, no transform/shadow. Focus ring unified. Card hover = border darkens. | Hover a clickable card — border tone shifts; no lift, no shadow. | ? |
| #197 v2-PR-5 | `<PageHeader>` primitive — `eyebrow / title / description / actions / tabs / breadcrumbs`. | Inspect any list page header — `<PageHeader>` mounted (not hand-rolled). | ? |
| #198 v2-PR-6 | Layout shell consolidation. `<DashboardLayout>` ships for 7 dashboard pages; `ListPageShell` privatised. | Load `/t/<slug>/dashboard` — wrapped in `<DashboardLayout>`. | ? |
| #199 v2-PR-7 | `<FilterToolbar>` `primary` + `secondary` slots. Mobile collapse to "Filters (N)" popover. | Resize to mobile on a list page — filter chips collapse to popover. | ? |
| #200 v2-PR-8 | Card chassis: 8 → 3 (`<MetricCard>`, `<ChartCard>`, `<ListCard>`). KpiCard / ProgressCard / DonutChart / TrendCard etc. retired as standalone. | Dashboard — every tile is one of the 3 chassis. | ? |
| #201 v2-PR-9 | Card elevation: `flat\|raised\|floating`; depth via bg-tokens, no shadows. | Inspect a card — no `shadow-(sm\|md)` classes on `<Card>` consumers. | ? |
| #202 v2-PR-10 | Hero readiness metric at dashboard top: 72px tabular-nums + delta chip + CTA. 4-zone rhythm (Masthead → Story → Detail → Footer). | Load `/t/<slug>/dashboard` — big 72px number at top. | ? |
| #203 v2-PR-11 | `<NextBestActionCard>` replaces 6-button Quick Actions grid. Priority CTA + 3 muted quick-add links. | Dashboard — single primary CTA card, not 6-button grid. | ? |
| #204 v2-PR-12 | List header trio (eyebrow + title + description). DataTable rows with `onRowClick`: chevron-right + brand left-edge on hover. | Hover a row on `/t/<slug>/controls` — chevron appears, brand left edge. | ? |
| #205 v2-PR-13 | `<MetadataBar>` + `<TabSection>` on detail pages. Horizontal `Label: value · …` strip ≤6 visible + "+N more". | Load any detail page — single horizontal metadata strip below the header. | ? |
| #206 v2-PR-14 | Detail action hierarchy: ≤2 visible buttons + 1 overflow menu. | Inspect detail header — at most 2 buttons plus a kebab. | ? |
| #207 v2-PR-15 | Skeleton fidelity (`<SkeletonTable>`, `<SkeletonDetailHeader>`, `<SkeletonDashboard>`). EmptyState `size="sm\|md"`. `docs/design-system.md`. | Slow network throttle → load a list page; skeleton matches table shape, not generic blocks. | ? |

## v2 Elevation Package — 10 PRs #227–236 (2026-05-09)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #227 PR-1 | `<MetaStrip>` adopted across all 11 detail pages. Status mappings extracted. | Load any detail page — single horizontal `MetaStrip` below header. | ? |
| #228 PR-2 | Controls detail page decomposed; `EditControlModal` extracted. 1506 → 1384 lines. Page-size floor 1430. | Open a control — "Edit" button opens a separate modal component. | ? |
| #229 PR-3 | Sidebar polish — `.nav-link` CSS retired; inline tokens for active/idle states. | Grep `globals.css` for `.nav-link` — should not exist. | ? |
| #235 PR-4 | Modal/sheet action-order ratchet: last `<Button>` must be primary/destructive. | Open any modal → primary action is on the right. | ? |
| #230 PR-5 | `<EmptyState>` adoption ratchet. Vendor-templates migration. | Empty vendors-templates list → personality EmptyState. | ? |
| #232 PR-6 | OnboardingWizard semantic-token migration; STEPS gradient classes retired. | Sign up flow — wizard uses brand-default, not raw indigo. | ? |
| #233 PR-7 | DonutChart consumes `var(--token)` directly via SVG stroke/fill. | Coverage donut — segments use `--bg-success-emphasis` etc. | ? |
| #231 PR-8 | RadioGroup migration on org/tenants/new; form-drift ratchet. | Org tenant creation form — radio inputs styled via RadioGroup. | ? |
| #234 PR-9 | SoAPrintView semantic-token migration. | Print preview of SoA report — no raw slate colors. | ? |
| #236 PR-10 | Always-visible sort affordance on sortable columns (opacity-30 idle → 100 active). | Hover a sort header → arrow visible at 60% opacity. | ? |

## Roadmap-2 Persistent Chrome — PRs #237–250 (2026-05-09–10)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #237 PR-1 | AppShell + OrgAppShell unified into one variant-driven primitive. | Load `/t/<slug>/dashboard` and `/org/<slug>/dashboard` — same shell skeleton. | ? |
| #238 PR-2 | Persistent top chrome — breadcrumbs + search anchor + identity pill. | Top of any tenant page — breadcrumbs + ⌘K + tenant pill render above content. | ? |
| #239 PR-3 | Sidebar eyebrows + inline command opener. | Sidebar section header reads as eyebrow; `K` opens palette. | ? |
| #240 PR-4 | Editorial descriptions on every list page header. | Load `/t/<slug>/controls` — title has a description sentence beneath. | ? |
| #241 PR-5 | Right-rail master-detail layout on detail pages. | Load `/t/<slug>/risks/<id>` — master content + right-rail panel. | ? |
| #242 PR-6 | `<FormSection>` primitive + risks-modal proof-of-pattern. | Risk create modal — fields grouped into `<FormSection>` blocks. | ? |
| #243 PR-7 | Inline status-pill construction killed in app code. | Grep `text-emerald` co-located with status text — should be replaced with `<StatusBadge>`. | ? |
| #244 PR-8 | lucide-react footprint frozen; ratchet on new imports. | Add a new file importing `lucide-react` — ratchet fails. | N/A |
| #245 PR-9 | `useToast()` hook + vocabulary discipline. | Trigger any save action → toast appears with canonical copy. | ? |
| #246 PR-10 | Skeleton-shape parity ratchet. | Slow load any list — skeleton mirrors final table layout. | ? |
| #247 PR-11 | Docs label + chrome simplification + Calendar-style subtitles. | Sidebar — "Docs" item appears; chrome quieter. | ? |
| #248 PR-12 | Detail section spacing + reports composition. | Detail page sections — consistent `space-y-section` rhythm. | ? |
| #249 PR-13 | Breadcrumbs lifted into top chrome (every page). | Top of every page shows breadcrumb trail. | ? |
| #250 PR-14 | Sidebar label rename — Calendar→Review, Audits→Audit, Task→Plan; Policy promoted to Management. | Sidebar item labels. | ? |

## Roadmap-3 Foundations — PRs #251–260 (2026-05-10)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #251 PR-1 | `<PageActions>` primitive + `size="sm"` lock on every page-header button. | Inspect any page-header action cluster — buttons are size sm. | ? |
| #255 PR-2 | Icon-size discipline (sm=14, md=16, lg=20). w-3 outliers rounded up. | Grep `w-3` in icon classes — should be 0. | ? |
| #253 PR-3 | Hover-state language unification (two canonical recipes). | Any clickable card hover — `bg-bg-muted/50` or border darken. | ? |
| #254 PR-4 | Focus-ring standardisation. | Tab through any page — every focusable has 2px brand ring. | ? |
| #256 PR-5 | `<CardHeader>` primitive + risks-detail proof-of-pattern. | Risk detail panel headers use `<CardHeader>`. | ? |
| #259 PR-6 | Empty-state copy tone — "No X yet" titles, no period. | Empty list — title reads "No risks yet" (not "No risks found."). | ? |
| #257 PR-7 | Modal width tokens (lock primitives, ban overrides). | Open any modal — width comes from `<Modal size>` prop, not className. | ? |
| #258 PR-8 | Single canonical tab pattern. | Inspect tabs on any page — same chip shape, focus ring, indicator. | ? |
| #252 PR-9 | Mid-scale raw-numeric spacing banned in app pages. | Grep `gap-5`, `space-y-7` in src/app — should be 0. | ? |
| #260 PR-10 | Per-resource dashboard masthead discipline (Risks/Controls/Vendors/etc.). | Each resource list page top — same hero/masthead shape. | ? |

## Roadmap-4 Type & Copy — PRs #261–270 (2026-05-10)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #261 R4-PR1 | `text-content-muted` / `text-content-subtle` 4-tone vocab lock. No raw greys in `src/app`. | Grep `text-slate-`, `text-gray-` in src/app — should be 0 (allowlisted exceptions documented). | ? |
| #262 R4-PR3 | Eyebrow weight uniformity. Intrinsic styling locked in primitive; 20+ consumer overrides stripped. | Inspect any eyebrow — `text-xs font-semibold uppercase tracking-wider text-content-muted`. | ? |
| #263 R4-PR7 | Tab-count visual lockdown. Private `<TabCount>` helper. `tabular-nums` for digit width stability. | Open a detail page with tab counts — counts use tabular digits. | ? |
| #264 R4-PR4 | `<RequiredMarker>` primitive. 8 sites migrated. Screen-reader literal-"asterisk" fixed. | Required field → red asterisk; screen reader announces `(required)` not "asterisk". | ? |
| #265 R4-PR2 | Decorative emoji subtraction. 51 emojis stripped from `messages/{en,bg}.json`. | Look at any toast / empty-state copy — no decorative emojis. | ? |
| #266 R4-PR8 | Heading-primitive discipline. 7 raw `<hN>` tags migrated. Allowlist 2 entries. | Grep `<h1`, `<h2` in src/app — only 2 allowlisted hits. | ? |
| #267 R4-PR5 | `format-date` import alias killed (`formatDateTime as formatDate`, `formatDate as formatDateForDisplay`). | Grep `from '@/lib/format-date'` — no `as <name>` aliases. | ? |
| #268 R4-PR6 | Truncation max-width tokens `trunc-tight\|default\|loose` (14/28/40 ch). 7 sites migrated. | Inspect a truncated cell — `max-w-trunc-default`, not `max-w-[28ch]`. | ? |
| #269 R4-PR9 | Destructive-action vocab — 8 canonical verbs. | Open any "Delete X" dialog — confirm button starts with one of `Delete\|Remove\|Revoke\|Discard\|Archive\|Unlink\|Detach\|Reject`. | ? |
| #270 R4-PR10 | Link styling — new `link` tone (underline on hover) distinct from `brand` (no underline). | Hover an inline link in body copy → underline appears. | ? |

## Roadmap-5 Edges & Rhythm — PRs #271–282 (2026-05-10)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #271 R5-PR1 | Raw `glass-card` eradicated. `<Card>` primitive canonical. | Grep `className="glass-card` in src/app — only inside `<Card>` primitive. | ? |
| #281 R5-PR2 | Card padding lockdown — three rungs (`p-4\|p-6\|none`). | Inspect any card — `p-4` (compact) or `p-6` (comfortable). | ? |
| #273 R5-PR3 | `rounded-xl` / `rounded-2xl` eradicated + radius scale ratchet. | Grep `rounded-2xl` in src — should be 0 (allowlisted exceptions documented). | ? |
| #275 R5-PR4 | Card shadow discipline — depth via bg-token, not shadow. | Inspect any card — no `shadow-md` / `shadow-lg`. | ? |
| #277 R5-PR5 | Hover recipe — two canonical (`hover:bg-bg-muted/50` row/card, `hover:bg-bg-muted` click target) + semantic-state hovers. | Hover any row — `bg-bg-muted/50`. Hover any click target — `bg-bg-muted`. | ? |
| #278 R5-PR6 | Skeleton tone unified. | Slow load → skeleton blocks use `bg-bg-elevated/60`. | ? |
| #279 R5-PR7 | Inline form action-cluster ordering. | Cancel left, primary right on every inline form. | ? |
| #274 R5-PR8 | Modal + Sheet collapsed to `rounded-lg`. | Open any modal → `rounded-lg`, not xl. | ? |
| #280 R5-PR9 | Page-section rhythm convention (`space-y-section` between top-level regions, `space-y-default` within). | Inspect a list page — header → toolbar → table use `space-y-section`. | ? |
| #276 R5-PR10 | Border tone discipline + budget ratchet (3 semantic tones). | Inspect form fields — `border-border-subtle`. Card outer — `border-border-default`. | ? |
| #282 R5-hotfix | Server-safe cardVariants split. | Server components import card-variants (no `'use client'` taint). | N/A |

## Roadmap-6 States & Motion — PRs #283–297 (2026-05-10)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #283 R6-PR1 | `animate-slideIn` retired. | Grep `animate-slideIn` — should be 0. | N/A |
| #284 R6-PR2 | Unified disabled-state grey (`opacity-50 cursor-not-allowed`). | Disable a button — same grey across all variants. | ? |
| #285 R6-PR3 | Focus-ring offset discipline. | Inspect focused button — `ring-offset-2 ring-offset-bg-default`. | ? |
| #286 R6-PR4 | Renegade `bg-bg-*` tokens eradicated. | Grep `bg-bg-` in src/app — only canonical token names. | ? |
| #287 R6-PR5 | Empty-state title vocabulary. | Empty lists — "No X yet" / "Nothing matches filters" only. | ? |
| #288 R6-PR6 | Loading-text typographic discipline. | Any loading skeleton — text uses `text-content-muted`. | ? |
| #289 R6-PR7 | Page-wrapper fade-in completeness. | Hard-reload any page — content fades in (not pop). | ? |
| #290 R6-PR8 | Cancel button variant discipline (`secondary` only). | Open any modal Cancel button → `secondary` variant. | ? |
| #291 R6-PR9 | Semantic content-tone opacity discipline. | Inspect muted text — no `opacity-*` overrides on `text-content-muted`. | ? |
| #292 R6-PR10 | StatusBadge `pending` variant retired. | Grep `variant="pending"` — should be 0. | N/A |
| #293 R6-hotfix | cva-primitives + hover-recipe ratchet unbreaks main. | Ratchet | N/A |
| #294 R6-hotfix2 | Server-component cardVariants import migrated. | Server pages don't import client cardVariants. | N/A |
| #295 R6-fu1 | Notify moved into Admin as pill next to Risk Matrix. | Sidebar — no top-level "Notify"; lives under Admin. | ? |
| #296 R6-fu2 | Admin sidebar item replaced with gear icon by ThemeToggle. | Sidebar footer — gear icon by theme toggle. | ? |
| #297 R6-fu3 | Sign Out stacked as icon below Theme; aligned with role line. | Sidebar footer — Sign Out as icon. | ? |

## Roadmap-7 Composition — PRs #298–307 (2026-05-10)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #298 R7-PR1 | Primary action budget — 1 primary per file (overrides in budget map). | Inspect any page — at most 1 primary-variant button visible. | ? |
| #299 R7-PR2 | Border tone subtle-by-default. Budget 133 → 120. | Inspect form fields — `border-border-subtle`. | ? |
| #300 R7-PR3 | Single H1 per page (5 admin loading-branch H1s demoted to H2). | Inspect any page DOM — exactly one `<h1>`. | ? |
| #301 R7-PR4 | FilterToolbar coverage registry. | Every list page mounts `<FilterToolbar>` (or is in EXEMPTIONS). | ? |
| #302 R7-PR5 | MetadataBar detail coverage registry. | Detail pages with `migrated: true` mount MetadataBar. | ? |
| #303 R7-PR6 | Empty/loading primitive-only — no inline `<div>No X yet</div>`. | Empty list — `<EmptyState>` mounted, not raw div. | ? |
| #304 R7-PR7 | FormField coverage budget (34 raw labels max). | Raw `<label htmlFor>` in src/app should be ≤34. | N/A |
| #305 R7-PR8 | No inline tab strips. Forbidden recipe `text-xs px-3 py-1.5 rounded-md`. | Inspect any tab strip — `<Tabs>` primitive, not hand-rolled. | ? |
| #306 R7-PR9 | EntityDetailLayout coverage registry (8 adopted, 7 pending). | Detail pages with `migrated: true` mount the layout. | ? |
| #307 R7-PR10 | Round completion + icon-size shorthand ratchet (catches `size-3`). | Grep `size-3` on icons — should be 0. | N/A |

## Roadmap-8 Visible Uplift — PRs #308–322 (2026-05-11)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #308 R8-PR1 | `<InlineEmptyState>` primitive. | Pages with secondary empty regions use the primitive. | ? |
| #309 R8-PR2 | 14 inline empty divs migrated to InlineEmptyState across 7 pages. | Inspect filter-cleared states — same shape. | ? |
| #310 R8-PR3 | EntityDetailLayout sweep — coverage to 10/14. | More detail pages migrated. | ? |
| #311 R8-PR4 | MetaStrip ratchet correction (was tracking wrong primitive). | Ratchet only. | N/A |
| #312 R8-PR5 | Badge density audit + tone-subtle demotions on Findings/Audits. | Findings + Audits list badges — `tone="subtle"`. | ? |
| #320 R8-PR6r | Ratchet precedence: visual > count. | Doc-only. | N/A |
| #321 R8-PR7r | InlineEmptyState primitive contract lock. | Ratchet only. | N/A |
| #315 R8-PR8 | DashboardLayout coverage registry. | Dashboard pages mount the shell. | ? |
| #316 R8-PR9 | Coverage page → DashboardLayout migration. | Load `/t/<slug>/coverage` — `DashboardLayout` shell. | ? |
| #317 R8-PR10 | FormField ratchet narrowed (34 → 2). | Ratchet only. | N/A |
| #318 R8-PR11 | PageActions / ActionCluster primitive coverage lock. | Page header actions mount via primitive. | ? |
| #319 R8-PR12 | Skeleton-pulse budget + round completion ratchet. | Skeleton blocks use shimmer-sweep, not pulse. | ? |
| #322 R8-hotfix | Coverage `adopted: true` flag flip. | Ratchet only. | N/A |

## Roadmap-9 Obsession — PRs #323–333 (2026-05-11)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #323 R9-PR1 | PageHeader adoption registry + 3 first migrations. | 3 list pages mount `<PageHeader>`. | ? |
| #330 R9-PR2 | CardHeader adoption + 4 migrations. | 4 cards mount `<CardHeader>`. | ? |
| #331 R9-PR3 | Tab primitive adoption registry. | Inspect tabs — single primitive. | ? |
| #325 R9-PR4 | Table unification on Controls reference shape — primitive-level circular checkbox + hover recipe locked + first-column registry seeded. | Inspect Risks/Frameworks/Audits checkbox — circular. Hover row — same recipe. | ? |
| #329 R9-PR5 | Inline subtitle pattern budget (37 max). | Hand-rolled subtitle divs ≤37 across src/app. | N/A |
| #328 R9-PR6 | 3 button-shape `buttonVariants()` → `<Button>` migrations. | Inspect the 3 sites — render `<Button>`. | ? |
| #326 R9-PR7 | Cancel button size parity ratchet. | Modal Cancels — same size as primary. | ? |
| #327 R9-PR8 | HeroMetric canonical-home lock — only dashboard masthead. | Grep `<HeroMetric>` — only one site (dashboard). | ? |
| #332 R9-PR9 | primary:secondary ratio direction lock (0.91 floor). | Ratchet. | N/A |
| #333 R9-PR10 | Round completion + 9-item obsession checklist. | Ratchet. | N/A |
| #324 R9-PR11 | StatusBadge default tone → `subtle`. | Status pills on every page — bg neutral, text tinted (not solid). | ? |

## Roadmap-10 Tables-and-Gear — PRs #334–345 (2026-05-11)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #336 R10-PR4 | First-column rule reframed — canonical id per entity (Risks=title, Frameworks=name, Controls=code, Audits dropped). | Open every list page — column 0 is the canonical id for that entity. | ? |
| #339 R10-PR5 | First-column registry expansion: 6 more pages (Assets/Evidence/Policies/Tasks/Findings/Vendors). | Same — canonical id in column 0. | ? |
| #341 R10-PR9 | Detail-page `back={…}` prop ban. Readiness page migrated to breadcrumbs only. | Detail page top — breadcrumbs only (no parallel back-button). | ? |
| #342 R10-PR10 | StatusBadge brand-orange variant ban. | Grep `variant="brand"` in StatusBadge consumers — should be 0. | N/A |
| #334 R10-PR1 | admin/rbac Members raw `<table>` → DataTable. | `/admin/rbac` members table renders via `<DataTable>`. | ? |
| #335 R10-PR2 | access-reviews detail roster raw `<table>` → DataTable. | Access-review detail roster — DataTable. | ? |
| #338 R10-PR3 | Raw `<table>` ban ratchet + 7-entry EXEMPTIONS registry. | Ratchet. | N/A |
| #340 R10-PR8 | Column-visibility gear coverage ratchet. | Every list page has a gear above the table. | ? |
| #337 R10-PR6 | `useColumnsDropdown` shared hook — 4 sites migrated. | Inspect gear behavior — same dropdown shape on every page. | ? |
| #345 R10-PR7 | Gear universal mount — 4 missing pages (Assets/Vendors/Tasks/Frameworks). | Those 4 pages now have the gear. | ? |
| #343 R10-PR11 | Findings gear standalone mount (no toolbar). | `/findings` — gear above table next to ViewToggle. | ? |
| #344 R10-PR12 | Round completion + 9-item obsession checklist. | Ratchet. | N/A |

## Roadmap-11 Delight — PRs #346–358 (2026-05-11)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #346 R11-PR1 | EmptyState personality on 8 list pages — 3 vocabularies (no-records / no-results / missing-prereqs). | Empty list with filters cleared → "Clear filters" CTA. | ? |
| #347 R11-PR2 | Skeleton shimmer-sweep — gradient overlay (`translateX -100% → 100%`) on every skeleton block. | Slow load — skeleton "sweeps" left-to-right. | ? |
| #348 R11-PR3 | Error boundaries route through `<ErrorState>`. | Trigger an error — alert-role + retry + secondary action. | ? |
| #349 R11-PR4 | Button press-feedback: `active:scale-[0.97]`. | Click any button — visible compression. | ? |
| #350 R11-PR5 | Animation language lock — durations bounded to 9-value set. | Ratchet. | N/A |
| #351 R11-PR6 | Controls detail tasks sub-table → DataTable. | Open a control → tasks sub-table is DataTable. | ? |
| #352 R11-PR7 | Vendors detail documents sub-table → DataTable. | Open a vendor → documents sub-table is DataTable. | ? |
| #353 R11-PR8 | Tasks detail links sub-table → DataTable. | Open a task → links sub-table is DataTable. | ? |
| #354 R11-PR9 | Mobile readiness baseline — viewport metadata; `maximumScale: 1` banned. | View source on any page → `<meta name="viewport">` present. | ? |
| #355 R11-PR10 | `<ChecklistCard>` primitive — onboarding / progress-aware. | Onboarding wizard — checklist card. | ? |
| #356 R11-PR11 | Chart polish — `ease-out` on DonutChart segment transitions. | Hover a donut → segment transition smooths. | ? |
| #357 R11-PR12 | Round completion + 13-item obsession checklist. | Ratchet. | N/A |
| #358 R11-hotfix | Findings columns-dropdown EXEMPTION dropped after gear shipped. | Ratchet. | N/A |

## Roadmap-12 Visible Uniformity — PRs #359–361 (2026-05-11)

Renamed early; the "R12" in commits #359-361. Separate from R12 Lickable Sidebar (#379+).

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #359 R12-PR1 | Selection column default-on. Tasks square checkbox → DataTable's circular Radix Checkbox. | Open `/tasks` — circular checkbox column. | ? |
| #360 R12-PR2 | Row-height uniform (~44px). Policies title cell description dropped. | Every list page rows — same height. | ? |
| #361 R12-PR3 | Card-scroll contract — `fillBody` on every DataTable in `<ListPageShell.Body>`. | Resize viewport — only table body scrolls, header/footer stay. | ? |

## Earlier "R13" — table + nav refresh — PRs #362–377 (2026-05-11–12)

Naming reuse; separate from R13 Living Sidebar.

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #362 R13-PR1 | Canonical `<TableTitleCell>` primitive on every list page. | Inspect title cell on every page — same shape. | ? |
| #363 R13-PR2 | Row opens on double-click. Unified hover affordance. | Double-click a row → detail page. | ? |
| #364 R13-PR3 | Legacy `.data-table` CSS mirrors DataTable visual contract. | Old data-table sites visually match new ones. | ? |
| #365 R13-PR4 | Sidebar — theme toggle dropped; sign-out next to admin; tighter footer. | Sidebar footer — admin + sign-out adjacent; theme moved to user menu. | ? |
| #366 R13-PR5 | Admin tables — drop double-card wrap to match Controls. | Admin pages — single card containment around tables. | ? |
| #367 R13-PR6 | 3 `cardVariants` wraps R13-PR5 missed; ratchet hardened. | Admin pages — no double-card wrap. | ? |
| #368 R13-PR7 | Tenant sidebar restructure — Board + Workspace / Comply / Manage sections. | Sidebar section labels. | ? |
| #369 R13-PR8 | Admin/reports DataTable — drop `text-xs` overrides. | Admin/reports table — `text-sm` cells. | ? |
| #370 R13-PR9 | Audits — pill-shaped Frameworks link in page header. | `/audits` page header — Frameworks link is a pill. | ? |
| #371 R13-PR10 | Admin — audit log moved to own page; policy templates tab dropped. | Admin nav — audit log as separate item. | ? |
| #372 R13-PR11 | Sidebar — "Workspace" section renamed "Govern". | Sidebar section labels. | ? |
| #373 R13-PR12 | Sidebar — Framework item dropped from Manage section. | Manage section — no Framework item. | ? |
| #374 R13-PR13 | Table row hover brand-edge accent on the first cell (was leaking elsewhere). | Hover a row → brand left edge on the FIRST cell. | ? |
| #375 R13-PR14 | Single click toggles row selection; double-click navigates. | Single-click on row → checkbox toggles; double-click → detail. | ? |
| #376 R13-PR15 | Row hover edge + click-to-select on title cell. | Click title cell → row selects. | ? |
| #377 R13-PR16 | Sidebar — Audit moved from Manage to top of Comply. | Sidebar — Audit appears under Comply, not Manage. | ? |

## Roadmap-12 Lickable Sidebar — PRs #379–390 (2026-05-12)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #379 R12-PR1 | `<NavItem>` primitive extracted. | Grep `nav-item.tsx` — primitive file exists; SidebarNav imports it. | ? |
| #380 R12-PR2 | Geometry tokens locked — 44px min-h, px-3 py-2.5, gap-compact, rounded-lg, 18×18 icon. | Inspect a sidebar row in DevTools — 44px tall. | ? |
| #381 R12-PR3 | Section header chiselled-in (unmarkable, crisp). | Try to select section-header text with cursor — fails. | ? |
| #382 R12-PR4 | Default-state vocabulary lock. | Hover an idle sidebar row — `text-content-emphasis`. | ? |
| #384 R12-PR5 | Brand-gradient band replaces full-row hover. | Hover a sidebar row — 3px brand band on left, no full-row tint. | ? |
| #386 R12-PR6 | Active state conviction — text-content-emphasis + brand-subtle bg + opacity-100 band + font-medium. | Active sidebar row — distinct, brand-subtle bg, medium weight. | ? |
| #387 R12-PR7 | Focus-visible keyboard story — 2px ring at `--ring` with offset. | Tab into sidebar — ring around row. | ? |
| #388 R12-PR8 | Badge breathing — `animate-in fade-in duration-300`. Tabular-nums for stable digits. | First load with calendar count — count fades in. | ? |
| #389 R12-PR9 | Icon discipline locked. | Inspect sidebar icon — 18×18, flex-shrink-0. | ? |
| #390 R12-PR10 | Capstone bundle ratchet + rendered test + docs. | Ratchet. | N/A |

## Roadmap-13 Living Sidebar — PRs #391–402 (2026-05-12)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #391 R13-PR1 | Secondary brand tokens — electric blue METRO, deep navy light. | Inspect `--brand-secondary-default` in DevTools on both themes. | ? |
| #392 R13-PR2 | 3-stop gradient on band (default → muted highlight → emphasis) + soft outer glow. | Hover band — gradient + halo visible. | ? |
| #393 R13-PR3 | `nav-band-shimmer` 4s ease-in-out infinite background-position pan. | Hover band → slow pulse of brand light along its length. | ? |
| #394 R13-PR4 | Active band swaps to navy (`!` important on from/via/to). | Active row band — navy. **NOTE 2026-05-13**: swapped from navy to `--bg-page` in [PR #455 + #463](https://github.com/h0mele55/inflect-compliance/pull/463). | OK (superseded) |
| #395 R13-PR5 | Active label → `text-[var(--brand-default)]`. Yellow letters METRO, orange light. | Active row label — brand-colored letters. | ? |
| #396 R13-PR6 | Glossy top-edge `::after` highlight (white @ 8% METRO / 70% light). | Hover row → faint top-edge gloss line. | ? |
| #397 R13-PR7 | Inset bevel shadow on hover via `--nav-bevel-shadow`. | Hover row → bottom-edge concavity. | ? |
| #398 R13-PR8 | Press feedback `active:translate-y-px` + motion-language exempt. | Mousedown a sidebar row → row drops 1px. | ? |
| #399 R13-PR9 | Band reaches on hover (top-1.5→top-1, w-3px→w-4px). | Hover row → band geometry expands. | ? |
| #400 R13-PR10 | Section divider as `::before` linear-gradient (transparent → border-subtle → transparent). | Inspect sidebar between sections — soft fade divider. | ? |
| #401 R13-PR11 | Active row bg → radial-gradient from secondary-subtle fading right. | Active row — navy wash leaking from left edge. | ? |
| #402 R13-PR12 | Capstone bundle + rendered + docs. | Ratchet. | N/A |

## Security + dependabot bumps (#403–#424, 2026-05-12)

Not user-visible but worth noting all merged. CodeQL config fix, npm audit gate moderate+, security clearances, dependency bumps. Mostly green-belt work.

## Roadmap-14 Living Top-Bar — PRs #425–437 (2026-05-12)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #425 R14-PR1 | `<NavBar>` primitive + slot architecture (left/center/right). | Inspect top chrome — three-slot layout. | ? |
| #426 R14-PR2 | Geometry tokens — `NAV_BAR_HEIGHT` 64px, padding, gap, position, surface. | Top bar height — 64px. | ? |
| #427 R14-PR3 | Animated brand mark — 32×32 with 3-stop gradient + glow + 6s `nav-brand-pulse`. | Brand mark in top-left — visibly pulses. | ? |
| #428 R14-PR4 | `<TenantSwitcher>` popover replaces passive identity pill. Reads memberships from JWT. | Click tenant name → popover with switcher. | ? |
| #429 R14-PR5 | `<UserMenu>` — avatar, name+email, theme row, sign-out. | Click avatar → dropdown with theme + sign-out. | ? |
| #430 R14-PR6 | `<SearchAnchor>` ⌘K pill in centre slot. | Centre of top bar — search pill with `⌘K` hint. **NOTE 2026-05-12**: SearchAnchor was retired in PR #440. The sidebar `K` pill is now the only search affordance. | OK (retired) |
| #431 R14-PR7 | Kill per-page searchbars (7 inputs across 6 files). | List pages — no in-page search input. | ? |
| #432 R14-PR8 | `<NotificationsBell>` — fetches `/api/notifications`, bg-error-emphasis badge. | Top bar — bell with red badge when unread. | ? |
| #433 R14-PR9 | `<EnvironmentBadge>` — null on prod, amber STAGING / red DEV (client hostname detection). | Visit staging URL → "STAGING" badge in top-left. | ? |
| #434 R14-PR10 | Living chrome — right-edge radial brand wash + `::after` gloss + `::before` fading hairline. | Inspect top bar — subtle brand wash on right side. | ? |
| #435 R14-PR11 | Shared `NAV_BAR_SLOT_PRESS` recipe across all slots. | Click brand mark / switcher / bell / avatar → same press-down feedback. | ? |
| #436 R14-PR12 | Mobile parity — drop dual chrome, breadcrumbs hidden <md, switcher hidden <sm. | Resize to mobile — single top bar, hamburger appears. | ? |
| #437 R14-PR13 | Capstone bundle + rendered + docs. | Ratchet. | N/A |
| #438 R14-fix | sidebar-state-language ratchet drift fix. | Ratchet. | N/A |
| #439 R14-hotfix | Thread session data via props instead of useSession() (codebase has no SessionProvider). | Site loads without "Cannot destructure data of useSession" error. | ? |

## Searchbar removals + palette extensions (#440–443, 2026-05-12)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #440 | Retire SearchAnchor from top bar + remove last modal searchbar (SoA picker). | Top bar centre — empty. Sidebar `Search` pill is the only entry point. | ? |
| #441 | Wire assets into command palette. | Press `⌘K` → search for an asset by name or externalRef → result appears. | ? |
| #442 | Tasks + tests in palette + allow single-char queries. | `⌘K` → `1` → results for any entity ID starting with 1. Tasks + tests appear. | ? |
| #443 | Kill FilterToolbar text-search on every list page. | Every list page — no text-search input in the toolbar. Only filter dropdowns. | ? |

## Roadmap-15 Stardust Sidebar — PRs #444–453 (2026-05-12)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #444 R15-PR1 | Stardust particle trail — 3 white radial gradients stacked on linear gradient. Decreasing alpha (0.9/0.5/0.2). | Hover band → three faint white particles fade trail along the band. | ? |
| #445 R15-PR2 | Asymmetric halo breath — 6s `filter: brightness()` pulse. Mismatched with 4s shimmer. | Hover band → slow brightness pulse, never re-sync with shimmer. | ? |
| #446 R15-PR3 | Reveal sweep — 450ms `clip-path: inset(100% 0 0 0) → inset(0)` on hover-enter. | Hover engage → band "draws itself" top-to-bottom over 450ms. | ? |
| #447 R15-PR4 | Active starburst — 700ms `box-shadow` bloom on row engage. | Click to navigate → active row band blooms outward briefly. | ? |
| #448 R15-PR5 | Per-row drift — deterministic-hash CSS-var delay on shimmer + halo-breath. | Hover several sidebar rows — each band's phase is different. | ? |
| #449 R15-PR6 | Iridescent gradient border on hover — 3s ease-in-out outline-color cycle. | Hover row → 1px outline cycles brand colors. **NOTE 2026-05-13**: REMOVED in [PR #454](https://github.com/h0mele55/inflect-compliance/pull/454). | OK (reverted) |
| #450 R15-PR7 | Liquid bg sweep — 1.2s diagonal gradient pan across row body. | Hover row → light sweep across the row body. | ? |
| #451 R15-PR8 | Magnetic letter spacing — `group-hover:tracking-wide` (0 → 0.025em) over 200ms. | Hover row → label letters open subtly. | ? |
| #452 R15-PR9 | Outer brand-coloured aura — `0 0 12px 2px var(--nav-row-aura-color)` stacked ahead of bevel. | Active row → soft navy halo around the row. | ? |
| #453 R15-PR10 | Weighty press feedback — `active:scale-[0.99]` alongside translate. | Mousedown a row → row both drops AND compresses. | ? |

## Post-R15 fixes (2026-05-13)

| PR | Claim | Verify | Status |
|----|-------|--------|--------|
| #454 | R15-PR6 iridescent outline cycle removed by user request. | Hover row — no perpetual outline color cycle. | OK |
| #455 | Active band tone swap (v1) — `before:from/via/to-[var(--bg-page)]!` utility overrides. | **BROKEN as written** — utility classes don't override arbitrary `before:bg-[…]`. Superseded by #463. | 🚩 OK (superseded) |
| #456 #457 #458 #459 #461 #462 | Stale-ratchet cleanup batches + tsconfig false-start revert. | Ratchet work. | N/A |
| #460 | react-virtualized-auto-sizer 1 → 2 migration (named export + renderProp + dropped disable hints). | List virtualization still works on long tables (>1000 rows). | ? |
| #463 | Active band tone v2 — override the full `before:bg-[…]` arbitrary value. | Active sidebar row band — navy on dark / warm grey on light (not yellow / orange). | ? |

---

# Known broken / risky areas (start here)

This is where I'd start the audit given what I've seen in the last
session. Rough priority order:

1. **R13-PR4 active band tone** (#394) — landed as navy via brand-secondary
   utility overrides; on 2026-05-13 was supposed to swap to `--bg-page`
   (cut-out look) but v1 (#455) silently no-op'd. v2 (#463) just merged —
   needs eye on the deployed site.
2. **Searchbar removals** (#440, #443) — user flagged this 3 times during
   the session. Worth confirming none lingered after the final kill.
3. **Notifications-bell** (#432) — shipped with off-recipe hover and raw
   `toLocaleDateString`; fixed in #456 but worth confirming the bell
   actually renders with correct hover + relative-time copy.
4. **Tenant switcher** (#428) — popover from JWT memberships. The
   hotfix #439 had to switch from `useSession()` (which had no provider)
   to threaded session props. Worth confirming the switcher actually
   lists tenants for users with multiple memberships.
5. **FilterToolbar coverage** (R7-PR4 #301) — registry passes but UI
   sweep would catch list pages that quietly stopped mounting it.
6. **EntityDetailLayout coverage** (R7-PR9 #306 + R8-PR3 #310) — 8 → 10
   detail pages migrated; same risk as #5 for the un-migrated ones.
7. **DataTable row hover** (v2-PR-12 #204) — chevron-right + brand left
   edge claim. R13-PR13 #374 specifically fixed this leaking onto wrong
   cells. Worth eyeballing every list page hover.
8. **EmptyState personality** (R11-PR1 #346, R8-PR1 #308) — three
   vocabularies; cleared-filters CTA. Easy to verify by loading any
   empty list with filters applied.

---

# What we'd add for next time

If this audit surfaces 5+ broken rows, that's the signal to invest in
**behavioural ratchets** (the third audit-lens option). Pattern:

```ts
// tests/rendered/nav-item-active-band-tone.test.tsx
it('the active band renders --bg-page on every theme', () => {
  const { rerender } = render(<NavItem active href="/x" icon={X} label="X" />);
  const link = screen.getByRole('link');
  const before = getComputedStyle(link, '::before');
  // Resolve the var to its theme value
  const expected = document.documentElement.style.getPropertyValue('--bg-page');
  // Assert background-image CONTAINS that resolved value
  expect(before.backgroundImage).toContain(expected);
});
```

This kind of test would have caught the v1 active-band failure where
`from-[var(--bg-page)]!` was present in className but the rendered
background-image was still the brand-default ramp.

The catch: rendered tests are slower and more complex than structural
ratchets. They make sense for primitives where the wire-up
between className and rendered value is subtle (the active-band case).
For pure class-presence checks, the structural ratchet is still right.

Target: convert one ratchet per session as a side-effect of doing
real work. Don't try to back-fill all of them in one sweep.
