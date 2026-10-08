/**
 * `cardVariants` — class-string variants for the Card primitive.
 *
 * Lives in its own file (not `card.tsx`) so SERVER components can
 * import + call it. `card.tsx` carries `"use client"` because it
 * exports the React component; in Next.js App Router, importing a
 * function from a `"use client"` module into a server component
 * makes the import a CLIENT REFERENCE that cannot be invoked at
 * SSR time. The runtime symptom is "An error occurred in the
 * Server Components render" on every server-rendered page that
 * touches `cardVariants(...)`.
 *
 * Splitting the cva function into a server-safe module fixes the
 * boundary: server components import from `card-variants.ts`
 * (no directive — usable everywhere), the `<Card>` JSX component
 * stays in `card.tsx`. Both files re-export `cardVariants` as
 * the same value.
 *
 * Roadmap-5 PR-1 originally co-located cardVariants in card.tsx;
 * this hotfix extracts it after a runtime breakage caused by the
 * server/client boundary.
 */

import { cva } from "class-variance-authority";

export const cardVariants = cva("", {
  variants: {
    elevation: {
      // Matches page background — for nested sub-cards.
      flat: "bg-bg-page border border-border-subtle rounded-lg",
      // Faint tint for sub-panels inside a raised/floating parent
      // (diff blocks, rich-text chrome, attachment preview tiles).
      // Reads as "inset" not "next card on the same plane".
      inset: "rounded-lg border border-border-default bg-bg-subtle",
      // Default section-level card. Maps to the existing glass-card
      // recipe so the visual is unchanged for every consumer that
      // doesn't pass `elevation`.
      raised: "glass-card",
      // Above the `raised` plane — modal panels, popovers, active-
      // state surfaces.
      floating: "bg-bg-elevated border border-border-default rounded-lg",
    },
    density: {
      comfortable: "p-6",
      compact: "p-4",
      spacious: "p-12",
      // `p-0`, NOT `""`. #3143 put `.glass-card` inside `@layer
      // components` so a `className` utility beats the recipe's own
      // `@apply p-4 md:p-5` — but layering can only prefer a utility
      // that EXISTS. An empty string emits no utility at all, so `none`
      // was the one rung the layering could not reach: measured in
      // headless Chromium against the real postcss build, `elevation`
      // default `raised` → `.glass-card` rendered 16px / 20px at md for
      // every `cardVariants({ density: 'none' })` caller (89 of them in
      // src), instead of the zero padding the name promises. `p-0` is a
      // real rule in `@layer utilities` (`.p-0{padding:0px}`), and
      // utilities outrank components, so it wins.
      //
      // Safe for the callers that pair `none` with a DIRECTIONAL
      // override — `cn()` is tailwind-merge, which keeps `p-0` alongside
      // `px-*`/`py-*` rather than dropping either, and Tailwind emits
      // `.p-0` BEFORE `.px-*`/`.py-*` in the utilities layer, so the
      // directional rule still wins its own axis (measured:
      // `glass-card p-0 text-center py-12` → 48/0/48/0). A caller that
      // passes a uniform `p-N` keeps it, because tailwind-merge drops
      // the earlier `p-0` outright.
      //
      // Only `raised` was ever affected. The five `<Card density="none">`
      // JSX sites all pass `elevation="inset"`, whose recipe carries no
      // padding of its own, and they measured 0px both before and after.
      none: "p-0",
    },
  },
  defaultVariants: {
    elevation: "raised",
    density: "comfortable",
  },
});
