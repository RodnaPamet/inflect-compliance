# The shared UI package — design

> **Status: living design** — nothing is extracted. No file has moved, no import has changed and no
> package exists. This document is the design record for #3046, and its central measured finding is
> that the extractable set is **not** the 454 files `docs/_status/ui-core-classification.json`
> records as `GENERIC`: it is **408**, because `GENERIC` is a per-file neutrality verdict and a
> package needs a closed module graph. Everything true today is under
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

63 + 333 + 7 + 5 = 408, and 63 + 7 + 5 = the 75 non-icon modules. **No test file is in the set** —
both of the classification map's two `GENERIC` co-located tests
(`src/components/ui/hooks/__tests__/use-threshold-load-more.test.tsx`,
`src/lib/hooks/__tests__/use-zod-form.test.tsx`) test `MIXED` hooks and fall out of the closure, so
step 1 ships no tests and §5.6's `testMatch` concern does not bite in step 1.

`src/components/app-shell/shortcut-help-overlay.tsx` is the root's only file and it is `GENERIC`,
but it imports `src/components/ui/modal.tsx`, which falls out of the closure behind `button.tsx`.
So `src/components/app-shell` contributes **nothing** in step 1 — the one-file root the issue's table
lists as trivially extractable is in fact blocked on the hardest file in the library.

**What happens to the 140 MIXED.** They stay in `src/`. 58 of them are paths playerz tracks and 5
are paths it has already copied, so "they stay" means the vendoring machinery stays too, for those
5 files, until they are neutralised one at a time under the existing #3048 ratchet (whose whole
point is that the MIXED coupling totals may only fall: `domain-import` 41, `brand-as-text` 16,
`storage-key` 1). The package does not wait for them; it ships without them and grows as the ratchet
descends.

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
   because the existing detector cannot see it — **no `@/components/<anything outside the package>`**.

**Reconciling with `NEUTRAL_LIB`.** The allowlist in `tests/helpers/shared-ui-couplings.ts` is
`{cn, ui-storage, hooks, utils, format, dates, a11y, design, theme-constants}`. Against the tree,
only **four** of those nine resolve to a file: `src/lib/cn.ts`, `src/lib/ui-storage.ts`,
`src/lib/hooks/` and `src/lib/theme-constants.ts`. The other five (`utils`, `format`, `dates`,
`a11y`, `design`) name nothing — they are forward-looking slots, and the helper's own docstring says
why it is an allowlist rather than a denylist, so unused entries are the expected steady state and
not drift. The package's dependency rule is therefore **narrower** than `NEUTRAL_LIB`: the four that
exist go in, the five that do not stay reserved, and `theme-constants` is reserved for step 4 along
with `ThemeToggle` (§1).

**The gap this boundary exposes in the existing guard.** `mechanicalCouplings` matches
`/from\s+['"]@\/(app-layer|lib)\/([\w.-]+)/` — the alternation is `app-layer|lib` and nothing else,
so **an import of `@/components/<x>` is invisible to the `domain-import` detector**.
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
`packages/ui`, under the node environment, where a `.tsx` render test does not belong. Step 1 is
safe because the set contains no test file at all (§1), but the moment one is written there it is
collected by the wrong project — so add the `testPathIgnorePatterns` entry at step 1 rather than
discovering it later.

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
| 7 | **Ratchet the MIXED set down and the package grows for free** under the existing #3048 ceilings. No new mechanism. | `domain-import` 41 → lower; each decrement re-runs the closure and may add files to the package. |

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
