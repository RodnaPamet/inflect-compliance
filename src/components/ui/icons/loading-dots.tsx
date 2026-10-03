/**
 * Three pulsing dots.
 *
 * ── THEY DID NOT BLINK (fixed here) ───────────────────────────────
 *
 * Every dot carried `className="animate-blink"`, and `animate-blink`
 * resolved to NOTHING: there is no `blink` entry in this repo's
 * `tailwind.config.js` keyframes or animations and no `.animate-blink`
 * rule in `globals.css`, so the built stylesheet emits no utility for
 * it — verified by compiling `src/app/globals.css` through
 * `@tailwindcss/postcss` and finding zero occurrences of the string
 * `blink` in the 250 KB result. The staggered `animationDelay` below
 * was being computed and handed to an animation that did not exist, so
 * the component rendered three static dots.
 *
 * This is the same defect `loading-spinner.tsx` records one directory
 * over, and it takes the same fix for the same reason: `animate-pulse`
 * is a Tailwind BUILT-IN, so it resolves in any repo this file is
 * vendored into. Declaring a bespoke `blink` keyframe would have fixed
 * the symptom here and left the vendored copy still inert.
 *
 * The delays are restaggered to `pulse`'s 2s cycle (one third of it
 * apart, offset negative so the cycle is already in flight on first
 * paint), so the fade travels along the row.
 */

/** `pulse` runs for 2s; three dots means one third of that apart. */
const PULSE_DURATION_S = 2;
const DOTS = 3;

export function LoadingDots() {
  return (
    <span className="inline-flex items-center">
      {[...Array(DOTS)].map((_, i) => (
        <span
          key={i}
          style={{
            animationDelay: `${-PULSE_DURATION_S + (PULSE_DURATION_S / DOTS) * i}s`,
            backgroundColor: "black",
            width: "5px",
            height: "5px",
            borderRadius: "50%",
            display: "inline-block",
            margin: "0 1px",
          }}
          className="animate-pulse"
        />
      ))}
    </span>
  );
}
