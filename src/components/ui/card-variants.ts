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
      none: "",
    },
  },
  defaultVariants: {
    elevation: "raised",
    density: "comfortable",
  },
});
