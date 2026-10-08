import { cva } from "class-variance-authority";

import { HIT_AREA_CLASS } from "./hit-area";

/**
 * STILL SURFACE — the motionless button material.
 *
 * Supersedes the whole R19 → R24 stack (carbon grain, aura wash,
 * iridescent meniscus, liquid glass). Those recipes built depth out of
 * MOTION: a hover fade on `::before`, an aura bloom on `::after`, a
 * press that shrank 3% and travelled 1px down. Still Surface builds the
 * same depth out of static light, and moves the hover signal out of
 * motion and into HUE.
 *
 * The thesis: hover is a TRADE OF EDGES. The brand tile takes the
 * complementary edge; the surface tile takes the brand edge. Each
 * variant borrows the other's colour, and neither one moves to do it.
 *
 * The complementary hue was already in the system —
 * `--brand-secondary-default` is documented in tokens.css as the
 * brand's complement. THAT IS A REQUIREMENT ON THE TOKEN, not a
 * description of one palette: this material's hover language is a trade
 * of edges, so `--brand-secondary-default` MUST be the complementary
 * hue of `--brand-default` in EVERY theme the product ships. Give it
 * some unrelated accent and hover stops reading as a trade and starts
 * reading as a mistake. Nothing was invented here; it is the existing
 * palette, held still.
 *
 * Four static layers carry the depth, none of them a keyframe:
 *   1. edge light   — a highlight along the top ~46% (`--btn-still-top`)
 *   2. body gradient— brand → brand-emphasis vertical fall
 *   3. seat line    — `inset 0 -1px 0 var(--btn-still-bot)`
 *   4. lift → inset — `--btn-still-lift` inverts to `--btn-still-press`
 *
 * WHY MOTIONLESS. Feedback is not the same thing as animation. Every
 * state here switches instantly, which means the states can also be
 * DOCUMENTED side by side as static swatches — and there is nothing
 * left for `prefers-reduced-motion` to strip, because there was never
 * anything moving to begin with.
 *
 * Deliberately removed (do not reintroduce — the ratchets below fail):
 *   `transition-all duration-150`   base transition
 *   `active:scale-[0.97]`           press shrink
 *   `active:translate-y-px`         press travel
 *   `before:transition-opacity`     hover fade
 *   `hover:after:shadow-*`          aura bloom
 *   `backdrop-blur-*`               unnecessary once the fill is graded
 */

/**
 * THE SHARED SOLID-TILE RECIPE — eight classes, written out per variant.
 *
 * Edge light over a body gradient, a seat line, and a rest lift that
 * inverts on press. Primary and destructive wear the SAME material and
 * differ only in hue — a destructive button must read as the same
 * physical object as a primary one, or "dangerous" gets confused with
 * "different kind of control". The four hue slots, in the order the
 * classes appear below:
 *
 *   base  solid background-color (see A11Y below)
 *   from  rest gradient head        to  rest gradient tail + rest edge
 *   lift  hover brighten
 *
 * WHY THE EIGHT ARE SPELLED OUT RATHER THAN GENERATED (#3084). This was
 * `stillTile(from, to, lift, base)`, which returned them as template
 * literals — `bg-[${base}]`, `border-[${to}]`, the two `bg-[image:…]`
 * gradients, the `active:` flat gradient. Tailwind finds classes by
 * SCANNING SOURCE TEXT and never evaluates a function, so
 * `bg-[var(--btn-still-danger)]` was a string that existed nowhere in the
 * tree. Measured on a real CSS build of this entry point: ELEVEN of the
 * tile's fourteen classes had no rule in the output at all. Destructive
 * therefore painted no fill — a white label on the white UA background in
 * the light theme — and primary looked roughly right only because
 * `bg-[var(--brand-emphasis)]` happens to be written literally in ten
 * other components.
 *
 * So the literal strings ARE the contract, and the duplication is the
 * price of it: a class Tailwind cannot see does not exist. Do not DRY
 * these back into a helper, an interpolation or a `cn()` of fragments,
 * and do not reach for a `tailwind.config.js` safelist — that is a second
 * list, kept in sync by hand, that drifts. `still-surface-button-material`
 * evaluates `buttonVariants()` for every variant and fails if any class it
 * returns is not written literally in a file Tailwind scans.
 *
 * A11Y — WHY `base` EXISTS AT ALL. A tile painted only with
 * `background-image` has no colour for a contrast checker to resolve, so
 * axe walks up to the nearest ancestor with a real `background-color` —
 * the page — and measures the label against THAT. On primary that meant
 * navy-on-navy (~1:1) and a serious colour-contrast violation on every
 * page, even though the label against the actual gradient is ~9.6:1. Each
 * variant's `base` is deliberately the WORST-CASE stop for its own text
 * colour, so a checker measures the true floor rather than a flattering
 * midpoint: the DEEP stop where the label is dark (primary — dark ink
 * needs a light field) and the LIGHTEST stop where the label is white
 * (destructive — white needs a dark field).
 *
 * HOVER brightens the gradient by shifting BOTH stops one rung up the
 * ramp: the tile gets lighter without losing its fall, where a flat brand
 * fill would read as the gradient collapsing. The hover base tracks the
 * hover gradient for the same reason.
 *
 * PRESS inverts the lift to an inset and flattens the gradient to the deep
 * stop. Pressed reads as pressed with nothing travelling — the shadow does
 * the work the transform used to.
 */

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center whitespace-nowrap",
    "relative",
    // MOTIONLESS BY CONSTRUCTION. These three are the material's
    // defining property, not an optimisation — every state below
    // switches on the same frame as the pointer.
    "transition-none",
    "[animation:none]",
    "[transform:none]",
    "[&_svg]:shrink-0",
    // B3 — pill canonicalisation, retained. Form inputs stay
    // rectangular (`control-variants.ts`); text-entry surfaces do not
    // follow the pill.
    "border rounded-full",
    // HIT AREA — the corners of the box belong to the button. A
    // `rounded-full` button hit-tests as a circle inside a square, so 16%
    // of a 28px icon button was inert; see `hit-area.ts` for the
    // measurements and the two load-bearing details.
    //
    // It paints nothing — no background, no shadow, no transition. Still
    // Surface's "no pseudo-element layers" rule is about MATERIAL (the
    // retired hover fades and aura blooms); this layer has no material,
    // and the ratchet distinguishes the two.
    HIT_AREA_CLASS,
    // Mobile touch target (WCAG 2.5.5 / Apple HIG). On COARSE pointers
    // every button gets 44px regardless of its dense desktop height —
    // `min-h` only raises, so the 28px desktop density is untouched.
    // This is the one reason the density collapse below is safe on
    // touch: the tap target never shrinks with the visual.
    "pointer-coarse:min-h-11",
    // Focus: a two-stop halo — a surface-coloured spacer ring, then the
    // accent. Reads on every background because the spacer separates the
    // accent ring from whatever the button is sitting on. `--accent-default`
    // aliases the brand here (tokens.css), so this is the brand ring it
    // always was; a host that points with another colour than it fills
    // with sets that one token, without touching the fill.
    "focus-visible:outline-none",
    "focus-visible:shadow-[0_0_0_2px_var(--bg-default),0_0_0_4px_var(--accent-default)]",
    // Disabled: two channels muted (brightness + saturation) plus the
    // lift dropped, so a disabled tile reads as flat, dead material
    // rather than a dimmed live one.
    "disabled:opacity-45 disabled:saturate-50 disabled:shadow-none disabled:pointer-events-none",
  ],
  {
    variants: {
      variant: {
        // ── Primary. Brand tile; hover trades its own deep edge for
        //    the COMPLEMENTARY hue, whatever the theme's brand is.
        primary: [
          // base — dark ink on a light field, so the DEEP stop is the floor.
          "bg-[var(--brand-emphasis)]",
          // from → to: brand → brand-emphasis.
          "bg-[image:linear-gradient(to_bottom,var(--btn-still-top),transparent_46%),linear-gradient(to_bottom,var(--brand-default),var(--brand-emphasis))]",
          "border-[var(--brand-emphasis)]",
          "shadow-[var(--btn-still-lift),inset_0_-1px_0_var(--btn-still-bot)]",
          // lift — one rung up the brand ramp.
          "hover:bg-[var(--brand-muted)]",
          "hover:bg-[image:linear-gradient(to_bottom,var(--btn-still-top),transparent_46%),linear-gradient(to_bottom,var(--brand-muted),var(--brand-default))]",
          // NO PRESS FILL FLIP. Removed 2026-10-04 on the owner's report that
          // buttons "again on-click returned to being animated".
          //
          // This class and its destructive twin were written as TEMPLATE
          // LITERALS until #3084/#3101, so Tailwind — which finds classes by
          // scanning source text and never evaluates a function — emitted NO
          // rule for either. Pressing a primary or destructive button changed
          // nothing visible, for as long as the recipe was generated. #3101
          // spelled the tile classes out so the real bug it was fixing (a
          // destructive button with NO fill at all: white label on white
          // ground in the light theme) could be fixed, and that made these two
          // live for the first time. The fill then flipped to a flat colour on
          // every click.
          //
          // Verified by extracting `:active` rules from the real postcss build
          // on both sides of #3101: exactly these two appeared, 17 -> 19.
          //
          // What press feedback REMAINS, deliberately: the seat shadow
          // (`active:shadow-[var(--btn-still-press)]`, below) and the
          // reciprocal edge (`active:border-…`). Both were already emitted
          // before #3101, so neither is part of what the owner saw change.
          // The motion kill-switches in the cva base are untouched.
          "active:shadow-[var(--btn-still-press)]",
          "text-content-inverted",
          "hover:border-[var(--brand-secondary-default)]",
          "active:border-[var(--brand-secondary-default)]",
        ],
        // ── Secondary. The mirror: a surface tile that takes the BRAND
        //    edge on hover. Primary borrows secondary's hue, secondary
        //    borrows primary's — that reciprocity is the hover language.
        secondary: [
          "bg-[var(--bg-muted)]",
          "bg-[image:linear-gradient(to_bottom,var(--btn-still-top),transparent_52%),linear-gradient(to_bottom,var(--bg-default),var(--bg-muted))]",
          "text-content-emphasis border-[var(--border-emphasis)]",
          "shadow-[var(--btn-still-lift)]",
          // The hover LABEL goes through `--content-brand`, not
          // `--brand-default`. The two are the same hue and the same
          // value in the dark theme; in the light theme the fill token
          // is #D04A02, which measures ~4:1 against the surface this
          // tile paints — under the 4.5:1 AA floor for body text. The
          // EDGE keeps the fill token: 1.4.11 asks 3:1 of a boundary,
          // which it clears, and the reciprocal trade with primary is
          // stated in the border.
          "hover:border-[var(--brand-default)] hover:text-content-brand",
          "active:bg-[image:linear-gradient(to_bottom,var(--bg-muted),var(--bg-muted))]",
          "active:border-[var(--brand-default)] active:shadow-[var(--btn-still-press)]",
        ],
        // ── Ghost. No tile at rest — it has no surface to light. It
        //    gains one on hover, and that is the whole state change.
        ghost: [
          "bg-transparent border-transparent text-content-muted shadow-none",
          "hover:bg-bg-muted hover:text-content-emphasis",
          "active:bg-bg-muted active:shadow-[var(--btn-still-press)]",
        ],
        // ── Destructive. Same material, danger hue — and deliberately
        //    NO reciprocal edge. A destructive action must not borrow
        //    the brand's hover language and read as routine, so it
        //    keeps a red edge through every state.
        destructive: [
          // base — white label on a dark field, so the LIGHTEST stop is the
          // floor; that is `--btn-still-danger`, the rest head, not the tail.
          "bg-[var(--btn-still-danger)]",
          // from → to: danger → danger-deep.
          "bg-[image:linear-gradient(to_bottom,var(--btn-still-top),transparent_46%),linear-gradient(to_bottom,var(--btn-still-danger),var(--btn-still-danger-deep))]",
          "border-[var(--btn-still-danger-deep)]",
          "shadow-[var(--btn-still-lift),inset_0_-1px_0_var(--btn-still-bot)]",
          // lift — one rung up the danger ramp.
          "hover:bg-[var(--btn-still-danger-lift)]",
          "hover:bg-[image:linear-gradient(to_bottom,var(--btn-still-top),transparent_46%),linear-gradient(to_bottom,var(--btn-still-danger-lift),var(--btn-still-danger))]",
          // No press fill flip — see the primary variant. Same mechanism,
          // same removal. `--btn-still-danger-deep` keeps its two other
          // consumers (the rest gradient's tail and the border), so the token
          // is not orphaned by this.
          "active:shadow-[var(--btn-still-press)]",
          "text-white",
        ],
      },
      size: {
        // ── SINGLE-RUNG LADDER (2026-07-28) ───────────────────────────
        //
        // Every rung resolves to the artifact's `xs` geometry: 28px
        // tall, 0.7rem horizontal, 0.76rem type, +0.005em tracking
        // (small text wants OPEN tracking to stay legible — the same
        // reason classic small-caps feel confident).
        //
        // The `size` prop is deliberately KEPT rather than deleted from
        // 646 call sites. Two reasons:
        //   1. Reversal is a one-file edit. Restoring the 28/32/36/40
        //      ladder means giving these four keys their own values
        //      again — no call-site archaeology.
        //   2. The call sites still RECORD intent. `size="lg"` on a
        //      featured CTA remains a true statement about that
        //      button's importance even while it renders at 28px.
        //      Stripping the props would discard that information
        //      permanently.
        //
        // Icon sizing is the artifact's flat 15px rather than a graded
        // scale, since there is no longer a height ladder to grade
        // against.
        xs: "h-7 px-[0.7rem] text-[0.76rem] gap-tight tracking-[0.005em] font-[560] [&_svg]:size-[15px]",
        sm: "h-7 px-[0.7rem] text-[0.76rem] gap-tight tracking-[0.005em] font-[560] [&_svg]:size-[15px]",
        md: "h-7 px-[0.7rem] text-[0.76rem] gap-tight tracking-[0.005em] font-[560] [&_svg]:size-[15px]",
        lg: "h-7 px-[0.7rem] text-[0.76rem] gap-tight tracking-[0.005em] font-[560] [&_svg]:size-[15px]",
        // Icon-only stays SQUARE at the same 28px so it lines up beside
        // text buttons. Callers must supply `aria-label`.
        icon: "h-7 w-7 p-0 tracking-normal font-[560] [&_svg]:size-[15px] pointer-coarse:min-w-11",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);
