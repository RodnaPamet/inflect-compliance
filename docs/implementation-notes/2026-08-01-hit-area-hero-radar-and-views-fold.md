# 2026-08-01 — Hover hit areas, the hero radar, the Views fold, and the DORA register

**Commit:** `<pending>` four toolbar/hero changes shipped as one PR

Four requests, one PR, because three of the four touch the same two
surfaces (the list toolbar and the dashboard hero) and splitting them
would have meant three passes over the same files.

## 1. The hover flicker — a hit-area bug, measured

The report: *"buttons flicker once the mouse pointer exits the button
hover but the mouse body stays on the button."*

Rather than guess, the behaviour was measured in a real browser
(Playwright against `next dev`, seeded tenant): for each control, walk a
1px grid over its own bounding box, ask `document.elementFromPoint` who
owns each pixel, and count the share that does NOT resolve to the control
— then wiggle the pointer in a 5px circle at a corner and count `:hover`
transitions.

```
                        size    radius        dead-zone   corner-wiggle
#risks-dashboard-btn    28x28   rounded-full      16%       2 flips
notifications bell      22x22   rounded-full      14%       2 flips
avatar                  22x22   rounded-full      14%       2 flips
#risks-view-register    63x20   rounded-12px       5%       2 flips
#new-risk-btn           61x28   rounded-full       7%       2 flips
filter trigger         134x36   rounded-12px       2%       2 flips
```

The cause is `rounded-full`: hit-testing follows the rounded SHAPE, but
the user aims at the visible BOX. A 28px icon button is a circle inside a
square, so the four corner arcs — 16% of it — render as button and answer
to nothing. Approach one diagonally and the pointer sits visibly on the
tile with the hover off; a two-pixel wiggle across the arc toggles it.

The fix is one transparent, square `::before` covering the border box
(`src/components/ui/hit-area.ts`). A pseudo-element is hit-tested as part
of the element that owns it, so hovering a corner sets `:hover` on the
control. It paints nothing.

Two details are load-bearing, and both were found by re-measuring rather
than by reasoning:

- **`-inset-px`, not `inset-0`.** An absolutely positioned child resolves
  its offsets against the *padding* box, so `inset-0` stops one pixel
  short and leaves the border ring dead. Measured, the residue was still
  5% — and the wiggle count went from 2 flips to **4**, because the hit
  region became an arc plus a square edge. Strictly worse than no fix.
- **It must not grow past the border box.** A larger inset would spill
  into the neighbouring control's space and let one button answer for its
  neighbour's hover.

After: every control carrying the recipe measures `dead-zone=0% /
corner-wiggle-flips=0`.

`buttonVariants` covers most of the product; six hand-rolled rounded
recipes opted in explicitly (toggle-group, filter trigger, notifications
bell, user-menu avatar, tenant switcher, org switcher, IdentityPill).

**Still Surface.** The material's ratchet banned `before:` outright,
because every pseudo-element in the retired R19→R24 stack was a paint
layer. The ban is now on MATERIAL rather than on the mechanism: the guard
enumerates the painting properties (`before:bg-`, `before:shadow`,
`before:opacity`, …) and still forbids `after:` entirely, while asserting
the hit-area recipe is present and square.

**One thing fixed on the way past.** `<ShimmerDots>` rendered a `<div>`
into `<MetricCard>`'s `<p>` value slot. A `<div>` in a `<p>` is invalid
HTML — the browser closes the paragraph early, server and client markup
disagree, and React discards the whole dashboard tree with a hydration
error (a real flash on first paint). It is a `<span>` now; `display:
grid` behaves identically.

## 2. The hero radar

The hero headline is an AI narrative over `gatherPostureSignals`, which
is itself assembled from `getExecutiveDashboard`. The narrative
compresses control coverage, risk severities, evidence freshness and four
overdue counts into one word and one number. The radar re-expands it from
the **same payload** — no second fetch, no second source, so the polygon
and the headline beside it cannot disagree.

Six axes, all 0–100, all **higher is better**, because a radar is read as
area and "bigger polygon = healthier" only holds if no axis is inverted:

| axis | source | direction |
| --- | --- | --- |
| Controls | `controlCoverage.coveragePercent` | native |
| Evidence | `current / (current + overdue + dueSoon30d)` | native |
| Risk | share NOT high/critical | inverted |
| Policies | share NOT overdue for review | inverted |
| Tasks | share NOT overdue | inverted |
| Vendors | share NOT overdue for review | inverted |

Two decisions worth keeping:

- **An empty denominator scores 100, not 0.** Nothing is overdue when
  nothing exists; a fresh tenant should not read as failing on axes it
  has not started using.
- **…but a fresh tenant gets no radar at all.** That rule alone would
  paint a perfect hexagon beside an "At risk" headline, so
  `isPostureRadarMeaningful` gates the whole chart on the tenant having
  any estate. The chart would otherwise be lying by construction.

The radar rides in both hero branches — the posture card and the
coverage-% fallback — because it is derived from the executive payload,
not from the AI summary, and is just as true before the narrative has
been generated.

## 2b. The ladder (follow-up, same day)

The first cut of the radar drew six axes and left the hero's headline as
the model's own 0-100 maturity score. Three problems, all reported:

1. The dial sat top-aligned beside a text column that grows with the
   advice list, so it rode high with dead space under it.
2. Axis labels were centred `LABEL_GAP` past the outer ring, so half of
   every SIDE label reached back over the ring and landed on the vertex
   dot. Measured clearance: **0px** (overlapping) before, **7px** after.
3. Nothing connected the headline to the chart. "Developing · 46" and a
   six-spoke polygon were two answers to one question, and only the
   polygon could be checked.

**The ladder.** Five rungs, one shared scale, exact cut-points:

| rung | name | floor (axis score) |
| --- | --- | --- |
| 1 | Initial | 0 |
| 2 | Developing | 40 |
| 3 | Defined | 60 |
| 4 | Managed | 80 |
| 5 | Optimising | 95 |

One table rates all six axes because every axis is already the same kind
of number — the share of that part of the estate which is healthy. A
per-axis ladder would make "Controls L3" and "Evidence L3" mean different
amounts of work, and the radar's whole claim is that its spokes are
comparable. The cut-points tighten as they rise (40/60/80/95) because
compliance estates cluster near the top: 88% healthy and 96% healthy are
materially different positions, while 12% and 30% are not different in
kind.

**Overall level = the weakest rated axis**, not the mean. A mean lets
five strong axes hide one that is failing, and — just as bad — no feature
of the polygon corresponds to a mean, so the headline could not be read
off the chart. Weakest-link makes the chart self-explaining: the shortest
spoke IS the headline, and naming it ("Level set by Risk — 1 of 4
healthy") turns a number into an instruction. Axes with no estate behind
them are skipped rather than scored: a tenant with no vendors is neither
good nor bad at vendors.

**Every number is checkable.** Each axis carries the raw `measured /
total` counts the score came from, printed beside its level, so a reader
can divide two numbers on the page, get the percentage back, and read the
rung off the published cut-points. That is what made the evidence axis
change: its denominator used to include `dueSoon30d`, which OVERLAPS
`current`, so the printed fraction would not have divided out. It now
uses the two disjoint buckets (`current` / `overdue`) only.

**One voice.** The headline word is the ladder's, not the model's. The
model keeps the narrative and the advice — what it is actually good at —
and the deterministic band names the level. The model's label still leads
when there is no estate to rate, so a tenant that has not started yet
still gets a headline.

**Chart mechanics.** `rings` is now a prop (default 4): the hero passes 5
so the grid IS the ladder — a vertex on the third ring means level 3.
Labels anchor by side (`start` / `end` / `middle`) so text grows away
from the plot, and the reserved margin is split horizontal/vertical
(58/28) rather than one square inset, because a side label needs room for
a word and a top label needs room for a line. The horizontal figure
doubles as the visx wrap width, so a long label breaks instead of running
off the SVG.

Verified in the browser: label↔vertex clearance 7px (was 0), no label
outside the SVG, column centring delta **0px**, ladder rows no longer
overflow their grid column.

## 2c. Space, and what the top rung means (second follow-up)

Two reports, both measured before and after.

**The hero wasted vertical space.**

```
                                   before    after
eyebrow vs Regenerate button        +93px     -4px   (centres)
painted dial → metrics list          87px      29px
dial width                          248px    287px
card height                         404px    392px
```

The eyebrow sat 93px down the card because the columns were centred
against each other, and the right column is taller by construction.
`items-start` puts both at the card's content edge, level with the
Regenerate button opposite. The button also moved from `top-default`
(16px) to `top-section` (24px) — the card's own padding — and the eyebrow
took the button's 28px line box, because two boxes that start at the same
edge only read as level when they are the same height.

The 87px gap under the chart was a wrapper that did nothing.
`<ChartFrame>` puts its measured area in `position: absolute` and
resolves to its own `min-height`, so a `h-[300px]` parent bought 60px of
dead space rather than a bigger dial. `<RadarChart>` now forwards
`minHeight`, and the hero passes a figure sized so the dial is bound by
the column's WIDTH (`POSTURE_RADAR_FRAME_HEIGHT`) — the same height now
draws a 30% larger dial with the metrics sitting under it.

**The top rung had to mean zero defects.** Tasks rated L5 while an
overdue log existed. The old floor was a percentage (≥95), and a
percentage cannot express "none left": 249 of 250 healthy is 99.6%, which
ROUNDS TO 100. The rule is now `measured === total`, evaluated on the
counts, and the bands below cap at 4 while any defect remains:

| rung | name | rule |
| --- | --- | --- |
| 5 | Optimising | `measured === total` — nothing left to fix |
| 4 | Managed | ≥90% healthy |
| 3 | Defined | ≥75% |
| 2 | Developing | ≥50% |
| 1 | Initial | below 50% |

The bands moved from the earlier top-heavy 40/60/80/95 to even quarters,
because once the top rung is reserved for a clean sheet the rungs below
describe *how far off* a clean sheet the tenant is, and that distance
reads better spread out.

Two consequences that fall out of the same change:

- `level` is now `null` for an axis with no estate. 0/0 is not a perfect
  score, and scoring it 5 would have put a fabricated "Optimising" on the
  page for something the tenant does not do.
- `overallLevel` breaks ties by level FIRST, then score. Two axes can both
  be level 4 with one at a rounded 100% and one at 96%; the headline must
  name the one that actually holds the level down.

## 3. The Views fold

`Views ▾` existed only on the risks page, flanked by three tooltip-only
icon buttons that competed with the two gears for one eye-line. It is now
a shared primitive (`<ViewsMenu>`) and every main list page's secondary
navigation folds into it.

The toolbar's reading order is now the same everywhere:

```
[layout toggle] [Views ▾] [page dashboard] … [columns] [filters]
```

What stays OUT of the menu, and why:

- **The page dashboard icon.** One click to the KPI view is the single
  shortcut worth toolbar width. On risks this meant taking
  `/risks/dashboard` OUT of the menu it was already in.
- **The layout toggle** (register ⇄ heatmap, list ⇄ gallery) — the
  primary control for the table itself.
- **The two gears** — table chrome, not views. They also dropped from
  36px to 24px: at the old size they were the largest thing in a row of
  28px pills, which read as "most important control here".

Items come in two shapes: `href` (a `<Link>`) and `onSelect` (an action
row that carries `selected`, so the histogram mode and the deleted-rows
view show their state without opening anything else).

## 4. Information Registry (DORA Art. 28(3))

A new `/risks/information-registry`, shelved under the Views menu's
"Registry" heading beside the EU AI Act registry — both are regulatory
registers ABOUT the estate rather than analytics OVER it.

**It is a projection of the vendor inventory, not a second store.** DORA's
register describes contractual arrangements with ICT third-party service
providers, and the vendor inventory is where a tenant already records
them. A parallel "register entry" model would create two places to keep
one fact.

The honesty constraints, which are the point of the page:

- DORA turns on one distinction — does this arrangement support a
  **critical or important function**? Inflect holds no CIF flag, so the
  page derives it from vendor criticality (CRITICAL/HIGH → yes) and says
  so on the page, rather than presenting a derived answer as a recorded
  one.
- The ESAs' implementing templates want fields Inflect cannot hold: LEI
  codes, annual contract value, the substitutability assessment, the
  exit-plan reference. The scope note names them. A register that
  silently omitted them would read as complete — the failure mode that
  matters when the reader is preparing a supervisory submission.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/hit-area.ts` | The one hit-area recipe + the measurements behind it |
| `src/components/ui/button-variants.ts` | Wears `HIT_AREA_CLASS` |
| `src/components/ui/toggle-group.tsx`, `filter/filter-select.tsx`, `layout/{notifications-bell,user-menu,tenant-switcher,org-workspace-switcher,IdentityPill}.tsx` | Hand-rolled rounded recipes, opted in |
| `src/components/ui/shimmer-dots.tsx` | `<div>` → `<span>`; fixes the `<p><div>` hydration error |
| `src/components/ui/checklist-gear-button.tsx` | Gears one rung smaller (36 → 24px) |
| `src/lib/charts/posture-radar.ts` | Six-axis derivation + the meaningfulness gate |
| `dashboard/PostureHeroCard.tsx`, `dashboard/DashboardClient.tsx` | Two-column hero; radar in both branches |
| `src/components/ui/views-menu.tsx` | The shared `Views ▾` primitive |
| `risks/RisksClient.tsx`, `controls/ControlsClient.tsx`, `assets/AssetsClient.tsx`, `tasks/TasksClient.tsx` | Toolbars folded |
| `risks/information-registry/{page,InformationRegistryClient}.tsx` | The DORA register |
| `VendorRepository.listInformationRegister` + `usecases/vendor.listInformationRegister` | Its read path (own SELECT; same vendor-read permission) |

## Decisions

- **Measure, then fix.** The first hit-area attempt (`inset-0`) looked
  correct and made the wiggle behaviour worse. Only the before/after
  measurement caught it.
- **The hit area is a mechanism, not a material.** Rewriting the Still
  Surface ratchet to ban painting pseudo-elements (rather than the
  `before:` prefix) keeps the original intent — no depth-through-motion —
  while allowing a layer that paints nothing.
- **The radar reuses the hero's own payload** rather than fetching its
  own. Two sources for one claim is how a dashboard starts contradicting
  itself.
- **The dashboard icon leaves the menu it was in.** "Fold everything"
  would have buried the one destination that earns its width.
- **The DORA register projects rather than stores** — and says which
  fields it cannot cover, because a register is read as complete.
