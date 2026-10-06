# The shared UI package — design

> **Status: living design** — nothing is extracted. No file has moved and no package exists. One
> import HAS changed, inside `src/`: batch 2 inverted `ui/hooks/use-celebration.ts` →
> `@/lib/celebrations` (see [Update 2026-10-03](#update-2026-10-03--batch-2-of-the-blocker-neutralisation)),
> so the "no import has changed" this banner used to claim is no longer true. This document is the
> design record for #3046, and its central measured finding is that the extractable set is **not**
> every file `docs/_status/ui-core-classification.json` records as `GENERIC` (479 today): it is
> **457**, because `GENERIC` is a per-file neutrality verdict and a package needs a closed module
> graph. It was 408 of 454 when this doc was written, 426 of 462 after batch 1, 427 of 467 after
> batch 2 and 442 of 472 after batch 3 — see
> [Update 2026-10-02](#update-2026-10-02--batch-1-of-the-blocker-neutralisation),
> [Update 2026-10-03](#update-2026-10-03--batch-2-of-the-blocker-neutralisation),
> [Update 2026-10-03](#update-2026-10-03--batch-3-of-the-blocker-neutralisation) and
> [Update 2026-10-06](#update-2026-10-06--batch-4-of-the-blocker-neutralisation) for what moved and
> which figures below are superseded. Everything true today is under
> [Current state](#current-state--what-was-measured-and-how). The step order is under
> [Roadmap](#roadmap--the-sequence-and-what-verifies-each-step).

The owner asked (2026-10-02) to start this now, overriding #3046's own stated trigger — "a second
consumer, not a date". That override is recorded, not re-argued. What the override does *not* change
is the arithmetic the trigger was about, and §7 states it with numbers rather than with the issue's
estimate.

**Derivation convention.** Every count below was derived on **2026-10-02** against
`2b2348305` by a script over `docs/_status/ui-core-classification.json` and the working tree, not
read off a prose table. Each section says which derivation produced its figures so they can be
re-run. Where a figure is a prediction rather than a measurement it says **predicted**.

Prerequisite check: #3046 lists "#3003 (T01–T08)". #3003 is closed with T03, T05, T07 and T08
*unticked*, which reads as four missing prerequisites. They are not missing — the per-task issues
#3050 (T03), #3049 (T05) and #3076 (T07) are all closed, and T08 landed too: the seam the policy
document calls a worked example is live at `src/components/layout/user-menu.tsx:88`
(`items?: (props: { close: () => void }) => ReactNode`), with `USER_MENU_ITEM_CLASS` commented
"Exported since T08 (#3003)". The parent's checkboxes are stale; the work is in.

---

## Update 2026-10-02 — batch 1 of the blocker neutralisation

Nine of the direct blockers were neutralised and reclassified `GENERIC`, so several figures below
are superseded. This section states what was **re-measured**; everything it does not list was not
re-derived and the older figure stands only as a figure from `2b2348305`.

First, the derivation below was **reproduced exactly** against `2b2348305` before anything changed
— 454 GENERIC, 82 edges, 43 sources, 41 targets, 362 / 408 closed, 434 with every blocker promoted.
Two notes on how to read those numbers, because both were ambiguous:

- **82 is import-statement OCCURRENCES, not distinct source→target pairs.** The deduplicated pair
  count at that commit was 74.
- **434 is the STRICT model of "neutralise"** — a promoted blocker becomes `GENERIC` and must then
  be import-closed on its own merits, like every other member. A looser model that waves the
  promoted file through regardless of its own dependencies gives 475. The doc's `button.tsx`
  buys 4 is the same under both.

**What moved between `2b2348305` and the start of this batch.** #3098 reclassified
`layout/ClientProviders.tsx` `GENERIC → MIXED` when the detector gained its `@/components` arm, so
the live figures were already 453 GENERIC / 81 occurrences / 42 sources / **40** targets — not 43
and 41.

**Re-measured after this batch:**

| | `2b2348305` | before batch | after batch |
|---|---|---|---|
| GENERIC / MIXED / COUPLED | 454 / 140 / 19 | 453 / 141 / 19 | **462 / 132 / 19** |
| direct GENERIC→(MIXED\|COUPLED) edges (occurrences) | 82 | 81 | **59** |
| …deduplicated source→target pairs | 74 | 73 | **53** |
| distinct GENERIC sources / distinct blocker targets | 43 / 41 | 42 / 40 | **32 / 31** |
| import-closed subset (4 neutral extras) | 408 | 408 | **426** |
| ceiling if every direct blocker were neutralised | 434 | 434 | 434 |
| population | 613 | 613 | 613 |

The nine files are `ui/button.tsx`, `ui/filter/types.ts`, `ui/charts/types.ts`,
`ui/hooks/use-threshold-load-more.ts`, `lib/hooks/use-zod-form.ts`, `ui/checklist-order.ts`,
`ui/card-list/card-list.tsx`, `ui/dashboard-widgets/DashboardWidget.tsx` and
`ui/date-picker/calendar.tsx`. Each one's map entry says what was removed.

**The finding that matters more than the +18.** Every blocker with a non-zero marginal gain turned
out to be `MIXED` for **prose** — a domain example or a brand name in a comment — and not for a
mechanical coupling. Of the 40 blockers only 12 trip a mechanical detector at all, and **none of
the 11 productive ones do**. So the `#3048` `domain-import` ceiling did **not** move: `codeOf()`
masks comments at the read seam, which is exactly why these couplings were invisible to it in the
first place. Live counts are unchanged at `domain-import` 46, `brand-as-text` 10, `storage-key` 1.
A §5-style expectation that neutralisation and the ratchet descend together is wrong for this
class of blocker.

**The shape of the new closed set, re-measured:** 426 files / 29,805 lines — 333 files / 15,966
lines of icons and **93 files / 13,839 lines** of real library (79 `components/ui` non-icon, 7
`components/layout`, 7 `lib/hooks`, and still **0** `components/app-shell`).

**§1's "No test file is in the set" is now FALSE, and §5.6's concern now bites.** The two
`GENERIC` co-located tests fell out of the closure only because they tested `MIXED` hooks;
neutralising those two hooks pulled both tests in. See the correction at §1 and at §5.6.

**What this batch did NOT re-derive**, so the older figures stand unverified: the playerz overlap
(§"The consumer" — the 38/21 split and the 59/494 manifest rows, which need the projectZ
manifests), the token contract over the new 426 (§4 — the 45 names were stable across three
populations, so a change is unlikely but unmeasured), §5.3's 173-file / 183-path test rewrite,
§5.7's coverage denominator, and §7's lines-moved row.

**The ranked remainder.** Only four of the 31 remaining blockers have a non-zero *individual*
gain: `ui/table/pagination-utils.ts` (+3 — but its coupling is hardcoded English inside
`formatPageRange`, which has zero callers in `src`, so the fix is a deletion plus a test change
rather than a comment edit), `ui/card-list/card-list-card.tsx` (+2 — an English copy-parameter
default that reaches the DOM as an `aria-label`, i.e. a real clause-1 fix),
`layout/nav-bar.tsx` (+1 — a real default-value change, and #3100 is rewriting the file, and its
map reason is one of the four at the 400-character cap that
`tests/guards/ui-core-classification.test.ts` exempts by name, so editing it means deleting that
exemption in the same diff), and `ui/filter/filter-definitions.ts` (+1, JSDoc only). The other 27 need a CLUSTER to
move together, and two barrels dominate: `ui/hooks/index.ts` blocks `modal`, `popover`, `sheet`,
`copy-button`, `animated-size-container`, `table/infinite-scroll-sentinel` and
`table/use-columns-dropdown` (and, through `modal`, `confirm-dialog` and
`app-shell/shortcut-help-overlay`); `ui/icons/index.tsx` blocks `accordion`, `checkbox`, `input`,
`status-badge`, `combobox/virtualized-options`, `table/table.tsx` and `table/virtual-table-body`.
**So the doc's claim that the consumer's 21 primitives are blocked on `button.tsx` was wrong on
the cause** — `button.tsx` is now `GENERIC` and in the set, and those primitives are still out,
behind the two barrels.

**The highest-value item left is ONE import, and it is a real mechanical coupling.** The hooks
barrel cannot close no matter how its prose is cleaned, because it re-exports
`ui/hooks/use-celebration.ts`, whose *only* import is `@/lib/celebrations` — a genuine
`domain-import`, the one mechanical coupling in the barrel's six files (the other five are
prose-only `MIXED`, the same class as batch 1, and `hooks/index.ts` is a one-word comment fix).
Measured: inverting that single edge and reclassifying the six takes the closed set **426 → 442
(+16)** and brings in `modal`, `popover`, `sheet`, `confirm-dialog`, `copy-button`,
`animated-size-container`, `ActionCluster`, `table/edit-columns-button`,
`table/infinite-scroll-sentinel` and `app-shell/shortcut-help-overlay` — five of them on the
consumer's most-leaned-on list. It is also the first blocker whose removal WOULD lower the #3048
`domain-import` ceiling, 46 → 45.

> **Batch 2 did the inversion and NOT the six reclassifications, so the +16 did not land — the
> closed set moved by one.** Read the conjunction in the sentence above literally: "inverting that
> single edge **and** reclassifying the six". Batch 2's ruling covered the edge and
> `use-celebration.ts`; the other five barrel files are prose-only `MIXED` and their prose was not
> in scope. `ui/hooks/index.ts` still blocks six files. The +16 remains available and is now a
> prose-only batch of five files, which is the cheap half.

**442 is deliberately larger than the 434 ceiling in the table above, and the two are not in
conflict.** 434 is the fixed point of *reclassifying* every direct blocker; it is a ceiling only on
promotion. Inverting `@/lib/celebrations` deletes an EDGE instead, which is the operation
reclassification cannot perform — the 434 figure's own "34 GENERIC files stay out, because the
promoted blockers have non-`GENERIC` dependencies of their own" is exactly this edge, named.

For contrast, measured on the same tree: promoting the barrel cluster *without* inverting that
edge buys only **+4** (the barrel still falls out behind `use-celebration`), and the whole filter
cluster of seven files buys **+2**, the date-picker cluster of four buys **0**, and the icons
barrel alone buys **0**. Clusters are a poor trade; that one import is not.

A second route exists and was deliberately NOT taken: each of the seven files importing the barrel
pulls exactly ONE hook from it, and every one of those is already `GENERIC`, so rewriting seven
import specifiers to name the hook directly reaches **436** with nothing reclassified. Against it:
CLAUDE.md's Epic 60 convention is "import shared hooks from `@/components/ui/hooks` (barrel)", and
14 test files `jest.mock('@/components/ui/hooks')` — a deep import escapes those mocks silently,
which is a behaviour change in the tests rather than in the product. It needs an owner decision on
the convention, not a quiet refactor, and it is worth less than the inversion anyway.

**One blocker needs no work at all — its map entry is simply stale.**
`ui/checklist-gear-button.tsx` is `MIXED` on a reason that names exactly one coupling, "One brand
token is used as text", and #3102 removed it (the file's brand tokens are now
`text-content-brand`, a background and a ring). Its marginal gain today is 0, so it was left for
whichever batch takes the filter cluster, but it is a reclassification with no source edit.

**And one `domain-import` hit in the live 46 is a detector false positive the map already
records.** `ui/charts/layout.ts` trips the kind on `@/lib/format-date`, and its own entry says
"(`@/lib/format-date` is a generic util, not a domain module.)". `format-date` is the single most
common coupled specifier in the live count — **6 of the 46** files import it, more than any other,
and for **five of those six it is the ONLY coupled specifier** (`TrendCard`, `charts/layout`,
`date-picker/date-picker`, `date-picker/date-range-picker`, `timestamp-tooltip`; only
`layout/notifications-bell` has another, `@/lib/auth`). So if the map's judgement is right, the
honest reading of 46 is **41**. Resolving it means adding `format-date` to
`NEUTRAL_LIB` in `tests/helpers/shared-ui-couplings.ts`, which WIDENS an allowlist the helper's
own docstring argues for keeping narrow, so it is a decision rather than a tidy-up and is recorded
here rather than taken. **(TAKEN by batch 2 — and the predicted 41 was wrong, because the
widening was four names rather than one. See the next section.)**

---

## Update 2026-10-03 — batch 2 of the blocker neutralisation

Batch 2 took the two decisions batch 1 recorded and declined to take: it **widened `NEUTRAL_LIB`**
and **inverted the `@/lib/celebrations` import**. Both of the figures batch 1 predicted for them
turned out wrong, in opposite directions, and that is the useful part of this section.

**Re-measured, with the same derivation as batch 1**, reproduced against batch 1's tip
(`33dc60f71`, merged with `origin/main`) before anything changed: 462 GENERIC / 59 occurrences /
53 pairs / 32 sources / 31 targets / 426 closed — matching the batch-1 table exactly. Instrument
control: the resolver left **0** relative-or-alias specifiers unresolved (3,024 bare package
specifiers skipped by design), so the one failure mode that would report the `GENERIC` set
perfectly closed — a resolver that resolves nothing — is ruled out.

| | before batch 1 | after batch 1 | after batch 2 |
|---|---|---|---|
| GENERIC / MIXED / COUPLED | 453 / 141 / 19 | 462 / 132 / 19 | **467 / 127 / 19** |
| direct GENERIC→(MIXED\|COUPLED) edges (occurrences) | 81 | 59 | **57** |
| …deduplicated source→target pairs | 73 | 53 | **51** |
| distinct GENERIC sources / distinct blocker targets | 42 / 40 | 32 / 31 | **31 / 31** |
| import-closed subset (the 4 neutral extras) | 408 | 426 | **427** |
| …if the four newly-neutral `@/lib` leaves are also allowed | — | 426 | **432** |
| `domain-import` ceiling | 46 | 46 | **36** |
| population | 613 | 613 | 613 |

**The ratchet fell by ten, in two measured steps.** `domain-import` 46 → 37 from the widening
(nine files stopped tripping the kind), then 37 → 36 from the inversion. Batch 1 predicted 41 and
45. Both predictions were sound *about a one-name widening* — `format-date` alone frees five files
— and both were wrong here, because the widening added four names: `format-date`, `kpi-trend`,
`number-format` and `locale-constants`. The nine freed are `layout/LocaleSwitcher`, `ui/KpiCard`,
`ui/TrendCard`, `ui/charts/funnel-chart`, `ui/charts/layout`, `ui/dashboard-widgets/types`,
`ui/date-picker/date-picker`, `ui/date-picker/date-range-picker` and `ui/timestamp-tooltip`.

The same change **deleted** four entries — `utils`, `format`, `dates` and `a11y` — which named
`@/lib` modules that do not exist as a file or a directory and that nothing in the repo imports.
Deleting them moves no count by construction (an allowance for a name nothing can match can never
have allowed anything), and it was done anyway because the *argument* for adding `format-date` had
been "the same kind as the `cn`/`dates`/`format`/`a11y` entries already there" — reasoning drawn
from entries that are not real. `tests/guards/ui-core-classification.test.ts` now asserts that
every `NEUTRAL_LIB` entry resolves, with a positive control, so the class cannot recur.

**Nine files stopped tripping the kind; only four of them were reclassified.** A file stops
tripping a MECHANICAL detector without becoming neutral, and batch 2 applied one rule — GENERIC
only if it trips nothing mechanically **and** its recorded reason names no non-mechanical coupling.
Five of the nine keep a judgement coupling and stay `MIXED`: the two date pickers (untranslated
English that reaches the screen), `LocaleSwitcher` (writes `document.cookie` from `LOCALE_COOKIE`
instead of through the `uiCookieName` seam), `KpiCard` (domain examples in its `@example` and its
polarity JSDoc) and `charts/funnel-chart` — see the detector gap below. So **the ratchet falling is
not the same event as the GENERIC set growing**, in the opposite direction to batch 1's finding
that the GENERIC set can grow while the ratchet does not move.

**The closed set moved by ONE, not by the +16 batch 1 measured.** Batch 1's figure was explicit
that it counted "inverting that single edge **and reclassifying the six**" barrel files; batch 2
inverted the edge and reclassified `use-celebration.ts` only, because the other five are prose-only
`MIXED` and no ruling asked for their prose. `ui/hooks/index.ts` therefore still blocks six files,
and `use-celebration.ts` is the single file that entered the closure. **The +16 is still available
and is now a prose-only batch** — the hardest part of it is done.

> **Batch 3 took it, and the closure is now 442.** `ui/hooks/index.ts` blocks nothing; the paragraph
> above is true as of batch 2 only. See
> [Update 2026-10-03 — batch 3](#update-2026-10-03--batch-3-of-the-blocker-neutralisation).

**A `NEUTRAL_LIB` entry is NOT a package dependency, and conflating the two lists would overstate
this batch by five files.** §2's dependency rule allows four non-root files alongside the package
(`src/lib/cn.ts`, `src/lib/ui-storage.ts`, `src/lib/auth/session-expiry.ts`,
`src/components/theme/ThemeProvider.tsx`). The four newly-neutral modules are not among them, so
`charts/layout.ts` and `timestamp-tooltip.tsx` are `GENERIC` and still **outside** the closure, on
an edge to `@/lib/format-date`. Admitting those four leaves as package dependencies as well takes
the closed set 427 → **432**, bringing in `charts/layout`, `charts/utils`, `charts/x-axis`,
`charts/y-axis` and `timestamp-tooltip`. That is a §2 decision about what ships, measured here and
deliberately **not** taken: all four are leaves (zero `@/` imports each), so the cost is four small
files, but the dependency rule is the package's boundary and widening it is not a side effect of
widening a detector's allowlist.

**Correction to the paragraph below: `design` is NOT one of the names that resolve to nothing.**
§2's "Reconciling with `NEUTRAL_LIB`" said five of the nine entries named nothing, listing `design`
among them. `src/lib/design/` exists — it holds `status-tone.ts` and has five importers in
`src/app` plus two tests. Four named nothing, not five, and all four are now deleted. `design` and
`theme-constants` are the two real-but-dormant allowances: both resolve, neither is imported by any
file inside `SHARED_UI_ROOTS`.

**A detector gap found by applying the rule, and left open on purpose.**
`ui/charts/funnel-chart.tsx` is mechanically clean after the widening, but its map entry names a
live accessibility coupling: the hovered between-stage conversion annotation is an SVG `<Text>`
painted `fill-[var(--brand-default)]` (`:308`), i.e. real rendered text at 4.03:1 against WCAG
1.4.3's 4.5:1. `BRAND_AS_TEXT` matches `text-brand-*` / `text-[var(--brand-*)]` and deliberately
**not** `fill-`, on the reasoning that fill is non-text and owes only 1.4.11's 3:1 — which is right
for a chart area and wrong for `<Text>`. So the file is not in the `brand-as-text` 10 and never
was. Widening the detector to `fill-` on SVG text elements would RAISE that ceiling, which is a
decision with a number in it; fixing the one token is a visual change. Neither is in scope here, and
the entry stays `MIXED` so the file is not published clean.

**What batch 2 did NOT re-derive**, so the older figures stand unverified: everything batch 1 listed
(the playerz overlap, the token contract, §5.3's test rewrite, §5.7's coverage denominator, §7's
lines-moved row) plus the per-root split table and the 434 promotion ceiling, which was not
recomputed against the new classification.

---

## Update 2026-10-03 — batch 3 of the blocker neutralisation

Batch 3 is the prose-only batch batch 2 left behind, and **the +16 landed exactly as batch 1
predicted it**. That is the headline, because the two previous batches each found a prediction wrong.

| | after batch 1 | after batch 2 | after batch 3 |
|---|---|---|---|
| GENERIC / MIXED / COUPLED | 462 / 132 / 19 | 467 / 127 / 19 | **472 / 122 / 19** |
| direct GENERIC→blocker occurrences / pairs / sources / targets | — | 61 / 55 / 33 / 33 | **54 / 48 / 26 / 32** |
| import-closed subset (the 4 neutral extras) | 426 | 427 | **442** |
| `domain-import` ceiling | 46 | 36 | **36** |
| population | 613 | 613 | 613 |

(The occurrence/pair/source/target row is this batch's own resolver, which counts a GENERIC file's
edge to ANY non-admissible target — including the four `@/lib` leaves outside the package's
dependency rule. Batch 2's 57/51/31/31 counted only targets that have a map entry, so the two rows
are different questions and the batch-2 figures are not restated here as if they were comparable.)

**426 → 442 is +16, split 1 + 15 across two batches.** Batch 1's figure was for "inverting that
single edge **and** reclassifying the six" barrel files. Batch 2 inverted the edge and reclassified
one file (`use-celebration.ts`), which was +1. Batch 3 reclassified the remaining five and the
closure gained **exactly the fifteen files** batch 1 named: the five hooks themselves plus `modal`,
`popover`, `sheet`, `confirm-dialog`, `copy-button`, `animated-size-container`, `ActionCluster`,
`table/edit-columns-button`, `table/infinite-scroll-sentinel` and
`app-shell/shortcut-help-overlay` — five of them on the consumer's most-leaned-on list.

**`table/use-columns-dropdown` was on batch 1's blocked list and did NOT enter, and the reason is
useful.** It is `GENERIC`, and so are both of its imports; but `table/columns-dropdown.tsx` imports
`../checklist-gear-button`, which is the `MIXED` entry this doc already flags as stale (#3102 removed
its one brand-as-text token). So the file sitting behind a stale map entry has a measurable price
now: it blocks 2 `GENERIC` sources, where batch 1 recorded its marginal gain as 0.

**The five files were reclassified by batch 2's rule, not from batch 1's list** — GENERIC only if the
file trips nothing mechanically AND its recorded reason names no non-mechanical coupling. All five
already tripped nothing (measured: `[]` for each), so the whole of the work was prose, and each
entry's reason now records which words moved.

**`ui/icons/index.tsx` was NOT reclassified, and the distinction is the point of the rule.** Its
prose coupling — the comment naming the brand Dub — is gone with this batch. Its reason named a
SECOND coupling that prose cannot reach: the barrel re-exports six brand-named modules and the
upstream pricing-plan map into the shared public API. So it stays `MIXED` and the seven files it
blocks stay blocked. A word fix is not a file fix.

**The `domain-import` ceiling did not move, and it structurally could not.** `counts()` in
`tests/guards/shared-ui-coupling-ratchet.test.ts` reads `couplingIndex()`, which derives from source
text and never opens the classification map — so no reclassification can move it, whatever its size.
Re-seating was therefore not available; what was done instead is a both-directions mutation proof
that 36 is live and has teeth: lowering the constant to 35 fails `domain-import does not grow`
("rose to 36, ceiling 35"), and inflating it to 38 fails the slack sentinel, which independently
reports the live count as 36. 37 passes, because `allowance` is 1 — that is the allowance working,
not slack going unobserved.

**One claim in this doc's own batch-1 section was measured WRONG.** It said `hooks/index.ts` is "a
one-word comment fix". Two comment regions needed changing: the `(Controls P3.5)` section heading
*and* the threshold-load-more note calling its callers "tenant tables".

**What batch 3 did NOT re-derive:** everything batches 1 and 2 left, plus the per-root split, the 434
promotion ceiling, and §7's cost table — all still computed against older classifications.

---

## Update 2026-10-06 — batch 4 of the blocker neutralisation

Batch 4 moves **both** axes, which no previous batch did: the closed set goes **442 → 457** and the
`domain-import` ceiling **36 → 34**. Batch 3's finding that the two are structurally independent is
the reason it takes two separate mechanisms to move them, not one.

| | after batch 2 | after batch 3 | after batch 4 |
|---|---|---|---|
| GENERIC / MIXED / COUPLED | 467 / 127 / 19 | 472 / 122 / 19 | **479 / 115 / 19** |
| import-closed subset (the 4 neutral extras) | 427 | 442 | **457** |
| …with NOTHING allowed alongside | — | 376 | **380** |
| `GENERIC` files outside the closure | — | 30 | **22** |
| distinct direct blockers | — | 32 | **25** |
| ceiling if every direct blocker were promoted | 434 | — | **471** |
| `domain-import` ceiling | 36 | 36 | **34** |
| `brand-as-text` / `storage-key` ceilings | 10 / 1 | 10 / 1 | 10 / 1 |
| population | 613 | 613 | 613 |

**The ranked remainder was re-derived, not inherited.** A resolver over `sharedUiPopulation()`, the
classification map and the real import edges (read through `codeOf`, `@/` and relative specifiers
resolved against disk) reproduced main's published figures exactly before anything changed — 613
population, 472 / 122 / 19, closed set **442**, with **0 unresolved** relative-or-alias specifiers as
the instrument control and 540 bare package specifiers skipped by design. A resolver that silently
resolved nothing would report the `GENERIC` set as perfectly closed, so that zero is the control the
442 rests on. Marginal gain was then measured per blocker under the STRICT model (promote it, require
it to be import-closed itself, re-run to a fixed point) — the same model §1 defines.

**The batch is the top of that ranking, filtered by one rule: promote only where the recorded
coupling is prose, provably stale, or dead code.** Seven files, with their measured marginal gains:

| file | gain | what it took |
|---|---|---|
| `date-picker/types.ts` | +4 | prose — "the Dub-originated presets renderer" → "the upstream presets renderer this picker was adapted from" |
| `checklist-gear-button.tsx` | +4 | **nothing** — the entry was stale |
| `table/pagination-utils.ts` | +3 | deleted `formatPageRange` |
| `dashboard-widgets/DashboardGrid.tsx` | +1 | prose — "the Inflect-flavoured contract", `OrgDashboardWidgetDto` |
| `filter/filter-definitions.ts` | +1 | prose — three JSDoc examples re-typed off `Control` |
| `filter/filter-context.tsx` | +1 | prose — one identifier in a usage example |
| `filter/use-filter-card-visibility.tsx` | +1 | prose — the 48-line docblock |

The individual gains sum to 15 and the realised figure is **+15** — but they were re-run as a
combination rather than added, and the check that proves it is worth copying. Un-promoting each of
the seven from the FINISHED tree costs 4, **5**, 3, 1, **2**, 1, 1 = **17**, which is two more than
the batch delivered. The two extra are not an interaction effect: **two of the seven are downstream
of two others inside the same batch** — `filter/use-filter-card-visibility.tsx` reaches
`checklist-gear-button.tsx` through `filter/edit-filters-button.tsx`, and `filter/filter-context.tsx`
imports `filter/filter-definitions.ts` — so each is counted once as itself and once as the upstream
file's follower. Removing all seven together returns the closed set to exactly **442**, which closes
the loop. The lesson for the next batch: a per-file gain measured on the pre-batch tree and a
per-file cost measured on the post-batch tree are different quantities, and only the combination
re-run and the round trip back to the base are safe to publish. The double-count was caught by an
assertion deliberately written to be impossible — "lost by one removal but not by all seven" — which
is where a chained member shows up.

**`checklist-gear-button.tsx` is the finding, and it cost nothing to fix.** Its only recorded
coupling was "One brand token is used as text" — **stale since #3102**, which replaced it with
`text-content-brand`. The three `--brand-*` tokens left are a background, a border-plus-background
and a ring: non-text, outside `BRAND_AS_TEXT` by design. This doc already flagged the entry as stale
and batch 3 already measured its price (2 blocked sources, where batch 1 had recorded its gain as 0).
Batch 4 paid none of it — **the whole of the fix was correcting the record**, and the closed set grew
by 4. A wrong entry is not a cosmetic defect; it is 4 files of package.

**`formatPageRange` was deleted rather than translated, and the entry had said so.** It built display
text from hardcoded English (an `"items"` default, a bare `" of "` connective) inside an otherwise
pure, React-free arithmetic module, and had ZERO callers in `src/`. The sentence it formatted is
composed in JSX by `pagination-controls.tsx:102-112` from `common.table.{viewing,of,items}` through
next-intl — so it was a second, UNTRANSLATED implementation of a string the product already renders
correctly. Translating it would have given the arithmetic module a `useTranslations` dependency and a
catalogue key for output no screen consumes. Two consequences recorded rather than left:
`tests/guardrails/date-display-consistency.test.ts` had `pagination-utils.ts` on its
`ALLOWED_LOCALE_FILES` exemption for the three `toLocaleString()` calls that went with the function,
so that entry is deleted too (the list is only consulted, never checked for staleness — an entry
outliving its cause keeps a future reintroduction invisible); and the four unit cases removed with
the function were the ONLY assertions anywhere on that string's shape, so the live i18n path is now
uncovered. Covering it needs a rendered test over `<PaginationControls>`, which is a different file's
gap and is not absorbed silently into this diff.

**The ceiling moved by widening `NEUTRAL_LIB`, and the AUDIT had already ruled that way.**
`resize-image` and `text-utils` join the allowlist on batch 2's measured rule — both resolve, and
both have ZERO import statements of ANY kind, so neither can pull a domain module in behind its
allowance. (The counting pattern was run as a discriminating pair rather than on the candidates
alone: `cn.ts` 2, `format-date.ts` 1, `resize-image.ts` 0, `text-utils.ts` 0.) What separates these
two from a judgement call is that #3047 had already decided them in the opposite direction to the
detector: `filter/filter-list.tsx`, the only importer of `@/lib/text-utils`, is recorded "no domain
import … coupling is copy alone", and `file-upload.tsx`, the only importer of `@/lib/resize-image`,
records three couplings that do not include its import. Both modules are this repo's first-party
replacements for the `Dub utils` shim, which is what #3046 exists to undo — so a shared component
importing one is the decoupled state, not a residual coupling. Both files stay `MIXED` on their
copy; only the mechanical reading changed. **34 is not a floor.** The cheapest remaining real
inversion is measured and recorded rather than taken: `ui/TruncationBanner.tsx` imports
`@/lib/list-backfill-cap` for exactly one thing, the default of its existing `cap?: number` prop, so
making `cap` required inverts the edge with no new mechanism — at a price of 10 call sites under
`src/app/t/[tenantSlug]`, which is why it is a batch of its own.

**`@/components/theme` was considered and NOT allowlisted.** `layout/user-menu.tsx` imports
`ThemeToggle` from it, and the temptation is that §2 already admits
`src/components/theme/ThemeProvider.tsx` as one of the four non-root files alongside the package. But
the directory holds two files and the admitted list holds one: carving out the namespace would assert
`ThemeToggle` neutral, which no pass has looked at, and §1 reserves it for step 4. The asymmetry the
`SHARED_COMPONENT_DIRS` docstring argues for therefore holds.

**The 471 ceiling did not move, and that is the useful shape of this batch.** Promoting *every*
remaining direct blocker reached 471 before batch 4 and reaches 471 after it. Batch 4 did not raise
the roof; it converted 15 of the 29 files between 442 and 471 from "available if somebody does the
work" into realised members. The gap left is 14.

**`format-date` is still the single largest lever, and still not ours to pull.** §2's
"admitting the four `@/lib` leaves takes the closed set 427 → 432" is re-measured as **457 → 462**,
still **+5** — and the re-measurement corrects the framing: only ONE of the four does anything.
`format-date` alone accounts for the whole +5; `kpi-trend`, `number-format` and `locale-constants`
admit nothing further as leaves (`kpi-trend` is +1 only in the strict model, where it counts itself).
This is a boundary decision about what the package's payload contains, not a decoupling, and three
batches have now declined to take it. It is the biggest number on the board at +5 against the next
candidate's +2, which is the argument for putting it to whoever owns the boundary rather than
settling it in a refactor batch.

**What batch 4 left on the ranking, with prices.** `card-list-card.tsx` **+2** — its
`selectionLabel = 'Select card'` default reaches the DOM as an `aria-label`, so the fix is a required
prop (zero product call sites pass it today, and one rendered test does). `nav-bar.tsx` **+1** — held
for #3100, which is rewriting it; its reason is one of the four on
`ui-core-classification.test.ts`'s `AWAITING_NAV_PR` list. `date-picker/presets-catalogue.ts` **+1**
— NOT prose: `DEFAULT_DATE_RANGE_PRESETS` carries the English labels the Presets panel renders
verbatim, so it is real i18n work. Everything else on the list gains **0**, `icons/index.tsx`
included, which blocks 7 files and still cannot be reached by a word fix (its second coupling is a
re-export block, as batch 3 recorded).

**What batch 4 did NOT re-derive:** everything batches 1–3 left — the per-root split, §7's cost
table, the consumer-manifest overlap figures, and the token measurements — all still computed against
older classifications.

---

## Current state — what was measured, and how

### The population

`sharedUiPopulation()` in `tests/helpers/shared-ui-couplings.ts` walks the four roots for
`.ts`/`.tsx` and returns **613** files, which is exactly the number of entries in
`docs/_status/ui-core-classification.json`. The per-root split has drifted from #3046's table
(572 / 27 / 1 / 13) while the total has not:

| root | #3046's table | today |
|---|---|---|
| `src/components/ui` | 572 | 569 |
| `src/components/layout` | 27 | 29 |
| `src/components/app-shell` | 1 | 1 |
| `src/lib/hooks` | 13 | 14 |
| **total** | **613** | **613** |

`git ls-files` over the same four roots returns **617**. The four extra are documentation —
`src/components/ui/filter/GUIDE.md`, `src/components/ui/table/GUIDE.md`,
`src/components/ui/hooks/README.md`, `src/components/ui/icons/nucleo/README.md` — outside the
population because the walker takes `.ts`/`.tsx` only. They are part of the shared surface in every
sense that matters to a consumer and are the easiest thing to forget; §1 puts them in the package.

### The classification, and the one number that is not what it looks like

**454 GENERIC / 140 MIXED / 19 COUPLED** (343 `audited`, 270 `mechanical`). The headline hides its
own shape: **333 of the 454 GENERIC files are `src/components/ui/icons/**`**. The non-icon GENERIC
count is **121**, which is the order of magnitude #3047's own header used for the keep-set ("the
~120-file keep-set playerz vendors").

| | GENERIC | MIXED | COUPLED |
|---|---|---|---|
| `src/components/ui/icons` | 333 | 6 | 2 |
| `src/components/ui` (everything else) | 105 | 111 | 12 |
| `src/components/layout` | 9 | 16 | 4 |
| `src/components/app-shell` | 1 | 0 | 0 |
| `src/lib/hooks` (incl. `__tests__`) | 6 | 7 | 1 |

### The finding: `GENERIC` is not a closed module graph

A package has to build. `GENERIC` is a verdict about one file's neutrality, and nothing in #3047
asked whether a `GENERIC` file *imports* a non-neutral one. It does, often:

- **43** of the 454 `GENERIC` files import a `MIXED` or `COUPLED` file directly — **82** edges onto
  **41** distinct targets.
- The **transitive** closure of the whole `GENERIC` set drags in **106** files that are not
  `GENERIC`: **75 MIXED**, **9 COUPLED**, and **22 that are not under any of the four roots** —
  among them `src/app-layer/schemas/org-dashboard-widget.schemas.ts`, which is a direct breach of
  the boundary rule in `docs/shared-ui-policy.md` clause 5, plus `src/lib/risk-coherence.ts`,
  `src/lib/kpi-trend.ts`, `src/lib/onboarding-steps.ts`, `src/lib/filters/filter-presets.ts`,
  `src/lib/api-client.ts`, `src/env.ts`, `src/lib/tenant-context-provider.tsx` and
  `src/lib/org-context-provider.tsx`.

So "ship the 454" is not a plan; it is a plan to ship most of `src/lib` as well.

The number that *is* a plan is the largest **import-closed** subset of the `GENERIC` set. Computed
by removing, to a fixed point, every `GENERIC` file with an edge leaving the set:

| allowed alongside the GENERIC set | closed size |
|---|---|
| nothing at all | **362** |
| the four neutral non-root files playerz already vendors — `src/lib/cn.ts`, `src/lib/ui-storage.ts`, `src/lib/auth/session-expiry.ts`, `src/components/theme/ThemeProvider.tsx` | **408** |

**408 files, 26,050 lines** — of which 333 files / 15,966 lines are icons and **75 files / 10,084
lines are the actual component and hook library**. The 46 `GENERIC` files that fall out do so
behind a short list of blockers: `src/components/ui/button.tsx` (MIXED) blocks 7 directly,
`src/components/ui/icons/index.tsx` 6, `src/components/ui/hooks/index.ts` 6,
`src/components/ui/date-picker/types.ts` 4, `src/components/ui/charts/layout.ts` 3.

And the marginal return on fixing them is poor, which is the part worth knowing before anyone
starts: neutralising `button.tsx` alone adds **4** files. Neutralising *all 41* direct blockers
reaches **434** and stops — 34 `GENERIC` files stay out, because the promoted blockers have
non-`GENERIC` dependencies of their own. **41 files of neutralisation work buys 26 files of
package.**

Instrument honesty: the resolver read **538** intra-repo edges and left **0** relative-or-alias
specifiers unresolved; **507** bare package specifiers (`react`, `next-intl`, …) were skipped by
design. A resolver that silently resolved nothing would report the GENERIC set as perfectly closed,
so the zero-unresolved figure is the control, and the 82 GENERIC→MIXED edges are the positive one.

### The consumer, measured rather than assumed

`docs/shared-ui-policy.md` says playerz "vendors a set of this repo's UI files byte-identical". The
manifests at `RodnaPamet/projectZ:docs/ui-sync/manifest/*.json` (9 files, fetched 2026-10-02) say
what that set actually is — and the headline there is also not what it looks like:

**494 manifest rows. 59 `vendored`. 435 `pending`.**

playerz has taken **59 files / 10,524 lines**. The other 435 rows are paths its guardrail *tracks*
so a hand-copy cannot land unnoticed; they are not copies. Three consequences:

1. **The four candidate roots do not cover the consumer.** 7 of the 494 tracked paths are outside
   them — `src/lib/cn.ts`, `src/lib/theme-constants.ts`, `src/lib/auth/session-expiry.ts`,
   `src/components/theme/ThemeProvider.tsx`, `src/components/theme/ThemeToggle.tsx`,
   `src/components/filters/FilterToolbar.tsx`, `src/components/nav/BackAffordance.tsx` — and **5 of
   those 7 are among the 59 already vendored**. A package scoped to the four roots leaves playerz
   still hash-syncing five files, so `scripts/ui-sync` survives the extraction and the issue's own
   objection applies to the result: "a package only inflect publishes and never consumes is a second
   copy with extra steps".
2. **The consumer wants files inflect's audit says are not neutral.** Of the 487 tracked paths
   inside the roots: 428 GENERIC, **58 MIXED, 1 COUPLED**. Of the 59 actually vendored: 49 GENERIC,
   **5 MIXED**, 5 outside the roots.
3. **The 408 and the 59 overlap by 38.** 21 of the vendored 59 are not in the import-closed set —
   `button.tsx`, `input.tsx`, `modal.tsx`, `popover.tsx`, `sheet.tsx`, `checkbox.tsx`,
   `status-badge.tsx`, `empty-state.tsx`, `error-state.tsx`, `confirm-dialog.tsx`,
   `radio-group.tsx`, `combobox/*`, `animated-size-container.tsx`,
   `layout/session-expired-notice.tsx`, and the five outside the roots. These are the primitives, not
   the periphery.

That is the real shape of the problem. The icons are 82% of the extractable file count and ~0% of
the difficulty; the 21 files the consumer actually leans on are the difficulty, and most of them are
blocked on `button.tsx`.

### Tokens, measured

`src/styles/tokens.css` (764 lines) defines **109** custom properties across two themes — `:root`
(dark) and `[data-theme="light"]`, with a `@media (prefers-reduced-motion: reduce)` tail. It is
imported from `src/app/globals.css`, which runs Tailwind **4.3.3** via `@import "tailwindcss"` plus
`@config "../../tailwind.config.js"`. **49** colour classes in that config resolve to a `var(--…)`.

The package's token contract is **45 of the 109**, and it does not grow with the file count —
measured identically over three different populations:

| population | files referencing ≥1 token | tokens in the contract |
|---|---|---|
| the 408 import-closed set | 28 | 44 (+1 component-local) |
| — its 75 non-icon files | 25 | 44 (+1) |
| — its 333 icons | 3 | 3 |
| the 59 playerz vendors today | 33 | 45 |
| the 494 playerz tracks | 69 | 45 |

Two things follow. **Only 28 of 408 files touch a token at all** — the icons are `currentColor`.
And **64 of the 109 tokens are the host application's alone**, so a package that shipped
`tokens.css` would ship the Inflect METRO palette, two themes of it, into a product whose brand is
not Inflect. The one `+1` is `--switch-thumb-x`, declared inline by the component that uses it
(`src/components/ui/switch.tsx:58-60`) — a component-local variable, not a theme token, and the
distinction matters to §4.

The 45: `--bg-{default,elevated,error,info,muted,overlay,page,subtle,success,warning}`,
`--border-{default,emphasis,error,info,strong,subtle,success,warning}`,
`--brand-{default,emphasis,muted,subtle,secondary-default}`,
`--btn-still-{bot,top,lift,press,danger,danger-deep,danger-lift}`,
`--content-{brand,default,emphasis,error,info,inverted,muted,subtle,success,warning}`,
`--ctrl-edge-{rest,hover,focus}`, `--primary`, `--ring`.

---

## 1. What is in the package

**The payload: the 408 import-closed files**, plus the four `GUIDE.md`/`README.md` files that sit
inside those directories and document them. Structure mirrors the source so a reviewer can diff a
move against a rename:

```
packages/ui/
  package.json          name @inflect/ui, private, no build step (see §3)
  tsconfig.json         extends the root, rootDir src
  README.md
  tokens.contract.css   the 45 required token names, with :root fallbacks (§4)
  src/
    components/ui/**         63   (of the root's 105 GENERIC non-icon files)
    components/ui/icons/**  333
    components/layout/**      7   (of 9 GENERIC)
    components/app-shell/**   0   (of 1 — see below)
    lib/hooks/**              5   (of 6 GENERIC)
    lib/
      cn.ts  ui-storage.ts  auth/session-expiry.ts
    index.ts              the public surface
```

63 + 333 + 7 + 5 = 408, and 63 + 7 + 5 = the 75 non-icon modules. (Superseded: the split is
79 + 333 + 7 + 7 = 426, 93 non-icon — see
[Update 2026-10-02](#update-2026-10-02--batch-1-of-the-blocker-neutralisation).)

**CORRECTED 2026-10-02 — there ARE two test files in the set, and §5.6's `testMatch` concern
bites.** This paragraph used to say "No test file is in the set", on the reasoning that both of the
classification map's two `GENERIC` co-located tests
(`src/components/ui/hooks/__tests__/use-threshold-load-more.test.tsx`,
`src/lib/hooks/__tests__/use-zod-form.test.tsx`) test `MIXED` hooks and so fall out of the closure.
That reasoning was sound and its premise has since gone: both hooks were neutralised in batch 1, so
both tests are now inside the closed set. Step 1 therefore does ship tests, and the
`testPathIgnorePatterns` entry §5.6 recommends adding "at step 1 rather than discovering it later"
is now load-bearing rather than precautionary.

`src/components/app-shell/shortcut-help-overlay.tsx` is the root's only file and it is `GENERIC`,
but it imports `src/components/ui/modal.tsx`, which falls out of the closure. So
`src/components/app-shell` contributes **nothing** in step 1. The blame has moved: this said
"behind `button.tsx`", and `button.tsx` is `GENERIC` and in the set since batch 1 — `modal.tsx`
falls out behind the `src/components/ui/hooks/index.ts` barrel instead, for one `useMediaQuery`
import.

**What happens to the MIXED set** (140 then, 132 now). They stay in `src/`. 58 of them are paths
playerz tracks and 5 are paths it has already copied, so "they stay" means the vendoring machinery
stays too, for those 5 files, until they are neutralised one at a time. The #3048 ratchet is the
enforcement that they do not get WORSE — read its ceilings from
`tests/guards/shared-ui-coupling-ratchet.test.ts`, not from here: the `domain-import` 41 /
`brand-as-text` 16 / `storage-key` 1 quoted in this sentence was already two re-seatings stale
(#3096 took brand-as-text to 10, #3098 took domain-import to 46) and this is a count stored beside
its own source, which is the mistake `doc-classification.json`'s deleted `counts` header records.
And the ratchet is not the *driver*: batch 1 removed nine blockers and moved none of the three
counts, because its couplings were all prose and `codeOf()` masks comments. The package grows when a
blocker stops being `MIXED`, which is not the same event as a ceiling falling.

**What happens to the 19 COUPLED.** Nothing. They are product composition by design —
`src/components/layout/AppShell.tsx` is the worked example, and its own in-file T07 comment
(lines 125-128) states that the `/processes` route literal belongs to the product rather than to the
frame. A COUPLED file is not a defect awaiting repair, and §7's cost estimate must not assume
otherwise.

**What is NOT in the package, and should be.** `src/components/theme/ThemeToggle.tsx`,
`src/lib/theme-constants.ts`, `src/components/filters/FilterToolbar.tsx` and
`src/components/nav/BackAffordance.tsx` are vendored or tracked by the consumer and lie outside all
four roots, so they are outside the classification map and outside every guard in §"What enforces
each clause" of `docs/shared-ui-policy.md`. They are unaudited by construction. Adding them to the
package means first adding their directories to `SHARED_UI_ROOTS`, which puts 4 more directories
into a population two guards floor at 600 — see §5.1. **Decision: out of step 1, named as the
step-4 extension**, because enlarging the roots and moving files out of them in the same change
makes the population figure impossible to reason about.

## 2. The boundary

What `@inflect/ui` may import:

1. **Itself** — relative paths within `packages/ui/src`.
2. **Peer dependencies, declared and not bundled**: `react`, `react-dom`, `next`, `next-intl`. All
   four are singletons in a Next app and a duplicated copy is a runtime fault, not a size problem.
3. **Regular dependencies**, from the measured import graph of the 408:
   `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `motion`, `sonner`, `vaul`,
   `cmdk`, `@tanstack/react-table`, `react-window`, `@number-flow/react`, `date-fns`, `zod`,
   `d3-array`, `@visx/{axis,event,group,shape,text,tooltip}`, and
   `@radix-ui/react-{accordion,checkbox,dialog,label,popover,switch,tooltip,visually-hidden}`.
4. **Nothing else.** In particular: no `@/app-layer`, no `@/lib/<domain>`, and — stated explicitly
   because the detector could not see it until #3098 widened the alternation —
   **no `@/components/<anything outside the package>`**.

**Reconciling with `NEUTRAL_LIB`.** Read the allowlist from
`tests/helpers/shared-ui-couplings.ts`, never from here — this paragraph quoted it as
`{cn, ui-storage, hooks, utils, format, dates, a11y, design, theme-constants}`, batch 2 changed it
(four dead names deleted, four measured-neutral leaves added) and batch 4 added two more. Two
corrections to what it said about that list, both measured:

- It claimed **five** of the nine named nothing, listing `design` among them. `src/lib/design/`
  exists (`status-tone.ts`, five importers in `src/app`). **Four** named nothing — `utils`,
  `format`, `dates`, `a11y` — and all four are deleted as of batch 2.
- "Unused entries are the expected steady state and not drift" conflates two cases. An unused
  allowance for a real module (`design`, `theme-constants` — neither is imported from inside
  `SHARED_UI_ROOTS`) is a dormant judgement. An allowance for a name that resolves to nothing is
  not dormant, it is false, and it cannot even be measured for neutrality. A guard now asserts
  every entry resolves.

**The package's dependency rule stays NARROWER than `NEUTRAL_LIB`, and that gap is now
load-bearing rather than incidental.** The four non-root files admitted alongside the package are
listed above; `format-date`, `kpi-trend`, `number-format`, `locale-constants` and (since batch 4)
`resize-image` and `text-utils` are neutral for the DETECTOR and are not on that list, which is why
`charts/layout.ts` and `timestamp-tooltip.tsx` are `GENERIC` and still outside the closed set.
Admitting them would take it **457 → 462** — first measured as 427 → 432 in
[Update 2026-10-03](#update-2026-10-03--batch-2-of-the-blocker-neutralisation), re-measured in
[Update 2026-10-06](#update-2026-10-06--batch-4-of-the-blocker-neutralisation), still **+5**, and
left as a decision for whoever owns this boundary. Read that update before quoting the +5 as a
figure for "the four leaves": `format-date` alone accounts for all of it, and the other three admit
nothing further. `theme-constants` is reserved for step 4 along with `ThemeToggle` (§1) — and batch 4
declined to allowlist `@/components/theme` for the same reason.

**The gap this boundary exposed in the existing guard — CLOSED by #3098, kept for the mechanism.**
As written here, `mechanicalCouplings` matched
`/from\s+['"]@\/(app-layer|lib)\/([\w.-]+)/` — the alternation was `app-layer|lib` and nothing else,
so **an import of `@/components/<x>` was invisible to the `domain-import` detector**.
`src/components/layout/ClientProviders.tsx` is recorded `GENERIC` and imports
`@/components/dev/swr-devtools` and `@/components/observability/WebVitalsReporter`. Those are two
product components inside a file claimed neutral, and no guard in the repo reports it. It is the
*only* such leak across all 454 `GENERIC` files, which is both reassuring about the audit and the
reason the hole has gone unnoticed. Widening the alternation to
`(app-layer|lib|components)` and allowlisting `components/{ui,layout,app-shell,theme}` would close
it; it belongs to #3048's guard, not to this design, and is reported rather than changed here.

## 3. How it is consumed

**By inflect: an npm workspace, consumed at HEAD, never version-pinned.** `package.json` has no
`workspaces` key today, so this is new infrastructure — one key, `"workspaces": ["packages/*"]`.
inflect imports `@inflect/ui`, npm symlinks `node_modules/@inflect/ui → packages/ui`, and a
breaking change inside the package breaks inflect's own `tsc` in the same commit. #3046 already
argued for HEAD over a pin and the argument holds: a pin reintroduces exactly the drift window the
issue exists to close, and there is no second-party release cadence to protect.

**No build step.** The package ships `.ts`/`.tsx` sources and the consumer compiles them, because
the consumer's Tailwind has to see the class strings anyway (§4) and a `dist/` would put a stale
compiled copy next to a fresh source one — a second copy with extra steps, again. `main`/`exports`
point at `src/index.ts`; Next 16 transpiles workspace packages without `transpilePackages` when they
ship source, which is **predicted** and is step 1's first verification (§6).

**By playerz: not npm.** Three routes, and the constraint that decides it:

| route | verdict |
|---|---|
| public npm registry | Possible — both repos are PUBLIC (`RodnaPamet/inflect-compliance`, `RodnaPamet/projectZ`). But the root `package.json` is `license: BUSL-1.1`, so publishing makes a source-available licence a registry artefact that anyone may install. That is an owner decision about licensing, not an engineering one, and §5.9 notes it also trips `npm run license:check`. |
| npm git dependency | **Not available.** npm cannot install a *subdirectory* of a git repository — `github:owner/repo#sha` installs the repo root and runs its `prepare`. `@inflect/ui` living at `packages/ui` is therefore unreachable this way. This is the hard constraint. |
| keep `scripts/ui-sync`, retargeted | Works today, costs nothing, and is the step-1 answer. |

So the migration step for playerz in step 1 is **one line of configuration, not a flag day**: its
`SYNCED_DIRS` (`scripts/ui-sync/manifest.mjs`) start reading `packages/ui/src/components/ui`
instead of `src/components/ui`, and its 494 `inflectPath` rows are rewritten by its own
`node scripts/ui-sync/paths.mjs --ref origin/main --write`, which exists for exactly this. Its
`check-portable.mjs` and manifest guard keep working unchanged. playerz becomes a package consumer
only if and when the licensing question is answered — and it does not have to be answered to get the
inflect-side benefit, because the benefit inflect gets is a boundary a compiler enforces.

**The honest reading of that.** With playerz still hash-syncing, the package's benefit in step 1 is
*not* "the same fix stops being applied N times" — that benefit needs a real package consumer. It is
"a file in `packages/ui` that imports `@/app-layer` fails `tsc` instead of failing a regex". Whether
that is worth the §5 bill is §7.

## 4. Tokens and CSS

**The package requires tokens. It does not ship them. It ships their names.**

`src/styles/tokens.css` stays exactly where it is, in `src/`, for a reason that is measurable rather
than conservative: 10 test files read it by that path, including
`tests/guardrails/token-css-integrity.test.ts` (which cross-checks it against `tailwind.config.js`),
`tests/guardrails/light-mode-parity.test.ts` (which requires every `:root` token to have a
`[data-theme="light"]` counterpart) and `tests/guardrails/token-contrast-content-brand.test.ts`.
Those guards assert things about *Inflect's palette* — that `--content-brand` clears 4.5:1 on
Inflect's surfaces. They are not assertions a shared package can make about an unknown consumer's
brand, and moving the file would either break them or export a contrast claim the package cannot
keep.

What the package ships instead is **`packages/ui/tokens.contract.css`**: the 45 names from the
measured contract, each declared on `:root` with a **neutral, WCAG-checked fallback**, and a header
saying that a consumer is expected to override all 45. Three properties make this the right shape:

- **A missing token degrades visibly, not invisibly.** An undefined custom property resolves to the
  *initial* value — `background-color: var(--bg-page)` with no `--bg-page` renders transparent, which
  is how #3047's `tailwind.config.js` comment describes the radio dot "filling with a transparent
  dot". A fallback layer turns a forgotten override into "the wrong colour", which someone sees.
- **The contract is small and it is closed.** 45 names, stable across the 59-file, 408-file and
  494-file populations. It can be a checked list rather than an aspiration.
- **It does not leak the brand.** The 64 host-only tokens — the METRO navy ramp, the canvas surfaces,
  the nav-band animations — stay in `src/styles/tokens.css` and never reach a consumer.

`--switch-thumb-x` needs no entry: it is declared and consumed inside `switch.tsx` through
Tailwind's arbitrary-property syntax (`[--switch-thumb-x:1rem]`). The rule the contract file states
is the distinction — **a theme token is overridable by the host and belongs in the contract; a
component-local variable is an implementation detail and must stay inside its component.**

**The precedent, already measured, for the failure mode this section is about.** #3084 is open right
now and is the same class: `src/components/ui/button-variants.ts` builds its Still Surface classes
inside `stillTile()` as template literals, Tailwind never evaluates the function, and twelve classes
are absent from the built CSS — playerz measured it on a production build and the destructive button
rendered **with no fill, white label on white**. Two things follow for this design. First,
`button-variants.ts` **is in the 408**, so step 3 would move a file with a known
Tailwind-scanning defect. Second, playerz's workaround — a `STILL_TILE_CLASSES` list in *its*
`tailwind.config.ts`, plus a guard that evaluates `buttonVariants()` and fails on any class not
written literally — lives on the consumer's side and the package cannot see it. That is precisely
the "no mechanical check on either side" hole named below, demonstrated rather than predicted.
**#3084 should land upstream before `button-variants.ts` moves**, or the package ships the bug and
the only thing that catches it is a guard in a different repo.

**The Tailwind half, which is the fiddly part #3046 warned about.** `tailwind.config.js` holds the
token→utility mapping (49 colour classes → `var(--…)`), the `3xl` breakpoint, the `scrollbar-hide`
plugin, and the animation composites including the four-track `nav-band-active-alive` whose
declaration order `tests/guards/r13-active-band-secondary.test.ts` pins. **The config stays with the
application and is not part of the package.** The package instead documents, in its README, the
`theme.extend.colors` subtree a consumer must merge — and this is the *only* part of the design with
no mechanical check on either side, because neither repo can see the other's config at build time.
Named as a known hole rather than papered over; the closest available mitigation is that playerz's
`check-portable.mjs` already refuses unrecognised class names on its side.

And the sharp edge: **Tailwind 4.3.3 will silently stop generating the package's classes.**
`content: ['./src/**/*.{js,ts,jsx,tsx,mdx}']` does not match `packages/ui/**`, and v4 does not scan
paths git ignores, so it will not find the package under `node_modules` either. The symptom is not
an error — it is correct markup with no styles, on a green build. The fix is one line in
`src/app/globals.css`:

```css
@source "../../packages/ui/src";
```

…and the verification is a rendered assertion, not a build (§6, step 1).

## 5. What breaks

Ordered by how quietly it breaks.

**5.1 The population floor — the one that stops step 1 dead.** Two guards assert a hard minimum on
the shared-UI population:

- `tests/guards/ui-core-classification.test.ts` — `expect(POPULATION.length).toBeGreaterThan(600)`
- `tests/guards/shared-ui-coupling-ratchet.test.ts` — `expect(sharedUiPopulation(ROOT).length).toBeGreaterThan(600)`

The live population is **613**. **The margin is 13 files.** Moving 14 out of the roots fails both;
moving the 408 leaves 205 and fails both by a mile. This is the failure class the repo has paid for
before and both guards were written to prevent — a denominator that shrinks while the assertion
stays green — so the floor is doing its job, and the answer is not to lower it. It is to make
`SHARED_UI_ROOTS` name the package directory alongside `src/`, so the population is preserved across
the move and the floor keeps meaning what it meant. That is an edit to
`tests/helpers/shared-ui-couplings.ts`, and it must land **before** the move, in its own commit,
verified by the population count being *unchanged* at 613.

**5.2 The same ratchet's liveness assertion, which fails in the other direction.**
`shared-ui-coupling-ratchet.test.ts` also asserts `expect(live[kind]).toBeGreaterThan(0)` for all
three kinds, "so the ceilings are known to be measuring something". `storage-key` has a live count
of exactly **1**, with `allowance: 0`. If the file carrying it is in a moved set and the roots are
not updated first, that assertion fails — and it fails for a *good* reason that looks identical to
the bad one. Same fix, same ordering, and the replay the guard's own docstring demands applies here
too: restore the old roots, confirm the assertion fails, restore the new ones.

**5.3 173 test files hardcode a source path under the four roots.** Measured by grepping `tests/`
for a quoted literal beginning `src/components/{ui,layout,app-shell}` or `src/lib/hooks`: **173
files, 183 distinct paths**, plus 8 more paths across 3 files in `scripts/codemods/`. Separately, 263
test files import via the `@/components/ui` alias, which an alias mapping can absorb — these 173
cannot, they are `fs.readFileSync` arguments. Several
guards already handle this gracefully — `ui-core-classification.test.ts`'s positive controls carry
`if (!fs.existsSync(...)) continue; // moved; covered by the coverage case`, which is foresight
worth noting — but most do not. This is the bulk of the mechanical work and it is the reason §6 moves
files in small batches: a 183-path rewrite reviewed as one diff is a diff nobody reads.

**5.4 Tailwind content globs.** §4. Silent. `@source "../../packages/ui/src"` in
`src/app/globals.css`.

**5.5 tsc path aliases.** `tsconfig.json` has one alias, `"@/*": ["./src/*"]`, with
`include: ["**/*.ts", "**/*.tsx"]` and `exclude` already listing `.claude`. The `include` glob picks
up `packages/` for free; `@inflect/ui` resolves through the workspace symlink. A `paths` entry is
*not* wanted — it would let inflect resolve the package without the workspace link being correct,
which hides a broken install.

**5.6 jest moduleNameMapper, in three places.** All three projects carry
`{'^@/env$': …, '^@/(.*)$': '<rootDir>/src/$1'}` — `jest.config.js:174-177` (node),
`349-352` (jsdom) and `559-562` (flue). Module resolution for `@inflect/ui` goes through
`node_modules`, so no new mapper is needed *if* the workspace is installed; but the node project's
`testMatch: ['**/*.test.ts', '**/*.test.js']` will start collecting any test file inside
`packages/ui`, under the node environment, where a `.tsx` render test does not belong. **No longer
precautionary (2026-10-02):** this said step 1 was safe because the set contained no test file at
all, which was true of a closure of 408 and is false of 426 — batch 1 neutralised the two `MIXED`
hooks that were keeping their own `GENERIC` co-located tests out, so the set now contains
`use-threshold-load-more.test.tsx` and `use-zod-form.test.tsx`, both `.tsx`. The
`testPathIgnorePatterns` entry has to land with step 1.

**5.7 Coverage denominator and the `./src/lib/` floor.** `collectCoverageFrom` excludes
`src/components/**` entirely, so the 70 component files cost nothing. But it *includes*
`src/lib/**/*.ts` and `src/lib/**/*.tsx`, and `jest.thresholds.json` carries a per-directory floor
for `./src/lib/` of **78/81/89/88**. Five of the 75 shippable files live under `src/lib/hooks`
(`keyboard-shortcut-internals.ts`, `use-hydrated-now.ts`, `use-keyboard-inset.ts`,
`use-keyboard-shortcut.tsx`, `useUrlFilters.ts`) and the jest config's own comment names "the
keyboard-shortcut hook" as part of what earned that floor. Moving them changes the denominator in
an unknown direction. Unmeasured here — measuring it needs a full `--coverage` run — and therefore
a step of its own in §6 rather than a footnote.

**5.8 eslint overrides that fail open.** `eslint.config.mjs` has a `files:` block naming
`src/components/ui/hooks/use-copy-to-clipboard.tsx`, which is in the 408; an override whose glob
stops matching produces no error, it just stops applying. Two `no-restricted-imports` rules target
import specifiers rather than files — `name: '@/components/ui/skeleton'` and
`group: ['@/components/ui/table/*']` — and both stop matching the moment a caller writes
`@inflect/ui`. Three silent regressions, cheap to fix once named.

**5.9 Licence, and the check that enforces it.** The root package is `private: true`,
`license: BUSL-1.1`, and `npm run license:check` fails the build on any BUSL-1.1 *dependency*,
excluding only `inflect-compliance@$npm_package_version` by name. A workspace package licensed
BUSL-1.1 becomes a dependency that check does not exclude. Fix is an `--excludePackages` entry; the
larger question — what licence `@inflect/ui` carries if it is ever published — is §3's owner
decision.

**5.10 Docker.** `COPY . .` in the builder stage brings `packages/` along, and `.dockerignore`
excludes nothing relevant. But the `deps` stage does `COPY package.json package-lock.json ./` and
then `RUN npm ci`, and a workspace lockfile references `packages/ui/package.json`, which that stage
never copies. **Predicted**, not verified: `npm ci` is expected to fail there and need
`COPY packages/ui/package.json ./packages/ui/`. Verified by building the image, which is step 1's
last gate.

**5.11 What does *not* break, checked rather than assumed.** No guard globs `**/package.json`; none
enumerates the repo root's directories. `tests/guardrails/source-scan-population.test.ts` derives
from `git ls-files --cached --others --exclude-standard`, so a tracked `packages/` tree enters its
population automatically and correctly. `scripts/docs-lint.mjs` has one index (the RQ3 capstone) and
does not look at this document. The `.dockerignore` and `tsconfig` `.claude` exclusions are already
in place.

---

## Roadmap — the sequence, and what verifies each step

*(This is section 6. It is named `Roadmap` rather than numbered because this doc is
classified `living`, and `tests/guardrails/docs-accuracy.test.ts` requires a literal
`^## Roadmap` H2 of every living doc — so the heading cannot carry its number. The gap
between §5 and §7 is that requirement, not a missing section.)*

The constraint is §5.1: the population floor has a 13-file margin, so **no file moves until
`SHARED_UI_ROOTS` covers its destination.** And the in-flight shared-UI work must land first — a
file move conflicts with every open PR that edits the moved file, and resolving that conflict is
indistinguishable from discarding the PR's change. #3084 is the named one: it is open, it is about
`src/components/ui/button-variants.ts`, and that file is in the move set (§4).

| # | step | verified by |
|---|---|---|
| 0 | Wait. No moves while any PR touching `src/components/ui`, `src/components/layout` or `src/lib/hooks` is open. | `gh pr list` returns no open PR whose files intersect the move set. |
| 1 | **Teach the guards the new address, move nothing.** Add `packages/ui/src/components/{ui,layout,app-shell}` and `packages/ui/src/lib/hooks` to `SHARED_UI_ROOTS`; create `packages/ui` with `package.json`, `tsconfig.json`, an empty `src/index.ts`, `tokens.contract.css`; add `"workspaces": ["packages/*"]`; add `@source` to `globals.css`; add the `--excludePackages` entry. | `sharedUiPopulation()` still returns **613** — unchanged, because nothing moved. `CI=1 npx jest tests/guards/ui-core-classification.test.ts tests/guards/shared-ui-coupling-ratchet.test.ts` green. `npm ci` green. `npm run license:check` green. Docker image builds (§5.10). |
| 2 | **Move the 333 icons.** The whole of `src/components/ui/icons/**` that is `GENERIC`, nothing else. Rewrite the imports; update the **9** test files that read an icon source path (`motion-language`, `motion-language-discipline`, `no-lucide`, `raw-color-eradication`, `rq4-2-arrow-left-icon`, `sort-affordance`, `state-language`, `ui-core-classification`, `rendered/sort-order-initial-d`). | Population **613** again (the map's keys change, the count does not). Classification guard's `missing`/`stale` both empty. One rendered test asserting an icon still paints — this is the §4 Tailwind check, and it is the step where `@source` is proved rather than assumed. |
| 3 | **Move the 75 non-icon modules in batches by directory** — `hooks/`, then `table/`, then the flat primitives, then `layout/`. One directory per PR, so each rewrite of §5.3's 183 paths is reviewable. Hold the 5 `src/lib/hooks` files back to last. | Per batch: population 613, `tsc --noEmit` exit 0, and the specific guards naming that directory's files. Before the `src/lib/hooks` batch, a full `npm run test:coverage` to measure §5.7 against the `./src/lib/` floor of 78/81/89/88 — and if it moves the floor, re-seat the floor in the same PR with the measurement in the message. |
| 4 | **Extend the roots to the consumer's other four files** — `src/components/theme/{ThemeProvider,ThemeToggle}.tsx`, `src/lib/theme-constants.ts`, `src/components/filters/FilterToolbar.tsx`, `src/components/nav/BackAffordance.tsx`. Classify them first (they are unaudited by construction, §1), then move the neutral ones. | The classification guard covering a population that grew by 5-ish, with every new file triaged. This is the step that lets playerz stop hash-syncing *anything*. |
| 5 | **playerz retargets `SYNCED_DIRS`** and regenerates its 494 rows with its own `paths.mjs --write`. | Its manifest guard green; its `check-portable.mjs` green; a `status.mjs` run showing 0 drift. |
| 6 | **Then, and only then, decide whether `@inflect/ui` is published.** By that point the boundary is compiler-enforced and the consumer is one config line from being a package consumer, so the licensing question (§3) can be answered on its merits instead of as a prerequisite. | — |
| 7 | **Ratchet the MIXED set down and the package grows** — but NOT "for free under the existing #3048 ceilings", which is measured wrong. `counts()` derives from source and never opens the classification map, so a reclassification cannot move a ceiling and a ceiling decrement need not admit a file. Batches 2-4 ran the experiment in both directions: batch 3 took the closed set 427 → 442 with the ceiling fixed at 36, and batch 4's ceiling move (36 → 34) admitted nothing by itself. Two mechanisms, tracked separately. | `domain-import` **34** → lower, by inverting an import or measuring a leaf neutral; the closed set by promoting a blocker. Re-run the ranking each time — the gains are not inheritable. |

Nothing above needs the 454 to become extractable. The sequence is ordered so that the cheapest
408 files land first and the expensive 46 are a consequence of work #3048 is already doing.

## 7. The honest cost

#3046's position was: *"With one consumer the vendoring works and the package is cost without
benefit."* Measured, that position is **mostly right, and right for a reason the issue did not
have.**

**What the package actually delivers in step 1.** 408 files, of which 333 are icons that were never
hard, and 75 real modules — **38 of which the consumer already has**. The 21 primitives playerz
leans on most (`button`, `input`, `modal`, `popover`, `sheet`, `checkbox`, the combobox,
`status-badge`, the two state components, `confirm-dialog`) are **not** in the shippable set,
because `button.tsx` is MIXED and most of them route through it. So the first package ships the
library's periphery and leaves its centre vendored. That is the finding that matters: **the
extraction cannot reach the files the consumer depends on until the MIXED set is neutralised, and
that is #3048's work, not this issue's.**

**What it costs, itemised, nothing estimated that was measurable.**

| item | measured |
|---|---|
| test files rewriting a hardcoded source path | **173 files, 183 paths** |
| guards needing a roots change before any move | 2, both with a **13-file** margin |
| config files touched | 6 — `package.json`, `tsconfig.json`, `jest.config.js`, `eslint.config.mjs`, `globals.css`, `Dockerfile` |
| new mechanism with no mechanical check on either side | 1 — the `tailwind.config.js` `theme.extend.colors` contract (§4) |
| lines moved | **26,050** (icons 15,966 / library 10,084) |
| MIXED files to neutralise to reach the next 26 files | **41** |
| files the consumer gains that it does not already have | **37** of 75 non-icon, plus 331 icons |

**What it buys.** One thing, and it is real: a boundary the compiler enforces. Today "this file is
product-neutral" is a regex over a string, and §2 shows that regex has a hole wide enough that the
single actual violation in 454 files has sat in `ClientProviders.tsx` unreported. In
`packages/ui`, `import … from '@/app-layer/…'` does not resolve, and `tsc` says so. That is a
categorically stronger guarantee than a ratchet, and it is the argument for doing this at all.

**What it does not buy, yet.** The thing the issue was actually about. "The same fix applied N times,
N manifests to re-hash" needs playerz to *consume* the package, and §3 shows that is blocked on a
licensing decision (BUSL-1.1, and npm cannot install a git subdirectory). Until then playerz keeps
hash-syncing — the same loop, pointed at a different directory. The duplication does not end at step
5; it ends at step 6.

**The recommendation.** Do steps 1 and 2 — they are cheap, they are reversible, they prove the
Tailwind `@source` question that everything else depends on, and step 1 moves no files at all. Then
judge step 3 against what step 2 taught, because 183 path rewrites is the point where this stops
being cheap. And treat the §2 detector hole as the more urgent finding regardless of whether the
package is ever built: it is a hole in a guard that is live today, over files that are shared today.
