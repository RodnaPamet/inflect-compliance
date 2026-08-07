# 2026-08-07 — Controls: route boundaries, and a ratchet that measured the wrong thing

**Commit:** `<pending> refactor(controls): promote shared components out of the route`

Part 1 of the Controls structural work — the enforcement half. The heavy
refactors (usecase module, filter fork, autosave extraction, `fetch`
migration, bulk-action tests) follow in part 2.

## `controls/` was a shared namespace pretending to be a route

Five surfaces depended on Controls internals. `AttachedEvidencePanel` — a
file in `src/components/` — imported `EvidenceSubTable` from
`controls/[controlId]/_tabs/`, a Next.js `_`-prefixed directory whose entire
purpose is to signal PRIVATE. Tasks imported `TaskEditPanel` and
`EvidenceSubTable` directly; Risk detail and Asset detail inherited both
transitively.

**The i18n consequence was concrete.** Both components called
`useTranslations('controls')`, so the Tasks list, Task detail, Risk detail
and Asset detail pages rendered copy from the `controls` namespace — a
translator editing `controls.*` was editing four non-control pages.

### What moved

`EvidenceSubTable`, `TaskEditPanel` → `src/components/controls-shared/`,
and with them the three siblings they depend on (`PanelTabs`,
`PanelActivityFeed`, `ControlTaskRows`) — otherwise the promoted components
would import back into the route and recreate the violation one level down.

`TestPlanDetailView`, `TestStepsEditor`, `test-plan-labels` →
`src/components/test-plans/`. That is the same leak **in reverse**: the
Controls surface reached into the Tests surface's `_components/`.

### The i18n split

A new `sharedPanels` namespace holds the 37 keys the two promoted components
use. Of those, **28 moved** (nothing under `controls/` referenced them any
more) and **9 were copied** (Controls still uses them). Both locales carry
all 37; `en.json` and `bg.json` remain at 8,230 keys with zero drift.

## The line-count ratchet is replaced

`controls-detail-page-size.test.ts` pinned `page.tsx` at `MAX_LINES = 1404`
with 21 lines of headroom, and a history of three raises (+122) against one
drop (-106) — net upward. Its failure message claimed the page was "the
largest in the codebase"; it was 6th, and `ControlsClient.tsx` on the same
surface is ~1,958 lines and was never capped, so content could move from the
capped file to the uncapped one and the ratchet would call that progress.

Worse, it **caused** the coupling above: `EvidenceSubTable` was extracted
into `_tabs/` "per the page-size ratchet", and that private directory became
a four-surface dependency. A line cap rewards moving code ANYWHERE out of the
capped file, so it went to the nearest directory rather than the right one.

Replaced by two measures of the thing the cap was a bad proxy for:

- `route-import-boundaries.test.ts` — WHERE code lives. Three rules:
  `src/components/**` never imports a route; no route surface imports
  another's internals; nothing crosses into a `_`-prefixed directory.
- a **state-hook cap** on the detail page — how much it ORCHESTRATES.
  Moving JSX out does not move this number; moving a concern does.

The state cap documents its own near-miss: I set it from a `useState(` grep
(18) when the test counts `useState<T>(` too (24). The test caught it, which
is the argument for the assertion being the measurement.

## Scope honesty: nine pre-existing violations

The new boundary guard found nine violations OUTSIDE Controls — six in the
Processes canvas, one in `LinkedTasksPanel`, one Calendar→Tasks. Each is the
same inversion and deserves the same fix, but doing it here would turn a
Controls change into a Processes/Calendar refactor with no test coverage of
its own. They are in a `BASELINE` with written reasons and a
**no-stale-entries** check, so the list can only shrink.

## Decisions

- **Moved the siblings too, rather than leaving absolute back-imports.**
  Promoting a component that still reaches into the route it left would
  satisfy the letter of the guard and none of its point.
- **28 keys moved, 9 copied — decided per key**, not wholesale. A blanket
  move would have broken Controls' own copy; a blanket copy would have left
  translators maintaining 37 duplicates.
- **Fourteen guards referenced the moved files by path.** Updating them is
  the visible cost of the coupling, and exactly what the boundary guard now
  prevents accumulating again.
