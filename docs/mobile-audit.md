# Mobile audit and the mobile E2E project

Two tools measure how the product renders on a phone, and both use ONE module
for every measurement: `scripts/mobile-audit/measure.ts`. A metric means the
same thing in a whole-product report and in a red CI run.

| Tool | What it covers | When it runs |
|---|---|---|
| The mobile E2E project (`--project=mobile`) | A fixed set of routes: one per shared primitive, plus the P0 pages | Every E2E run in CI, in the same `npx playwright test` invocation as the rest of the suite |
| The audit harness (`npm run mobile:audit`) | Every `src/app/**/page.tsx` route and eight open states | On demand, against a running app |

The audit that started this work, its findings and the plan to fix them are in
[the mobile audit and plan](mobile-roadmap.md).

## The metrics

Each metric is counted per element. A page FAILS a check when its count is
above zero. The definitions live in the docblock of `measure.ts`. In short:

| Metric | A page fails it when |
|---|---|
| `clipped` | Something interactive, or a run of text, extends past the screen edge and no ancestor scrolls sideways to reveal it. The app shell clips horizontal overflow instead of scrolling it, so this is the real overflow signal. Text cut inside a smaller box (an ellipsis) is not counted. |
| `overlayCoversControl` / `overlayCoversText` | With the page scrolled to its end, an element fixed in the lower half of the screen is the topmost thing over a control, or over text. |
| `tapUnder24` / `tapUnder44` | An interactive element in the page body (the top bar is excluded) has a hit area under 24 / 44 px on its short side. A positioned `::before`/`::after` counts towards the hit area (`TOUCH_HIT_AREA_CLASS`). A link inside a sentence is exempt. |
| `textUnder12` | Text renders under 12 px. |
| `inputUnder16` | A text field, select, textarea or editable region renders under 16 px, which makes iOS Safari zoom on focus. |
| `tabsNoCue` | A `role="tablist"` overflows and shows no cue: no `ScrollCueStrip` overflow marker, no fade mask, no visible scrollbar. |
| `buttonWraps` | A wrapping row of three or more buttons or links lays out on three or more lines. |
| `wideTables` | A `<table>` is wider than the screen. |
| `englishLeaks` | English UI text on a Bulgarian page. `scripts/mobile-audit/leaks.ts` decides, from `messages/en.json` and `messages/bg.json`, English dates, and short hard-coded control labels. Seeded data is never judged by the word heuristic. |
| `docScrollsSideways` | The document itself scrolls horizontally. |
| `consoleErrors` | The page logged a console error (audit only; never ratcheted). |

`tests/e2e/mobile-measure.spec.ts` proves each metric against the defect it
names: every case renders a small page WITH the defect and the same page with
the defect fixed, and measures both.

## The mobile E2E project

`playwright.config.ts` defines a `mobile` project with the iPhone 14 profile
(touch, so `pointer: coarse` matches) on Chromium. It runs three specs:

- `mobile-layout.spec.ts` loads the routes in `SEED_ROUTES` (in
  `tests/e2e/mobile-ratchet.ts`) against the shared seeded tenant, read-only.
  Some entries open a state first: the user menu, the navigation drawer, the
  command palette, the assistant sheet, the create sheet, and a ticked card
  with the selection toolbar.
- `mobile-layout-records.spec.ts` covers the P0 pages whose records the seed
  lacks (a test plan, a business impact analysis). It creates them through the
  API in an isolated tenant.
- `mobile-measure.spec.ts` holds the metric proofs described above.

Each layout spec runs once per configuration: 390 px dark and 360 px light,
both in Bulgarian. That covers both widths, both themes and the longer
language. Every route is held to two kinds of check:

1. **Four zero-tolerance invariants.** Nothing interactive is clipped outside
   a scroll container, no field is under 16 px, no floating overlay covers a
   control at full scroll, and no overflowing tab bar lacks a cue. A route
   that still breaks one is listed in `KNOWN_DEFECTS` with the open issue that
   fixes it. The spec then asserts that the defect is still present, so the
   fix turns the assertion red until the entry is deleted in the same pull
   request.
2. **The ratchet.** For each configuration, the number of routes failing each
   ratcheted metric must EQUAL the baseline in `mobile-ratchet.ts`. If a count
   rises, a page regressed. If a count falls, a page was fixed, and the
   baseline must be lowered in the same diff. `DRIFT_ALLOWANCE` is 0, so no
   slack accumulates. The counts are routes failing a metric, not elements: a
   list page's element count moves with the seeded rows, and a ratchet with no
   allowance must not move on data. Every fixed route must load, so a page
   that stops rendering fails the run instead of lowering a count.

Run it locally against a built app: `npx playwright test --project=mobile`.
The ratchet's figures are written down only in `tests/e2e/mobile-ratchet.ts`.

## The audit harness

It runs against a running app. The reference setup is the E2E build: `next
build` with `NEXT_TEST_MODE=1`, then `next start`, on a database seeded by
`prisma/seed.ts`.

```bash
DATABASE_URL=… npm run mobile:audit -- --base-url http://localhost:3006 --create-records
```

- **Routes** come from the file system (`routes.ts`), so a new page is in the
  next run without anybody listing it. Dynamic segments are filled from the
  database (`resolve.ts`, one resolver per dynamic route).
- **`--create-records`** first creates, through the product's API, the records
  the seed lacks (`records.ts`): a vendor, an incident, a BIA, an AI system,
  evidence, a test plan and run, an access review and an org initiative. It
  writes to the database, so use it only on a throwaway audit database. A
  route whose record still does not exist is listed under "Not captured" in the
  summary, with the reason. Routes are never dropped silently.
- **Sign-in** works the way `tests/e2e` does: the tenant OWNER for tenant
  pages, the seeded org owner for org pages, and no session for public pages.
- **Configurations** (`configs.ts`): 390 px dark Bulgarian, 390 px light
  English, and 360 px dark Bulgarian, all touch. `--configs` picks others.
- **Open states** (`states.ts`): the navigation drawer, user menu, command
  palette, assistant sheet, create modal, selection toolbar, an inspector sheet
  and the agent tab bar scrolled to its end.
- **Output** (`--out`, by default `tmp/mobile-audit/<timestamp>`, which git
  ignores): `metrics.json` with every page's counts and samples, `summary.md`
  with the pages failing each check per configuration plus the worst pages per
  check, and a screenshot per page.
- **`--routes <regex>`** narrows the run, for example
  `--routes 'risks|controls'`.

### Checking the whole product in a pull request

The E2E project ratchets the fixed route set only. Measuring every route in CI
would add several minutes of browser time to every E2E run. To check a change
against the whole product, run the harness on `main` and on the branch, then
compare:

```bash
npm run mobile:audit -- --base-url … --out /tmp/main-audit       # on main
npm run mobile:audit -- --base-url … --compare /tmp/main-audit/metrics.json
```

`--compare` prints every count of failing pages that moved, and exits 1 if
any count rose or more routes went uncaptured.
