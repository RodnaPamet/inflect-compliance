# Living Sidebar — Roadmap-13 <!-- docs-accuracy-allow: "Roadmap-13" is the shipped project-cohort name, not a future marker -->

> The sidebar breathes. The band reaches. Active rows commit in
> navy. Letters take their brand colour. Clicks are rewarded with
> tactile depth.

## North star

<!-- docs-accuracy-allow: "Roadmap-12"/"Roadmap-13" are shipped project-cohort names -->
Roadmap-12 made the sidebar buttons lickable — geometry locked,
state vocabulary unified, every load-bearing decision pinned with a
ratchet. Roadmap-13 takes the next step: from *correct* to *alive*. <!-- docs-accuracy-allow: "Roadmap-13" is the shipped project-cohort name -->

R13 is twelve PRs, each focused on a single slice of the sidebar's
evolution:

- The brand-gradient band becomes a 3-stop polished-metal capsule
  with a soft outer glow and a slow 4-second shimmer pulse.
- The active row introduces a TWO-TONE state vocabulary: hover
  paints the band in the primary brand (warm yellow/orange);
  active paints it in the cool **SECONDARY** brand (electric blue
  on METRO, deep navy on the light theme).
- Active labels take their brand colour — yellow on the dark
  theme, orange on the light. The page you're on is unmissable
  from across the desk.
- Rows acquire a tactile two-edge bevel: a hairline gloss
  highlight on the top edge (`::after`) and a soft inset bevel
  shadow at the bottom. On mousedown the row drops 1px — the
  universal "I just pressed something physical" feedback.
- The band reaches: hover expands it from 6px inset → 4px inset
  and 3px wide → 4px wide. It feels like it's leaning toward
  the cursor.
- Section dividers fade in and out as a soft horizontal gradient
  instead of stamping a hard line between sections.
- Active rows are washed in a radial gradient from the band's
  edge — the navy bleeds out into the row, fading toward the
  right.

The single primitive is still `<NavItem>` at
[`src/components/layout/nav-item.tsx`](../src/components/layout/nav-item.tsx).
Every R13 change lands as additions or evolutions on top of the
R12 named-const exports.

## The new tokens (per theme)

R13 introduces five new CSS custom properties — three are new
brand tokens, two are sidebar-specific decorative tokens. Every
token is theme-aware (METRO and light) and the geometry is locked
across themes; only the colour/alpha tunes for surface luminance.

| Token | METRO (dark) | Light | Role |
| --- | --- | --- | --- |
| `--brand-secondary-default`  | `#3B82F6` (electric blue) | `#1E3A8A` (deep navy) | Active band top stop, future secondary chrome |
| `--brand-secondary-emphasis` | `#2563EB` | `#172554` | Active band bottom stop |
| `--brand-secondary-muted`    | `#60A5FA` | `#3B82F6` | Active band highlight midstop |
| `--brand-secondary-subtle`   | `rgba(59, 130, 246, 0.18)` | `rgba(30, 58, 138, 0.09)` | Active radial-wash peak |
| `--nav-band-glow`            | `0 0 6px rgba(255, 205, 17, 0.35)` | `0 0 6px rgba(208, 74, 2, 0.35)` | Outer glow on hover band |
| `--nav-band-glow-active`     | `0 0 6px rgba(59, 130, 246, 0.35)` | `0 0 6px rgba(30, 58, 138, 0.35)` | Outer glow on active band |
| `--nav-gloss-highlight`      | `rgba(255, 255, 255, 0.08)` | `rgba(255, 255, 255, 0.70)` | Top-edge ::after highlight |
| `--nav-bevel-shadow`         | `inset 0 -1px 1px 0 rgba(0, 0, 0, 0.25)` | `inset 0 -1px 1px 0 rgba(60, 50, 40, 0.08)` | Bottom-edge inset bevel |

## The four states — R13 evolved

| State | What changes | Token recipe |
| --- | --- | --- |
| Default | muted text, no band, no gloss, no bevel | `NAV_ITEM_DEFAULT` |
| Hover | text → emphasis · band fades in (warm) + reaches (top-1 / w-4px) + shimmers · gloss fades in · bevel applied | `:hover` modifiers |
| Active | text → brand-coloured · radial brand wash · band → navy (secondary brand) + reach geometry + shimmer · gloss + bevel held · +1 font-weight | `NAV_ITEM_ACTIVE` |
| Focus-visible | 2px brand-tinted ring with 2px breath off the row | inside `NAV_ITEM_BASE` |

Press feedback (`active:translate-y-px`, CSS `:active` mousedown) is
the one transient micro-motion. Geometry returns to baseline the
instant the click ends.

## The motion language — broadened

R12 locked motion to opacity + colour only. R13 broadens that
contract for `nav-item.tsx` (and only this file — the global
`motion-language-discipline.test.ts` ratchet adds it to its
exempt list with documented rationale):

- **Position transitions allowed** — `top`, `bottom`, `width` on
  the band's `::before`. The band reaches toward the cursor on
  hover via animated geometry. Single 200ms ease-out shared with
  the opacity reveal.
- **The shimmer animation** — `background-position` panning on the
  band's gradient, 4s ease-in-out infinite, gated to hover + active.
- **Press feedback** — `active:translate-y-px` on the row itself.
  CSS `:active` only; hover-translate, hover-scale, focus-visible-
  translate ALL still banned by the local R13 ratchets.

Everything else (transform on hover, scale-on-hover, slide-in,
elevation lift) stays banned. The broadening is narrow and
documented.

## The twelve ratchets

| Ratchet                                      | PR    | What it locks |
| -------------------------------------------- | ----- | ------------- |
| `r13-secondary-brand-tokens.test.ts`         | PR-1  | Secondary brand tokens, both themes, three tiers, rationale comments |
| `r13-band-richness.test.ts`                  | PR-2  | 3-stop gradient, --nav-band-glow plumbing, identical glow geometry across themes |
| `r13-band-shimmer.test.ts`                   | PR-3  | Keyframe shape, 4s ease-in-out infinite, bg-size 100% 200%, hover-gated + active un-gated |
| `r13-active-band-secondary.test.ts`          | PR-4  | Four secondary-brand `!` overrides on active, active-glow plumbing, no secondary leak on hover |
| `r13-active-label-brand-colour.test.ts`      | PR-5  | brand-default text on active, no leak into hover, WCAG-AA contract documented |
| `r13-gloss-highlight.test.ts`                | PR-6  | `::after` recipe, theme-aware token, pointer-events-none, hover + active reveal |
| `r13-bevel-shadow.test.ts`                   | PR-7  | Theme-aware bevel token, inset-only, hover wiring, active un-gated |
| `r13-press-feedback.test.ts`                 | PR-8  | active:translate-y-px + motion-reduce, no hover-translate / scale leak, motion-language exempt + cap |
| `r13-band-reach.test.ts`                     | PR-9  | Idle geometry preserved, broadened transition list, hover overrides, active `!` overrides |
| `r13-soft-section-divider.test.ts`           | PR-10 | `::before` gradient hairline, linear-gradient(90deg), --border-subtle peak, fade ends |
| `r13-radial-active-wash.test.ts`             | PR-11 | bg-radial-gradient, circle-at-left, --brand-secondary-subtle peak, transparent fade |
| `r13-living-sidebar-bundle.test.ts`          | PR-12 | Capstone — every PR's invariants in one report (25 grouped assertions) |

Plus the runtime consumer at
[`tests/rendered/nav-item-states.test.tsx`](../tests/rendered/nav-item-states.test.tsx) —
mounts `<NavItem>` in default + active + with-badge states and
asserts the const values flow into the rendered DOM end-to-end.

## How to extend

Adding a new sidebar polish:

1. Edit `src/components/layout/nav-item.tsx` (or `nav-section.tsx`
   for section-level polish). Add a new named export if the recipe
   is reusable; document the rationale in a doc-comment next to
   the const.

2. Add a structural ratchet under `tests/guards/` named
   `r13-<concept>.test.ts` OR (for follow-on roadmaps) `r14-…`. <!-- docs-accuracy-allow: "roadmaps" refers to the shipped project-cohort naming convention -->
   Lock the load-bearing invariants; ban the anti-patterns the
   recipe is designed to prevent.

3. Update the capstone bundle ratchet
   (`r13-living-sidebar-bundle.test.ts`) — add the new section
   walking the new invariants in the unified report.

4. Update the rendered test
   (`tests/rendered/nav-item-states.test.tsx`) if the new state is
   observable at runtime.

5. Update this doc — add the new token to the table, the new
   ratchet to the table.

## What NOT to do

- Don't widen `font-medium` to `semibold` / `bold` for the active
  state. The +1 weight bump is the maximum; anything heavier reads
  as a heading, not a row label. (R12-PR6 lock, preserved.)
- Don't reach for `hover:translate-*`, `hover:scale-*`, or
  `hover:shadow-` that isn't going through `--nav-bevel-shadow`.
  The broadening is narrow. (Local R13 ratchets enforce.)
- Don't reach for `bg-[var(--brand-default)]` / `bg-[var(--brand-
  emphasis)]` on the active row — the wash is a brand-tint
  (subtle or radial-secondary-subtle), never a saturated fill.
  (R12-PR6 lock, preserved.)
- Don't introduce a parallel `<Link>` with hand-rolled geometry
  outside `nav-item.tsx`. The import-discipline ratchet catches
  this.
- Don't add a 7th file to the motion-language exempt list without
  the same rigorous "broadening rationale in the comment block"
  treatment R13-PR8 gave to nav-item.tsx. The exempt-list cap is
  6; bumping past that should be load-bearing.
