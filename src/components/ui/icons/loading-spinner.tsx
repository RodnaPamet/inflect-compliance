import { cn } from "@inflect/ui/lib/cn";

/**
 * The twelve-bar spinner.
 *
 * ── IT DID NOT SPIN (fixed here) ──────────────────────────────────
 *
 * Every bar carried `className="animate-spinner"`, and `animate-spinner`
 * resolved to NOTHING: there is no `spinner` entry in this repo's
 * `tailwind.config.js` keyframes or animations, no `.animate-spinner`
 * rule in `globals.css`, and the same hole exists in the downstream
 * repo this file is vendored into. Tailwind emits no utility for an
 * animation nobody declared, so the class was inert and the component
 * rendered twelve static bars in a ring — a sunburst, not a spinner.
 * The staggered `animationDelay` below was being computed and handed to
 * an animation that did not exist.
 *
 * The fix is `animate-pulse`, and the choice is deliberate:
 *
 *   - It is a Tailwind BUILT-IN, so it resolves in any repo this file
 *     is copied into. Declaring a bespoke `spinner` keyframe would have
 *     fixed the symptom here and left the vendored copy still inert.
 *   - It animates OPACITY. The twelve bars sit at 30° intervals, which
 *     makes the figure twelve-fold symmetric — rotating it (`animate-spin`)
 *     would be invisible, and worse, `spin`'s keyframes animate
 *     `transform`, which would override each bar's inline
 *     `rotate(...) translate(...)` placement and collapse all twelve
 *     onto the centre.
 *   - It is already this repo's canonical loading animation.
 *
 * The delays are restaggered to `pulse`'s 2s cycle (2/12 s apart,
 * offset negative so the cycle is already in flight on first paint), so
 * the fade travels once around the ring per revolution.
 *
 * R22-PR-D — `background: "gray"` was hardcoded on every segment, so
 * the spinner read the same washed grey regardless of context (primary
 * button with white text → grey spinner = visual mismatch). Switching
 * to `currentColor` lets it inherit the parent's text colour: a primary
 * loading button spins in the inverted token, a secondary in
 * `text-content-emphasis`, a destructive white on red, a ghost in its
 * muted tone. One token, variant-aware automatically.
 */

/** `pulse` runs for 2s; twelve bars means one twelfth of that apart. */
const PULSE_DURATION_S = 2;
const BARS = 12;

export function LoadingSpinner({ className }: { className?: string }) {
  return (
    <div className={cn("h-5 w-5", className)}>
      <div
        style={{
          position: "relative",
          top: "50%",
          left: "50%",
        }}
        className={cn("loading-spinner", "h-5 w-5", className)}
      >
        {[...Array(BARS)].map((_, i) => (
          <div
            key={i}
            style={{
              animationDelay: `${-PULSE_DURATION_S + (PULSE_DURATION_S / BARS) * i}s`,
              background: "currentColor",
              position: "absolute",
              borderRadius: "1rem",
              width: "30%",
              height: "8%",
              left: "-10%",
              top: "-4%",
              transform: `rotate(${(360 / BARS) * i}deg) translate(120%)`,
            }}
            className="animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}
