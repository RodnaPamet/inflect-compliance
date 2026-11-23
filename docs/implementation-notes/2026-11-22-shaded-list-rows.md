# 2026-11-22 — Shaded list rows (`<ShadedRow>`)

## Design

Owner request (2026-11-22): every card that lists two or more boxed rows draws
each row as its own shaded box, through ONE shared style, with the same look as
the detail-page tab bar (#5795): the `--bg-shaded` fill (warm grey in light,
cool blue tint in dark) and the `border-border-strong` outline.

- `--bg-tab-bar` was renamed `--bg-shaded` (same per-theme values) and exposed
  to Tailwind as `bg-bg-shaded`.
- `src/components/ui/shaded-row.tsx` exports `SHADED_SURFACE_CLASS` (the look),
  `shadedRowVariants` (cva: the look plus a `padding` step, default `p-3`) and
  `<ShadedRow as="li|div|section|article">`. No `'use client'`, so server and
  client components both use it.
- The tab bar in `EntityDetailLayout` takes its band classes from
  `SHADED_SURFACE_CLASS`, so the two cannot drift.
- `local/shaded-list-rows` (ESLint) refuses a hand-rolled neutral row box — any
  `<li>`, or a `.map(...)` callback's root element, carrying `rounded` +
  `border` + `border-border-subtle|default`.

## Decisions

- **Neutral rows only.** A row box with a state (a tone, a hover, a ring, a
  selected emphasis) keeps its own classes; the rule skips anything with a
  state variant, a state tone, or a class part it cannot read.
- **Rows, not tiles, chips or skeletons.** A map root inside a `grid`
  container, an `inline-flex` chip, a `rounded-full` pill and an
  `animate-pulse` skeleton are out of scope, in the rule and in the migration.
- **Spacing kept per site.** Uniform `p-2..p-5` became a `padding` step; every
  other spacing (`px-4 py-3`, `p-compact`) passes `padding="none"` and keeps
  its classes. Each row's radius became `rounded-lg`, the tab bar's.
- **Option cards are shaded too (owner decision, 2026-11-22, second
  commit).** `shadedRowVariants` gained `selected` and `interactive`. Every
  option is shaded; the chosen one swaps ONLY its border, and its old
  selected background (`bg-bg-subtle` / `bg-[var(--brand-subtle)]`) is
  dropped for the shade.
- **The selected border is the brand outline, everywhere (owner decision,
  2026-11-22, third commit).** The second commit kept each site's own
  selected tone, and the emphasis outline measured WEAKER than the strong
  outline on the unselected options beside it (1.47:1 vs 3.24:1 on the light
  shade, 2.05:1 vs 2.93:1 on the dark one), so the chosen option receded.
  `--brand-default` measures 3.85:1 light and 6.09:1 dark on the shade. There
  is no tone choice: `selectedTone` was removed, and every selected option
  looks the same. Not changed here: the MFA-policy cards' selected label
  text (`--brand-muted`) is 2.97:1 on the light shade, below AA; it was about
  the same on the old brand tint, so it predates this work. Hover on an unselected option is a 1px ring in the
  strong tone: the old `hover:bg-bg-muted` is invisible in light, where the
  shade IS `--bg-muted`. The rule reports a hand-rolled option card
  (`handRolledOption`): a padded, rounded, bordered `<label>` (or map-root
  `div`) wrapping a radio or checkbox.
- **Grid tiles stay as they are (owner decision, 2026-11-22).** The readiness
  tiles, the org drill-down CTAs and the api-keys scope groups are not
  shaded; the rule skips a map root inside a `grid`.
- **A lint rule, with inline disables for the two deliberate exceptions**
  (an edit-state box, a loading skeleton), rather than a guard with an
  allowlist: `reportUnusedDisableDirectives` keeps each disable honest.
