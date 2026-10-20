# 2026-06-08 — Pop-up texture reaches menus + becomes perceptible

**Commit:** `<sha>` fix(ui): extend focal-glow texture to popover surfaces + strengthen calibration

## Problem

B3 (#897) introduced `.surface-popup-texture` — a brand-tinted
focal-glow radial + elegant border + glass-edge — but the rollout
fell short on two fronts the user reported:

1. **Coverage gap.** It was applied only to modal content, sheet
   content, and the undo-toast. The notifications dropdown, user menu,
   and tenant/org switchers all render through the shared `<Popover>`
   primitive, whose content surface was still flat
   `bg-bg-default / border-border-subtle / drop-shadow-lg`. So those
   surfaces looked exactly as before.
2. **Sub-perceptual calibration.** Even where it WAS applied (modals),
   the wash was invisible: 4% brand-mix at centre + 6% black at the
   edge is below the perceptual floor on both the navy (METRO) and
   cream (light-theme) surfaces — the same too-low-alpha trap that bit the
   Liquid Glass roadmap (R24).

## Design

- **One class, more adopters.** `Popover.Content` (desktop Radix) and
  the mobile Vaul drawer now carry `.surface-popup-texture`, so every
  menu built on the shared primitive inherits the texture for free —
  user menu, notifications, tenant/org switchers, comboboxes,
  filter popovers. The mobile drawer fallbacks of both Modal and
  Popover get it too, for parity.
- **Calibration into the visible range.** Centre brand-mix 4% → 10%
  (with a 4% mid-stop at 42%), edge darken 6% → 9%, border brand-tint
  15% → 22%, glass-edge highlight 16% → 20%. The glow is anchored at
  `50% 0%` (top-centre) rather than dead-centre — the eye enters a
  pop-up from its leading edge, and the warm wash now reaches 78% down
  before the vignette.

Verified by colour maths on both themes (navy `#003C7A` + 10% gold
`#FFCD11` → a clear warm shift; cream `#F8F6F3` + 10% orange `#D04A02`
→ a visible peachy wash).

## Files

| File | Role |
|------|------|
| `src/app/globals.css` | `.surface-popup-texture` recalibrated to the perceptible range + top-anchored glow |
| `src/components/ui/popover.tsx` | desktop content surface + mobile drawer adopt the texture (drop flat bg/border) |
| `src/components/ui/modal.tsx` | mobile drawer fallback adopts the texture for parity with desktop |
| `tests/guards/b3-popup-texture.test.ts` | ratchet extended: popover (≥2 occurrences) adopts the class; no flat `bg-bg-default…drop-shadow-lg` remains |

## Decisions

- **Texture on the shared `Popover`, not per-menu.** All chrome menus
  compose the one primitive, so a single change covers them — and the
  ratchet locks the primitive, not each call site.
- **Command palette left as-is.** It has a deliberately heavier,
  distinct surface (`bg-bg-elevated shadow-2xl`, rounded-xl) and was
  never part of the flat-menu complaint. Texturing it would flatten
  its hierarchy distinction; left for a separate call if wanted.
- **Calibration is the load-bearing change.** The class already
  existed and was structurally correct; the reason "no texture landed"
  was alpha, not wiring. Bumping to 10%/9%/22% is what makes it read.
