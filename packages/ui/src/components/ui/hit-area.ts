/**
 * HIT_AREA_CLASS — the square hit area for a rounded control.
 *
 * The problem, measured on a dense list-page toolbar before this
 * shipped:
 *
 *   dashboard icon button  28x28  rounded-full   dead-zone=16%
 *   notifications bell     22x22  rounded-full   dead-zone=14%
 *   view toggle option     63x20  rounded-12px   dead-zone= 5%
 *
 * "Dead zone" = the share of the control's OWN box that renders as the
 * control but does not answer to `:hover`. Hit-testing follows the
 * rounded shape, so on a `rounded-full` 28px icon button — a circle in a
 * square — the four corner arcs are inert. Approach one diagonally and
 * the pointer sits visibly on the tile with the hover state off; a
 * two-pixel wiggle across the arc toggles it on and off. That is the
 * flicker: the pointer leaves the hover region while the cursor is still
 * on the control.
 *
 * The fix is a transparent, square `::before` covering the border box. A
 * pseudo-element is hit-tested as part of the element that owns it, so
 * hovering a corner sets `:hover` on the control. It paints nothing.
 *
 * Two details are load-bearing:
 *
 *   `-inset-px`  — an absolutely positioned child resolves its offsets
 *                  against the PADDING box, so `inset-0` stops one pixel
 *                  short and leaves the border ring dead. Measured, that
 *                  residue was still 5% of a 28px button, and WORSE than
 *                  the original: the hit region became an arc plus a
 *                  square edge, which a wiggle crosses four times instead
 *                  of two. One pixel out matches the 1px border exactly.
 *                  It must never grow beyond that — a larger inset would
 *                  spill into a neighbouring control's space and let one
 *                  button answer for its neighbour's hover.
 *
 *   `rounded-none`— inheriting the radius would restore the very dead
 *                  zone this exists to remove.
 *
 * Two things about the OWNER matter:
 *
 *   - It must be a positioning context (`relative`), or the offsets
 *     resolve against some ancestor and the hit area detaches.
 *   - It must not clip its overflow. `overflow: hidden` — which
 *     Tailwind's `truncate` sets — clips the pseudo-element back to the
 *     rounded padding box and re-creates the dead corners exactly. Put
 *     the truncation on the label child, where the ellipsis belongs.
 *
 * Verified with `dead-zone=0% / corner-wiggle-flips=0` on every control
 * that carries it.
 */
export const HIT_AREA_CLASS =
    "before:content-[''] before:absolute before:-inset-px before:rounded-none";

/**
 * TOUCH_HIT_AREA_CLASS — a 44px hit area on a touch screen for a control
 * whose painted size must stay small.
 *
 * `HIT_AREA_CLASS` above fills the dead corners INSIDE a rounded box; it never
 * makes the box bigger. This one does the other job: a transparent `::after`,
 * centred on the control, at least 44x44 on a coarse pointer (WCAG 2.5.5,
 * Apple HIG) and exactly the control's own box everywhere else. A
 * pseudo-element is hit-tested as part of the element that owns it, so a tap
 * anywhere in that square lands on the control, while its layout box — and so
 * the line, the label or the row it sits in — does not move by a pixel.
 *
 * Reach for it where the `pointer-coarse:min-h-11 pointer-coarse:min-w-11`
 * floor the top-bar buttons use would push neighbours around: an inline help
 * icon beside a label, a glyph inside a line of text.
 *
 * `::after`, not `::before`, so a control can wear both this and
 * `HIT_AREA_CLASS` without the two fighting over one pseudo-element. The owner
 * must be a positioning context (`relative`) and must not clip its overflow,
 * for the reasons `HIT_AREA_CLASS` gives.
 *
 * The square can reach past the control into a neighbour's space. Where that
 * neighbour is interactive, give the two room rather than letting one answer
 * for the other's taps.
 */
export const TOUCH_HIT_AREA_CLASS =
    "after:content-[''] after:absolute after:left-1/2 after:top-1/2 after:h-full after:w-full after:-translate-x-1/2 after:-translate-y-1/2 pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11";
