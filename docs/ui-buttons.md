# Design System Guide

## Token Foundation

All UI styling targets semantic CSS custom properties defined in `src/styles/tokens.css`, mapped to Tailwind utilities in `tailwind.config.js`.

### Token Categories

| Category | CSS Variable | Tailwind Class | Usage |
|---|---|---|---|
| **Surfaces** | `--bg-default` | `bg-bg-default` | Cards, panels, modals |
| | `--bg-muted` | `bg-bg-muted` | Hover states, active surfaces |
| | `--bg-subtle` | `bg-bg-subtle` | Selection backgrounds, disabled |
| | `--bg-elevated` | `bg-bg-elevated` | Tooltips, dropdowns |
| | `--bg-page` | `bg-bg-page` | Page background |
| **Text** | `--content-emphasis` | `text-content-emphasis` | Headings, bold labels |
| | `--content-default` | `text-content-default` | Body text, table cells |
| | `--content-muted` | `text-content-muted` | Secondary text, placeholders |
| | `--content-subtle` | `text-content-subtle` | Disabled text, hints |
| **Borders** | `--border-default` | `border-border-default` | Standard borders |
| | `--border-subtle` | `border-border-subtle` | Soft dividers, card edges |
| | `--border-emphasis` | `border-border-emphasis` | Focused inputs |
| **Status** | `--bg-success` / `--content-success` / `--border-success` | `bg-bg-success` etc. | Success states |
| | `--bg-warning` / `--content-warning` / `--border-warning` | `bg-bg-warning` etc. | Warning states |
| | `--bg-error` / `--content-error` / `--border-error` | `bg-bg-error` etc. | Error/danger states |
| | `--bg-info` / `--content-info` / `--border-info` | `bg-bg-info` etc. | Informational states |
| | `--bg-attention` / `--content-attention` / `--border-attention` | `bg-bg-attention` etc. | Pending/needs-action |
| **Brand** | `--brand-default` | Direct or `brand-500` | Brand accent |

### Forbidden Patterns

Never use raw Tailwind color scales in migrated pages:

```tsx
// BAD — hardcoded colors break theming
<p className="text-slate-400">Muted text</p>
<div className="bg-slate-800 border-slate-700">Card</div>

// GOOD — semantic tokens
<p className="text-content-muted">Muted text</p>
<div className="bg-bg-default border-border-default">Card</div>
```

## Button Component

`src/components/ui/button.tsx` — the primary button primitive.

### Variants — the canonical four

There are exactly four. A fifth shape is drift, and two ratchets say so:
`still-surface-button-material.test.ts` locks the catalogue at the source,
`button-variant-cull.test.ts` bans the retired names at call sites.

| Variant | Usage | Material |
|---|---|---|
| `primary` | Main action (Save, Create) | Brand tile; hover trades its edge for `--brand-secondary-default` |
| `secondary` | Secondary action (Cancel, Back) | Surface tile; hover takes the **brand** edge — the mirror of primary |
| `ghost` | Borderless (toolbar toggles) | No tile at rest; gains one on hover |
| `destructive` | Destructive (Delete, Revoke) | Danger hue, own stops, **no** reciprocal edge |

Previously retired and permanently banned: `outline` → `secondary`,
`success` → `primary`, `danger` → `destructive`, `danger-outline` and
`destructive-outline` → `destructive`.

`destructive-outline` was the most recent cull (2026-07-28). It read as a
lower-emphasis danger, which is precisely the ambiguity a destructive
action should not have — there is now one danger vocabulary.

### Sizes — one rung

Every size key resolves to the same **28px** geometry
(`h-7 px-[0.7rem] text-[0.76rem]`, `+0.005em` tracking, 15px icons).

| Size | Renders | Note |
|---|---|---|
| `xs` / `sm` / `md` / `lg` | 28px | All identical today |
| `icon` | 28×28px | Square; requires `aria-label` |

The `size` prop is deliberately **kept** rather than deleted from its 646
call sites. Reversal is then a one-file edit — restoring the old
28/32/36/40 ladder means giving these keys their own values again, with no
call-site archaeology — and `size="lg"` still records that a button was
meant to be prominent even while it renders at 28px.

**Form controls move in lockstep.** `control-variants.ts::controlSize` is
collapsed to the same 28px rung. This is load-bearing, not cosmetic: a
28px button beside a 36px `<Input>` is a visibly broken filter toolbar.
Change one, change both.

On coarse pointers every button still gets a 44px minimum target
(`pointer-coarse:min-h-11`) — `min-h` only raises, so the dense desktop
geometry is untouched and the tap target never shrinks with the visual.

### Usage

```tsx
import { Button, buttonVariants } from '@/components/ui/button';

// Interactive button
<Button variant="primary" onClick={save} loading={saving}>Save</Button>

// Button with icon
<Button variant="secondary" icon={<Filter className="size-4" />}>Filters</Button>

// Disabled with tooltip
<Button variant="primary" disabledTooltip="You need admin access">Delete</Button>

// Link styled as button (use buttonVariants)
import { cn } from '@dub/utils';
<Link href="/new" className={cn(buttonVariants({ variant: 'primary', size: 'md' }))}>
    + New Item
</Link>
```

### When to Use `Button` vs `buttonVariants`

| Scenario | Use |
|---|---|
| Clickable `<button>` element | `<Button>` component |
| `<Link>` styled as a button | `buttonVariants()` + `cn()` |
| Server component with navigation | `buttonVariants()` (no hooks needed) |
| Button with loading/disabled state | `<Button>` component |

### Still Surface — the button material (2026-07-28)

The motionless material. It supersedes the entire Roadmap-19 → Roadmap-24 <!-- docs-accuracy-allow: shipped-epic codenames being superseded, not future tense -->
stack: carbon grain, light pool, iridescent meniscus, aura bloom, liquid
glass. Those built depth out of MOTION — a hover fade on `::before`, an
aura bloom on `::after`, a press that shrank 3% and travelled 1px down.

Still Surface builds the same depth out of static light, and moves the
hover signal out of motion and into **hue**.

**The thesis: hover is a trade of edges.** The brand tile takes the
complementary edge; the surface tile takes the brand edge. Each variant
borrows the other's colour, and neither one moves to do it. The
complementary hue was already in the system — `--brand-secondary-default`
is documented in `tokens.css` as complementary to the brand in both themes
(electric blue ↔ METRO yellow in dark, deep navy ↔ PwC orange in light).
Nothing was invented; it is the existing palette, held still.

**Four static layers carry the depth, none of them a keyframe:**

| Layer | Mechanism |
|---|---|
| Edge light | `linear-gradient(top, var(--btn-still-top), transparent 46%)` |
| Body gradient | `--brand-default` → `--brand-emphasis` vertical fall |
| Seat line | `inset 0 -1px 0 var(--btn-still-bot)` |
| Lift → inset | `--btn-still-lift` inverts to `--btn-still-press` on `:active` |

**Permanently banned** (each has a named ratchet in
`still-surface-button-material.test.ts`, which reports *what* you are
undoing, not just that a regex failed):

```
transition-all          the base transition
active:scale-*          the 3% press shrink
active:translate-y-*    the 1px press travel
before:* / after:*      every pseudo layer
hover:after:shadow-*    the aura bloom
backdrop-blur-*         unnecessary once the fill is graded
motion-reduce:*         nothing moves, so nothing to strip
```

That last one is the tell: a motionless system has no reduced-motion
fallback to write, because there was never anything moving. It also gets a
documentation dividend — with nothing to animate, every state can be shown
side by side as a static swatch instead of hiding behind a cursor.

Feedback and animation are not the same thing. Pressed still reads as
pressed; the shadow inversion does the work the transform used to.


### CTA Order — modal/dialog footers (Roadmap-22 PR-E) <!-- docs-accuracy-allow: shipped-epic codename, not future tense -->

Every modal or dialog footer with a paired CANCEL + CONFIRM
follows the Mac/iOS convention: **secondary first in DOM order,
primary second**. With the footer's default `justify-end`
container, the visual result is `[Cancel] [Confirm]` right-
aligned — primary on the RIGHT, where the eye finishes a left-
to-right read.

`Modal.Confirm` ships this default. New modal call sites SHOULD
use `Modal.Confirm` (or the `ConfirmDialog` re-export) rather
than hand-rolling a footer. If you DO hand-roll a footer:

```tsx
<Modal.Actions>
  {/* Cancel FIRST */}
  <Button variant="secondary" onClick={onCancel}>Cancel</Button>
  {/* Confirm SECOND (primary OR destructive, depending on tone) */}
  <Button variant="primary" onClick={onConfirm}>Save</Button>
</Modal.Actions>
```

What this rule INVERTS: the Windows convention (primary LEFT) and
the "alphabetised by danger" pattern (destructive on the left,
neutral right). Both read as "OK Cancel" to a screen reader; the
visual placement is the affordance, and Mac/iOS users (the bulk
of the design vocabulary IC inherits from) expect primary-right.

The rule is locked by `tests/guards/r22-pre-variant-and-cta-order.test.ts`:
the `Modal.Confirm` source must render the Cancel button BEFORE
the Confirm button in JSX.

### Variant inventory

Four variants. See the table under **Variants** above for the full
material description.

| Variant | When to use |
|---|---|
| `primary` | The page's primary action. One per surface. |
| `secondary` | The page's secondary action(s). Multiple allowed. |
| `ghost` | Low-chrome action (toolbar, inline edit). |
| `destructive` | Any destructive action — Delete, Archive, Revoke, Remove. |

**What the `destructive-outline` fold cost.** Roadmap-22 PR-E reviewed <!-- docs-accuracy-allow: shipped-epic codename, not future tense -->
that variant and kept it, arguing the visual gap between `destructive`
(full red fill) and `destructive-outline` (red text + red border) WAS the
affordance difference between "delete-and-it's-gone" and
"remove-this-link" — and it closed by saying a future PR may fold them if
the distinction stops earning its keep.

The 2026-07-28 cull is that PR. The canonical material ships four shapes,
so the fifth went. The cost is real and worth stating plainly: *Revoke API
key* and *Delete framework* now render identically. Where that difference
still matters, carry it in the **label and the confirm copy** — which is
where the destructive-action vocabulary in `CLAUDE.md` already puts it
(`Revoke {Credential}` vs `Delete {Entity}`) — not in a fifth button shape.


## StatusBadge Component

`src/components/ui/status-badge.tsx` — semantic status indicator.

### Variants

| Variant | Usage | Tokens |
|---|---|---|
| `neutral` | Default, inactive | `bg-bg-subtle`, `text-content-muted` |
| `info` | Informational | `bg-bg-info`, `text-content-info` |
| `success` | Active, complete | `bg-bg-success`, `text-content-success` |
| `pending` | Needs action | `bg-bg-attention`, `text-content-attention` |
| `warning` | Caution | `bg-bg-warning`, `text-content-warning` |
| `error` | Error, critical | `bg-bg-error`, `text-content-error` |

### Usage

```tsx
import { StatusBadge, statusBadgeVariants } from '@/components/ui/status-badge';

// Standard badge
<StatusBadge variant="success">Active</StatusBadge>

// Without icon
<StatusBadge variant="warning" icon={null}>Pending</StatusBadge>

// With tooltip
<StatusBadge variant="error" tooltip="3 critical findings">Critical</StatusBadge>

// Clickable badge (use statusBadgeVariants on a <button>)
<button className={cn(statusBadgeVariants({ variant: 'info' }), 'cursor-pointer')}>
    Admin
</button>
```

### Variant Mapping Pattern

```tsx
const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
    ACTIVE: 'success',
    PENDING: 'warning',
    FAILED: 'error',
    INACTIVE: 'neutral',
};

<StatusBadge variant={STATUS_VARIANT[item.status] || 'neutral'} icon={null}>
    {item.status}
</StatusBadge>
```

## EmptyState Component

`src/components/ui/empty-state.tsx` — empty/missing content layout.

```tsx
import { EmptyState } from '@/components/ui/empty-state';
import { Search, Building2 } from 'lucide-react';

// Basic
<EmptyState icon={Building2} title="No vendors found" description="Add your first vendor to get started." />

// With CTA
<EmptyState icon={Building2} title="No vendors found" description="Get started by adding a vendor.">
    <Button variant="primary">+ Add Vendor</Button>
</EmptyState>

// Filtered empty state
<EmptyState icon={Search} title="No results" description="Try adjusting your filters." />
```

## Legacy System (Deprecating)

The old `.btn .btn-primary` and `.badge .badge-success` CSS classes in `globals.css` are **deprecated**. They remain for ~40 unmigrated pages. New pages must use the component primitives above.

### Migration Checklist

When migrating a page to the design system:

1. Replace `className="btn btn-*"` with `<Button>` or `buttonVariants()`
2. Replace `className="badge badge-*"` with `<StatusBadge>` or `statusBadgeVariants()`
3. Replace raw Tailwind colors (`text-slate-*`, `bg-slate-*`, `border-slate-*`) with semantic tokens
4. Replace empty-table markup with `<EmptyState>`
5. Add the page to `MIGRATED_PAGES` in `tests/guardrails/design-system-drift.test.ts`
6. Add assertions in `tests/guardrails/token-migration.test.ts`

## Guardrails

| Test File | What It Catches |
|---|---|
| `token-css-integrity.test.ts` | Missing CSS variables referenced by tailwind.config.js |
| `cva-primitives.test.ts` | Primitive API surface, semantic token usage, no raw colors |
| `token-migration.test.ts` | Migrated pages import and use the correct primitives |
| `design-system-drift.test.ts` | Raw colors reappearing in migrated pages, duplicate components |
| `button-consistency.test.ts` | Ad-hoc inline button styling in page files |
| `legacy-ui-ratchet.test.ts` | Prevents net-new `className="btn …"` / `className="badge …"` usage — ratchet only goes down |
| `theme-provider.test.ts` | ThemeProvider + ThemeToggle contract, legacy→semantic token alias bridge in globals.css |

## Theme Switching

Epic 51 also shipped runtime theme switching. `ThemeProvider` (mounted in
`src/app/providers.tsx`) reads the user's stored preference, falls back to
`prefers-color-scheme`, and writes `data-theme="dark"` or `"light"` on
`<html>`. Every semantic token in `tokens.css` carries both palettes so
every token-driven component (CSS classes **and** CVA variants) flips in
sync.

Consumers:

```tsx
import { useTheme } from '@/components/theme/ThemeProvider';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

const { theme, setTheme, toggle } = useTheme();
// or drop the ready-made icon button:
<ThemeToggle />
```

The toggle is already mounted in the sidebar footer (desktop) and the
mobile top bar. Don't mount a second instance — `useTheme()` is available
from any client component inside the providers tree.

### What the token bridge unlocked

- `globals.css`'s `.btn`, `.badge`, `.glass-card`, `.input`, `.nav-link`,
  `.icon-btn` all now resolve to `var(--bg-*)` / `var(--content-*)` /
  `var(--border-*)` / `var(--brand-*)`. Swapping the active theme via
  `[data-theme="light"]` changes those classes with zero code touch.
- Legacy alias variables (`--bg-primary`, `--brand`, `--text-secondary`,
  etc.) are preserved as thin delegations in `globals.css` so any remaining
  `var(--bg-primary)` callers keep rendering.
- The CVA primitives (`buttonVariants`, `statusBadgeVariants`) already
  consumed the semantic tokens before Epic 51 remediation; the bridge just
  brings the *CSS class* layer into the same palette.

### Carved Carbon (Roadmap-22) <!-- docs-accuracy-allow: shipped-epic codename, not future tense -->

R19 gave buttons the liquid-carbon LANGUAGE; R20 made them ELEGANT.
R22 is the precision-refinement layer — five micro-detail moves
that take the silhouette from "premium" to "carved/precision-
machined". The R22 prompts converged on "carved, not inflated" as
the target aesthetic.

| PR | Lock |
|---|---|
| **A** Radius | `rounded-lg` (12px) → `rounded-[10px]` across button + control family. xs keeps `rounded-md` (pill avoidance at h-7). |
| **B** Border + Focus | `--btn-carbon-border` softened (dark α 0.30→0.18; light α 0.24→0.16). Tailwind `ring-2 ring-offset-2` dropped from cva base; focus rides the brand-tinted box-shadow halo via `focus-visible:shadow-[var(--ctrl-edge-focus)]`. Focused button + focused Input wear the same halo. `--btn-ambient-focus` ring tightened 4px → 3px. |
| **C** Icon discipline | Per-size icon scale via `[&_svg]:size-N` — xs/sm 14px · md 16px · lg 18px. Plus defensive `[&_svg]:shrink-0`. |
| **D** Disabled + Loading | Graded disabled mute via `disabled:saturate-50` on top of `disabled:opacity-50` (colour channel drops too). LoadingSpinner switched from hardcoded grey to `currentColor` (variant-aware). |
| **E** Variant + CTA order | Mac/iOS CTA order locked in `Modal.Confirm` (Cancel-then-Confirm DOM → `[Cancel] [Confirm]` right-aligned). Variant inventory documented; 5-variant count locked. |

The five R22 ratchets at
`tests/guards/r22-pr{a..e}-*.test.ts` form a contract surface;
the PR-F capstone ratchet at `r22-prf-capstone.test.ts` asserts
file-existence on all five so a future PR can't silently strip
one. Each PR's own assertions remain the substantive guard.

## Liquid Glass (Roadmap-24) <!-- docs-accuracy-allow: shipped-epic codename, not future tense -->

R24 swaps the button MATERIAL — from R19–R22's solid/machined
carbon to liquid glass — while reusing the existing composition
seams (R19's `::before` depth + R20's `::after` finish). What
changes is the recipe content inside; the API surface stays put.

External reference: [callstack/liquid-glass](https://github.com/callstack/liquid-glass).
Portable techniques (alpha-tinted backdrop + `backdrop-filter`,
1px gradient edge-sheen, layered inner-glow + outer-rim) were
adapted; the React Native / iOS-native runtime wrapper was
deliberately rejected — wrong stack.

| PR | Lock |
|---|---|
| **A** Glass token foundation | 5 `--btn-glass-*` tokens per theme (`-tint`, `-blur`, `-edge`, `-inner`, `-shadow`). Light + dark parity from day one. Namespace sealed — no `--ctrl-glass-`, no `--btn-frost-`, no `--btn-glass2-`. |
| **B** Primitive redesign | `glassSurface` / `glassOnHover` replace `carbonSurface` / `carbonOnHover` in every variant. R19-PR-D `carbonStates` (material-agnostic state opacity) + R20-PR-B iridescent/aura layers survive the swap. Zero `--btn-carbon-*` references left in cva variants. |
| **C** Slim radius | `rounded-[10px]` (R22-PR-A) → `rounded-[8px]` across button + control family. Completes the glass story — translucent surfaces want slimmer corners; big-radius reads plastic. Heights stay h-9 (form-control parity locked by R20-PR-A). |
| **D** State + a11y | `prefers-reduced-transparency: reduce` fallback strips `backdrop-blur` + forces `::before` to opacity-100 (WCAG 1.4.11; matches native control behaviour when users enable "Reduce Transparency"). R22-PR-D's two-channel disabled mute (opacity-50 + saturate-50) preserved. R20-PR-D ambient-elevation contract (active = collapsed; focus = brand-tinted halo) preserved. |
| **E** Icon-button rollout | Gear button (two implementations) moved from legacy `rounded-lg` (12px) to the slim `rounded-[8px]`. The toolbar now reads as one chassis instead of two systems. |
| **F** Hardening + capstone | Meta-ratchet locks all 6 R24 ratchets; defense-in-depth re-asserts the reduced-transparency fallback + slim radius + glass token namespace seal. |

The six R24 ratchets at `tests/guards/r24-pr{a..f}-*.test.ts`
form a contract surface; the PR-F capstone asserts file-existence
on all six so a future PR can't silently strip one. Each PR's own
assertions remain the substantive guard.

### When NOT to use glass material

- Page-level hero / dashboard surfaces — R17 already owns that
  language (ambient brand glow + 600ms rise-in). Don't paint glass
  on top of an already-rich surface.
- Sidebar / topbar chrome — R13/R14/R15 own those aesthetics.
- Form inputs (Input, Combobox trigger, DatePicker trigger) — they
  share the slim 8px radius + the focus halo, but the surface fill
  is opaque (transparency on a form field obscures content).

### Accessibility contract

- WCAG 1.4.11 (reduced transparency): the cva base ships the
  `prefers-reduced-transparency: reduce` media query fallback.
- WCAG 2.1.1 (keyboard accessible): focus-visible halo is distinct
  from hover; both are visible without colour-only cues.
- WCAG 2.5.5 (target size): default md height is h-9 (36px), above
  the AAA 44×44 recommendation when combined with padding (md ≥
  px-2.5 brings the click target above the bar in all sizes ≥ sm).
