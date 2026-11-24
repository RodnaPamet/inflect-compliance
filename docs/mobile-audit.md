# Mobile audit and the mobile E2E project

Two tools measure how the product renders on a phone, and both use ONE module
for every measurement: `scripts/mobile-audit/measure.ts`. A metric means the
same thing in a whole-product report and in a red CI run.

| Tool | What it covers | When it runs |
|---|---|---|
| The mobile E2E project (`--project=mobile`) | A fixed set of routes: one per shared primitive, plus the P0 pages | Every E2E run in CI, in the same `npx playwright test` invocation as the rest of the suite |
| The audit harness (`npm run mobile:audit`) | Every `src/app/**/page.tsx` route and eight open states | Nightly (`.github/workflows/mobile-audit.yml`), and on demand against a running app |

The audit that started this work, its findings and the plan to fix them are in
[the mobile audit and plan](mobile-roadmap.md).

## The metrics

Each metric is counted per element. A page FAILS a check when its count is
above zero. The definitions live in the docblock of `measure.ts`. In short:

| Metric | A page fails it when | What it ignores |
|---|---|---|
| `clipped` | Something interactive, or a run of text, extends past the screen edge and no ancestor scrolls sideways to reveal it. The app shell clips horizontal overflow instead of scrolling it, so this is the real overflow signal. | Text cut inside a smaller box (an ellipsis, a card's `overflow-hidden`). Anything inside a container that scrolls sideways. A closed off-canvas drawer that is still mounted. A focusable group container (see `tapUnder24`). |
| `overlayCoversControl` / `overlayCoversText` | With the page scrolled to its end, an element fixed in the lower half of the screen is the topmost thing over a control, or over text. | Fixed elements in the top half (the top bar), and sheets or backdrops that cover more than 40% of the screen. |
| `tapUnder24` / `tapUnder44` | An interactive element in the page body has a hit area under 24 / 44 px on its short side. A positioned `::before`/`::after` counts towards the hit area (`TOUCH_HIT_AREA_CLASS`). | The top bar. A link inside a sentence, laid out `inline`, `inline-flex` or `inline-block`: WCAG 2.5.8 exempts it. Other controls are exempt in a sentence only when `inline`. A focusable group container (`radiogroup`, `group`, `tablist`, `toolbar`, `menubar`): Radix gives the root `tabindex=0` for roving focus, and its items are measured instead. An element with `pointer-events: none`, such as a list card's selection circle, is not measured itself: the nearest ancestor that receives the tap is. |
| `textUnder12` | Text renders under 12 px. | The environment badge in the top bar (`top-chrome-env-badge`), which shows only on localhost and staging. Every other small text counts, including the bell's count badge. |
| `inputUnder16` | A text field, select, textarea or editable region renders under 16 px, which makes iOS Safari zoom on focus. | Checkboxes, radios, ranges and other inputs that take no typed text. |
| `tabsNoCue` | A `role="tablist"` overflows and shows no cue: no `ScrollCueStrip` overflow marker, no fade mask, no visible scrollbar. | Tab bars that fit. |
| `buttonWraps` | A wrapping row of three or more buttons or links lays out on three or more lines. | A row whose children are not all buttons. A child counts as a button when it is one, or when it wraps exactly one button and is no bigger than it (a tooltip or permission wrapper). So a form row of labelled fields, and a navigation strip with a caption or a current-page marker, are not counted: they wrap by design. |
| `wideTables` | A `<table>` is wider than the screen. | Nothing. A table inside a sideways scroller still counts. |
| `englishLeaks` | English UI text on a Bulgarian page. `scripts/mobile-audit/leaks.ts` decides, from `messages/en.json` and `messages/bg.json`, English dates, and short hard-coded control labels. | Seeded data: it is never judged by the word heuristic, and record names (tenants, organisations, controls, a risk's free-text owner) are skipped. The shipped English **library**, which is content rather than interface text (owner decision, 2026-11-23): framework names and descriptions, requirement titles, categories and sections, ISO clause names, control and policy templates, and the seeded vendor questionnaires' sections, prompts and options (`libraryTexts` in `resolve.ts`). The exclusion is by exact value, so interface strings are still judged. A library value that is also a one-word English catalog message ("High", "Planning") is still counted, because a one-word label is more likely to be the product's own. |
| `docScrollsSideways` | The document itself scrolls horizontally. | Nothing. |
| `consoleErrors` | The page logged a console error (audit only; never ratcheted). | The benign messages listed in `run.ts`. |

`tests/e2e/mobile-measure.spec.ts` proves each metric against the defect it
names: every case renders a small page WITH the defect and the same page with
the defect fixed, and measures both.

## The mobile E2E project

`playwright.config.ts` defines a `mobile` project with the iPhone 14 profile
(touch, so `pointer: coarse` matches) on Chromium. It runs these specs, among others for single features (`mobile-bulk-apply`, `mobile-safe-area`, `mobile-template-install`):

- `mobile-layout.spec.ts` loads the routes in `SEED_ROUTES` (in
  `tests/e2e/mobile-ratchet.ts`) against the shared seeded tenant, read-only.
  Some entries open a state first: the user menu, the navigation drawer, the
  command palette, the assistant sheet, the create sheet, and a ticked card
  with the selection toolbar.
- `mobile-layout-records.spec.ts` covers the P0 pages whose records the seed
  lacks (a test plan, a business impact analysis). It creates them through the
  API in an isolated tenant.
- `mobile-measure.spec.ts` holds the metric proofs described above.
- `mobile-journeys.spec.ts` and `mobile-vendor-questionnaire.spec.ts` are the
  key phone journeys (below).

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

### The key phone journeys

What a person must be able to do from a phone, end to end, in Bulgarian. Each
runs in its own isolated tenant and creates what it starts from through the
product's own API:

| Journey | Spec | Configuration |
|---|---|---|
| Sign in with MFA: password, then the authenticator's code | `mobile-journeys.spec.ts` | 360 light |
| Triage a task: assign it, comment, close it with a resolution | `mobile-journeys.spec.ts` | 390 dark |
| Approve an agent's proposal, sent by the agent over MCP | `mobile-journeys.spec.ts` | 390 dark |
| Stop an agent, after reading its runs | `mobile-journeys.spec.ts` | 360 light |
| Decide an access review | `mobile-journeys.spec.ts` | 360 light |
| Open a shared audit link, as an auditor with no session, and send a question back | `mobile-journeys.spec.ts` | 390 dark |
| Answer a vendor questionnaire through to a successful submit | `mobile-vendor-questionnaire.spec.ts` | both |

Every screen a journey passes through is held to the four zero-tolerance
invariants, to no text cut at the screen edge, and to no English on the
Bulgarian page (`holdScreen` in `tests/e2e/mobile-journey-support.ts`). The
action each step exists to take is held to 44 px and to being on screen
(`expectThumbSized`). Each journey runs in one configuration rather than both:
together they cover both widths and both themes at half the time.

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
- **`--routes <fragments>`** narrows the run to routes whose pattern contains
  one of the comma-separated fragments, for example `--routes risks,controls`.

### Nightly

`.github/workflows/mobile-audit.yml` runs the harness every night against the
E2E build on a freshly seeded database, with `--create-records`, in the three
default configurations. It publishes `summary.md`, `metrics.json`,
`comparison.md` and the screenshots as the `mobile-audit` artifact, and puts
the summary on the run's page.

It compares against the `metrics.json` of the previous SUCCESSFUL run on
`main`. When any count of failing pages rose, or a route stopped rendering,
the run fails and opens an issue labelled `mobile-audit` (or comments on the
open one) quoting `comparison.md`: the counts that moved and, for each that
rose, the routes that fail now and did not before. A failed run is never a
reference, so a regression is reported every night until it is fixed. A run
that could not measure anything (the build, the app or the harness broke) gets
its own issue title: that is a broken observer, not a broken page. A count
that fell passes, and that night becomes the reference. It can also be started
by hand (`workflow_dispatch`).

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

## Real-device pass

The harness and the E2E project run Chromium with a phone's viewport, touch
and user agent. They cannot see what only a real browser on a real phone does:
Safari's own zoom and toolbars, the home indicator, the on-screen keyboard
covering a field, a native picker, a share sheet, a slow network. Before
calling the product mobile-flawless (Phase 5 of
[the mobile plan](mobile-roadmap.md)), and after any change to the app
shell, run this pass on an iPhone in Safari and on an Android phone in Chrome.
Record the result, with the device, OS and browser versions, on the tracking
issue.

Use Bulgarian for one pass and English for the other, one in dark theme and
one in light. Use a workspace with data, and a second workspace you can share
an audit pack and a vendor questionnaire from.

1. **Sign in.** The fields do not zoom the page when tapped. With MFA
   required, the code field opens the number pad and offers the code from
   Messages (iOS) or the authenticator's autofill. Continue is reachable with
   the keyboard open.
2. **The shell.** The menu opens the navigation drawer and closes it with a
   tap outside and with the back gesture. The bell, search and assistant icons
   in the top bar each open their sheet, and nothing sits under the notch or
   the status bar. Rotate to landscape and back: nothing is cut off.
3. **A list and a detail page** (controls, then one control). Scroll the list
   to its end: the last row is not hidden behind a bottom bar or the home
   indicator. The detail tabs scroll sideways with a visible cue, and the
   active tab is in view.
4. **A form in a sheet** (create a task). The keyboard does not cover the
   field being typed in. Selects and date pickers open the phone's own picker
   or a sheet that fits. Save is reachable without closing the keyboard.
5. **Triage a task.** Assign it, comment, close it with a resolution.
6. **An agent.** Approve or reject a proposal from the queue. Stop an agent
   and resume it.
7. **An access review.** Record a decision on a row.
8. **The public pages, signed out.** Open a shared audit link and a vendor
   questionnaire from a message or mail app, as the recipient would. Answer
   the questionnaire, leave one required answer empty, and submit: the page
   scrolls to it. Answer it and submit: the confirmation shows.
9. **Text and touch.** Nothing is too small to read without zooming, no
   button is too small to hit with a thumb, nothing works only on hover, and
   no English appears on a Bulgarian page (library content such as control
   templates excepted).
10. **Downloads and uploads.** Upload evidence from the camera or the files
    app, and download an export: both complete, and the file opens.

Record each step as passed or failed. For a failure, note the page, the
device and a screenshot, and open an issue.

