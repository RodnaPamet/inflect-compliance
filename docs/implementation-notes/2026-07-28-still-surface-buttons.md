# 2026-07-28 — Still Surface: the motionless button material

**Commit:** `<sha>` feat(ui): Still Surface button material — motionless, four canonical variants, one 28px rung

Applies the "Still Surface" design proposal to the whole button surface,
collapses the size ladder to a single 28px rung (form controls in lockstep),
and culls the button catalogue to exactly four canonical shapes.

## Design

### The material

Supersedes the entire Roadmap-19 → Roadmap-24 stack: carbon grain + light
pool (R19), aura wash + iridescent meniscus (R20), liquid glass (R24). Every
one of those built depth out of MOTION — a hover fade on `::before`, an aura
bloom on `::after`, a press that shrank 3% (`active:scale-[0.97]`) and
travelled 1px down (`active:translate-y-px`).

Still Surface builds the same depth out of static light, and relocates the
hover signal from motion into **hue**. Hover is a *trade of edges*: the brand
tile takes the complementary edge, the surface tile takes the brand edge.

Four static layers, no keyframes:

| Layer | Mechanism |
|---|---|
| Edge light | `linear-gradient(top, var(--btn-still-top), transparent 46%)` |
| Body gradient | `--brand-default` → `--brand-emphasis` |
| Seat line | `inset 0 -1px 0 var(--btn-still-bot)` |
| Lift → inset | `--btn-still-lift` inverts to `--btn-still-press` on `:active` |

The complementary hue was **already in the palette**. `--brand-secondary-default`
is documented in `tokens.css` as complementary to the brand in both themes
(`#3B82F6` electric blue ↔ METRO yellow in dark; `#1E3A8A` deep navy ↔ PwC
orange in light). Verified before building: the proposal's raw hex values map
1:1 onto existing tokens — `#003C7A`→`--bg-default`, `#002F5F`→`--bg-muted`,
`#00538C`→`--border-default`, `#ECF1F7`→`--content-emphasis`,
`#E6B800`/`#B83D00`→`--brand-emphasis`. Only four new tokens per theme were
genuinely needed (`--btn-still-{top,bot,lift,press}`) plus three danger stops.

### The single rung

Every `size` key resolves to the same 28px geometry. The `size` prop is
**kept** rather than stripped from its 646 call sites, for two reasons:
reversal becomes a one-file edit, and `size="lg"` still records that a button
was meant to be prominent even while it renders at 28px. Stripping the props
would discard that intent permanently.

**Form controls move in lockstep.** `controlSize` collapsed to the same rung.
This is load-bearing: `control-variants.ts` exists precisely to keep
`<Input size="md">` and `<Button size="md">` the same height, and a 28px
button beside a 36px input is a visibly broken filter toolbar. The retired
R20-PR-A ratchet asserted this lockstep; the new ratchet re-asserts it.

Touch safety is unaffected — `pointer-coarse:min-h-11` gives every button a
44px target on coarse pointers, and `min-h` only raises.

## Files

| File | Role |
|---|---|
| `src/components/ui/button-variants.ts` | Full rewrite — the Still Surface material, four variants, single-rung ladder. |
| `src/components/ui/button.tsx` | Disabled-branch mirror collapsed to one line; `destructive-outline` shortcut styling dropped. |
| `src/components/ui/control-variants.ts` | `controlSize` collapsed to the matching 28px rung. |
| `src/styles/tokens.css` | New `--btn-still-*` suite (both themes) + danger stops. |
| 7 admin/security pages | `variant="destructive-outline"` → `"destructive"`. |
| `tests/guards/still-surface-button-material.test.ts` | **New** canonical ratchet — 30 assertions. |
| 16 retired guard files | R19-PR-D, R20-PR-A…F, R22-PR-A…D, R24-PR-B…F, button-press-feedback. |
| `tests/guards/{button-variant-cull,button-label-centering,b10-…,r22-pre-…,roadmap-11-…}` | Updated for the new contract. |
| `docs/ui-buttons.md` | Button section rewritten. |

## Decisions

- **Retired 16 epic guards rather than weakening them.** Each pinned the
  superseded material layer by layer (`glassSurface` exists, `carbonStates` is
  spread into the base, `active:scale-[0.97]` is present). Those assertions are
  false *by design* now, so softening them would have left ratchets that no
  longer guard anything. Their surviving invariants — pill radius, coarse-pointer
  touch target, two-channel disabled mute, focus indicator, icon `shrink-0`,
  primary-label contrast — are re-asserted in the new consolidated ratchet, so
  nothing durable was dropped on the floor.

- **The banned-class list reports *what* you are undoing.** Each entry carries a
  `why` ("the 3% press shrink (R11-PR4)") surfaced in the failure message. A
  regex failure alone would tell a future contributor that a rule exists, not
  which deliberate decision they are reversing.

- **Asserting the ABSENCE of pseudo-elements is stronger than positioning them.**
  The old centring ratchet required `before:absolute`/`after:absolute` because a
  Tailwind `before:*` utility auto-adds `content:""`, making an unpositioned
  pseudo a 0-width in-flow flex item that shifted labels ~4px. Still Surface has
  no pseudo layers at all, so the failure mode is structurally impossible; the
  ratchet now asserts none can return.

- **`destructive-outline` folded into `destructive` — with a real cost.**
  Roadmap-22 PR-E explicitly reviewed and KEPT this variant, arguing the gap
  between full-red-fill and red-outline was the affordance difference between
  "delete-and-it's-gone" and "remove-this-link", and closed by saying a future PR
  may fold them if the distinction stops earning its keep. This is that PR. The
  canonical set is four, so the fifth went — but *Revoke API key* and *Delete
  framework* now render identically. That difference should be carried in the
  label and confirm copy, which is where `CLAUDE.md`'s destructive-action
  vocabulary already puts it (`Revoke {Credential}` vs `Delete {Entity}`).

- **The size ladder is collapsed, not deleted.** The proposal ships a graded
  4-rung ladder and explicitly grades weight and tracking so "small labels stay
  legible and large ones stay deliberate". Collapsing every button to the `xs`
  rung is a deliberate override of that grading, requested on top of the
  material change — page-header primary actions now read at the same weight as
  inline row actions. Recorded here because the note is where a future engineer
  would look to find out whether the flattening was intentional.

- **The dead `--btn-glass-*` / `--btn-carbon-*` / `--btn-aura-*` tokens were
  left in place.** They are no longer referenced by any button, but three
  surviving ratchets (`r24-pra-glass-token-foundation`, `r24-pre-rollout`,
  `r22-prf-capstone`) assert their existence. Removing them is a separate,
  clean follow-up; bundling it here would have cascaded the diff for no visual
  gain (unused custom properties cost nothing at runtime).
