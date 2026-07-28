import { cva } from "class-variance-authority";

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
 * `--brand-secondary-default` is documented in tokens.css as
 * complementary to the brand in both themes (electric blue ↔ METRO
 * yellow in dark, deep navy ↔ PwC orange in light). Nothing was
 * invented for this material; it is the existing palette, held still.
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
 * The shared solid-tile recipe: edge light over a body gradient, a
 * seat line, and a rest lift that inverts on press.
 *
 * Colour-agnostic — callers pass the two gradient stops, so primary
 * and destructive share one material and differ only in hue. That is
 * the point: a destructive button must read as the SAME physical
 * object as a primary one, or "dangerous" gets confused with
 * "different kind of control".
 */
function stillTile(from: string, to: string, lift: string) {
  return [
    `bg-[image:linear-gradient(to_bottom,var(--btn-still-top),transparent_46%),linear-gradient(to_bottom,${from},${to})]`,
    `border-[${to}]`,
    "shadow-[var(--btn-still-lift),inset_0_-1px_0_var(--btn-still-bot)]",
    // Hover brightens the gradient by shifting BOTH stops one rung up
    // the ramp — the tile gets lighter without losing its fall. A flat
    // brand fill on hover would read as the gradient collapsing.
    `hover:bg-[image:linear-gradient(to_bottom,var(--btn-still-top),transparent_46%),linear-gradient(to_bottom,${lift},${from})]`,
    // Press: the lift inverts to an inset and the gradient flattens to
    // the deep stop. Pressed still reads as pressed with nothing
    // travelling — the shadow does the work the transform used to.
    `active:bg-[image:linear-gradient(to_bottom,${to},${to})]`,
    "active:shadow-[var(--btn-still-press)]",
  ];
}

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
    // B3 — pill canonicalisation, retained. Form controls stay
    // rectangular (`control-variants.ts`); text-entry surfaces do not
    // follow the pill.
    "border rounded-full",
    // Mobile touch target (WCAG 2.5.5 / Apple HIG). On COARSE pointers
    // every button gets 44px regardless of its dense desktop height —
    // `min-h` only raises, so the 28px desktop density is untouched.
    // This is the one reason the density collapse below is safe on
    // touch: the tap target never shrinks with the visual.
    "pointer-coarse:min-h-11",
    // Focus: a two-stop halo — a surface-coloured spacer ring, then the
    // brand. Reads on every background because the spacer separates the
    // brand ring from whatever the button is sitting on.
    "focus-visible:outline-none",
    "focus-visible:shadow-[0_0_0_2px_var(--bg-default),0_0_0_4px_var(--brand-default)]",
    // Disabled: two channels muted (brightness + saturation) plus the
    // lift dropped, so a disabled tile reads as flat, dead material
    // rather than a dimmed live one.
    "disabled:opacity-45 disabled:saturate-50 disabled:shadow-none disabled:pointer-events-none",
  ],
  {
    variants: {
      variant: {
        // ── Primary. Brand tile; hover trades its own deep edge for
        //    the COMPLEMENTARY hue — blue on yellow, navy on orange.
        primary: [
          ...stillTile(
            "var(--brand-default)",
            "var(--brand-emphasis)",
            "var(--brand-muted)",
          ),
          "text-content-inverted",
          "hover:border-[var(--brand-secondary-default)]",
          "active:border-[var(--brand-secondary-default)]",
        ],
        // ── Secondary. The mirror: a surface tile that takes the BRAND
        //    edge on hover. Primary borrows secondary's hue, secondary
        //    borrows primary's — that reciprocity is the hover language.
        secondary: [
          "bg-[image:linear-gradient(to_bottom,var(--btn-still-top),transparent_52%),linear-gradient(to_bottom,var(--bg-default),var(--bg-muted))]",
          "text-content-emphasis border-[var(--border-emphasis)]",
          "shadow-[var(--btn-still-lift)]",
          "hover:border-[var(--brand-default)] hover:text-[var(--brand-default)]",
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
          ...stillTile(
            "var(--btn-still-danger)",
            "var(--btn-still-danger-deep)",
            "var(--btn-still-danger-lift)",
          ),
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
