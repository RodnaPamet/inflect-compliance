# 2026-10-03 — `density: 'none'` emits `p-0`, not the empty string

**Commit:** `f4572dcea` fix(ui): map the `none` density rung to p-0 so the layering can honour it

Closes the half of #3119 that #3143 could not reach. #3143 moved `.glass-card`
into `@layer components` so a `className` utility outranks the recipe's own
`@apply p-4 md:p-5`. `cardVariants`' `density` axis mapped `none` to `""`, which
emits no utility at all — so there was nothing in `@layer utilities` for the
corrected layer order to prefer. `none` was the one rung layering could not
reach.

## Design

Two halves of one cascade, and both have to hold:

```
cardVariants({ density: 'none' })  ->  "glass-card p-0"      (the recipe half)
@layer theme, base, components, utilities;                    (the stylesheet half)
  @layer utilities  { .p-0 { padding: 0px } }
  @layer components { .glass-card { … padding: calc(var(--spacing)*4);
                                    @media (width>=768px){ padding: …*5 } } }
```

`.glass-card` is emitted AFTER the whole utilities block in source order
(byte 223435 vs 104417 in the compiled sheet) and still loses, purely because
of the layer declaration. That is why both halves are guarded, and by different
mechanisms — `tests/guards/card-padding-cascade.test.ts` calls the real
`cardVariants` for the recipe half and compiles `src/app/globals.css` through
the real postcss chain for the stylesheet half.

Measured in headless Chromium against that compiled sheet, before -> after,
at 700px / 900px:

| rendered class string | before | after |
| --- | --- | --- |
| `glass-card` (density none) | 16px / 20px | **0px** |
| `glass-card p-0 text-center py-12` | 48/16/48/16 | **48/0/48/0** |
| `glass-card p-0 overflow-hidden` | 16px / 20px | **0px** |
| `glass-card p-0 px-4 py-2` | 8/16/8/16 | 8/16/8/16 (unchanged) |
| `rounded-lg border … bg-bg-subtle p-0` (elevation `inset`) | 0px | 0px (unchanged) |

Held constant across both runs: bare `p-0` (0), bare `p-6` (24), bare `py-12`
(48/0), bare `glass-card` (16/20), and `.glass-card`'s border-radius (12px).
The comfortable / compact / spacious rungs measured identical in both worlds
(24 / 16 / 48), so there is no collateral.

## Files

| File | Role |
| --- | --- |
| `src/components/ui/card-variants.ts` | `none: ""` -> `none: "p-0"`, with the cascade reasoning at the decision point |
| `tests/guards/card-padding-cascade.test.ts` | new — both halves of the contract, two mechanisms |
| `tests/helpers/compile-globals-css.mjs` | new — compiles globals.css in a child process |
| `tests/guards/card-density-discipline.test.ts` | the `/none:\s*["']["']/` pin replaced |
| `tests/guards/card-padding-lockdown.test.ts` | the second `/none:\s*""/` pin replaced |
| `tests/rendered/card.test.tsx` | adds the positive `toHaveClass('p-0')` |

## Decisions

- **Two existing guards had codified the bug.** `card-density-discipline` and
  `card-padding-lockdown` both asserted `none` was the empty string, so the
  defect could not be fixed without a guard turning red. The second was found
  only by running the whole `tests/guards` directory — it mentions none of the
  symbols in the diff, so a grep of changed files would have missed it.
  `card-padding-lockdown`'s own docstring reads `none (p-0) — children own
  padding`: the assertion had been contradicting the documented intent since
  Roadmap-5 PR-2.

- **A class-name assertion could not have caught this.** `card.test.tsx`
  asserted `not.toHaveClass('p-4')` and `not.toHaveClass('p-6')` for this rung.
  Both pass in both worlds — the class is absent either way and only the
  computed value differs. The positive `toHaveClass('p-0')` is what reddens.

- **`@tailwindcss/postcss` cannot be `require`d inside Jest.** It calls
  `module.registerHooks()` at import time and Jest refuses
  ("the hooks would attach to the module loader running Jest itself"). So the
  stylesheet half runs through `execFileSync(process.execPath, …)` on a
  `.mjs` helper. A hand-rolled postcss approximation was rejected: which
  `@layer` each rule lands in is the entire subject.

- **Asserting `.p-0` exists in the compiled CSS proves nothing about the
  recipe.** `p-0` is spelled at 29 other sites in `src`, so Tailwind emitted the
  rule before this change too. The test says so in a comment, and the recipe
  half is asserted separately by calling `cardVariants`.

- **`.p-0` must stay ahead of the directional utilities.** 8 of the live
  `density: 'none'` call sites pair the rung with `px-*` / `py-*`.
  `cn` is tailwind-merge, which keeps `p-0` alongside a later `px-*`/`py-*`
  (it drops an earlier shorthand only for a later SHORTHAND), so the
  directional rule has to win its own axis by source order inside the
  utilities layer. Measured: `.p-0` at 104417, `.px-4` at 105746,
  `.py-12` at 106723 — and `glass-card p-0 text-center py-12` renders
  48/0/48/0. A caller passing a uniform `p-N` keeps it, because
  tailwind-merge drops the `p-0` outright (`inset+none +p-3` measured 12px in
  both worlds).

- **The affected population is the 89 direct `cardVariants({ density: 'none' })`
  call sites, not the 5 `<Card density="none">` ones.** All five of the JSX
  sites pass `elevation="inset"`, whose recipe
  (`rounded-lg border border-border-default bg-bg-subtle`) carries no padding at
  all — they measured 0px in both worlds and were never affected. The 89 direct
  calls (across 40 files) pass no `elevation`, so they default to `raised` ->
  `.glass-card`, and those are the ones that rendered 16px / 20px.

- **Tailwind v4's `content` array is not its only source.** Breaking
  `tailwind.config.js`'s `content` glob did NOT stop `.p-0` being emitted —
  v4's automatic source detection still found it. Suppressing BOTH
  (`@import "tailwindcss" source(none)` plus `content: []`) is what reddens the
  stylesheet-half assertions. Worth knowing before trusting `@config`'s
  `content` as a complete description of what gets scanned.
