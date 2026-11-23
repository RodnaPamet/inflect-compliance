# 2026-11-23 — Mobile phase 0: the audit harness, a mobile E2E project, its ratchet, and the phone checklist item

Mobile plan Phase 0 (#5806, #5807, #5808, #5809). Usage and metric definitions
are in `docs/mobile-audit.md`; this note records the shape and the decisions.

## Design

```
scripts/mobile-audit/
  measure.ts   ← THE definition of every metric (runs in the page) ──┐
  leaks.ts     ← English-on-a-Bulgarian-page, Node-side, pure        │
  configs.ts   ← 390/360 × dark/light × bg/en, touch                 │
  routes.ts    ← every src/app/**/page.tsx                           ├─ imported by
  resolve.ts   ← dynamic segments from the database, per route       │  tests/e2e/mobile-*.spec.ts
  states.ts    ← open states (drawer, menus, sheets, selection)      │
  auth.ts      ← sign-in via tests/e2e/e2e-utils                    ─┘
  records.ts   ← --create-records: what the seed lacks, via the API
  report.ts    ← metrics.json, summary.md, compareReports
  run.ts       ← the CLI (npm run mobile:audit)
```

`collectInPage` reads layout only (boxes, computed styles,
`elementFromPoint`), so its answers do not depend on device scale or
screenshots. `measurePage` sends it to the page as source text with a
`__name` shim in front, because `tsx` (the harness) compiles with esbuild's
`keepNames` and Playwright's test runner does not: the same function would
otherwise throw in one caller and not the other.

The E2E project (`mobile` in `playwright.config.ts`) holds a fixed route set
(`tests/e2e/mobile-ratchet.ts`) to four zero-tolerance invariants and ratchets
the number of routes failing each other metric, per configuration, with
`DRIFT_ALLOWANCE` 0. Defects that the zero-tolerance invariants find on the
fixed set and that are still open are listed in `KNOWN_DEFECTS` with their
issue, and the spec asserts that they are still present.

## Files

| File | Role |
| --- | --- |
| `scripts/mobile-audit/*.ts` | The harness and the shared measurement module. |
| `tests/e2e/mobile-ratchet.ts` | Fixed route set, known defects, baselines (the only place the figures live). |
| `tests/e2e/mobile-support.ts` | Load, measure, invariants and ratchet steps shared by the two layout specs. |
| `tests/e2e/mobile-layout.spec.ts` | Fixed routes on the shared seeded tenant, read-only. |
| `tests/e2e/mobile-layout-records.spec.ts` | P0 pages whose records the seed lacks, in an isolated tenant. |
| `tests/e2e/mobile-measure.spec.ts` | Each metric proved against its defect on `setContent` pages. |
| `tests/unit/mobile-audit-leaks.test.ts`, `tests/unit/mobile-audit-routes.test.ts` | Leak detector, route enumeration, resolver coverage, report comparison. |
| `playwright.config.ts` | The `mobile` project; `e2e` ignores the mobile specs. |
| `docs/mobile-audit.md` | How to run both tools and what each metric means. |
| `docs/new-subsystem-checklist.md`, `CLAUDE.md` | "Renders on a 360 px phone". |

## Decisions

- **The fixed set is ratcheted in CI, and the whole product is not.** A
  whole-product pass is about 165 page loads per configuration. In the shared
  E2E job, next to the rest of the suite, that would be several minutes of
  browser time on every run, and its exact counts would fail on any slow page
  across 165 navigations. The fixed set is about 20 loads per configuration,
  so it adds roughly a minute of wall-clock time on two workers. A pull request
  that changes many pages compares two harness runs (`--compare`), which fails
  on any count that rose. No whole-product figure is stored in the repository.
  A stored figure that nothing recomputes on every change would go stale.
- **The ratchet counts routes failing a metric, not elements.** The shared
  tenant's list pages show seeded rows, and a ratchet with no allowance must
  not move because a row was added. A whole-route count still moves when a
  page is fixed or broken.
- **No workflow change.** The new project runs in the existing `npx playwright
  test` call. `e2e` ignores the mobile specs, so nothing runs twice.
- **Known defects flip per defect, not per test.** One test per
  configuration loads every route after a single sign-in, which is far cheaper
  than signing in once per route. `KNOWN_DEFECTS` therefore gives
  `test.fail`'s behaviour per (route, invariant): the fix fails the assertion
  until its entry is deleted.
- **Dynamic ids come from the database, not from list pages.** Many list pages
  open a row with `router.push`, so there is no link to scrape. One resolver
  per route pattern, because `runId` and `agentId` name different records on
  different routes. A dynamic route with no resolver fails a unit test.
- **The leak detector judges seeded data only against the catalog.** Seed
  records are English. The word heuristic applies only to labels of three
  words or fewer in UI chrome, and tenant and org names are skipped. A
  placeholder message counts only when its literal text is long enough not to
  match data (`User {name}` against "User Endpoint Devices").
- **Tap targets count pseudo-element hit areas.** `TOUCH_HIT_AREA_CLASS` grows
  a small icon's hit area to 44 px with a positioned `::after`. Measuring only
  the element's own box would call every such control too small.
- **`--create-records` is opt-in.** It writes through the API. The kinds it
  cannot create (a registered agent, a workflow run, an A2A peer, an
  integration connection, a trust center, a vendor assessment, NIS2
  assignments) are reported as uncaptured, each with its reason.
