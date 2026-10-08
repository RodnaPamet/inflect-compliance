/**
 * Card primitive — PR-6 + v2-PR-9 + Roadmap-5 PR-2.
 *
 * Wraps the legacy `.glass-card` CSS class with two typed axes:
 *
 *   density   — internal padding rung:
 *     "comfortable" (default)   p-6   — content cards, panels
 *     "compact"                 p-4   — stat cards, inline cards,
 *                                       dense interaction rows
 *     "spacious"                p-12  — empty / loading / permission
 *                                       states (Roadmap-5 PR-2);
 *                                       the inner content is just a
 *                                       short message, the breathing
 *                                       room IS the affordance
 *     "none"                    p-0   — children own padding
 *
 *   elevation — visual depth (v2-PR-9). Four levels expressed via
 *               background tone — never via shadow:
 *     "flat"     — bg-bg-page; matches the page background. Use for
 *                  nested sub-cards inside a `raised` card so the
 *                  inner card reads as part of the outer plane.
 *     "inset"    — bg-bg-subtle (Polish PR-3). Faint tinted surface
 *                  for sub-panels INSIDE a raised/floating parent —
 *                  diff blocks, rich-text editor chrome, attachment
 *                  preview tiles. Reads as "inset into the card" not
 *                  "next card on the same plane".
 *     "raised" (default) — the glass-card recipe (bg-bg-default +
 *                  backdrop-blur + glass border). The standard
 *                  section-level card.
 *     "floating" — bg-bg-elevated. Sits above `raised`; use for
 *                  modal panels, popovers, and active-state surfaces.
 *
 * Why no shadows? Premium products (Linear, Stripe, Vercel) express
 * depth through background-tone changes on dark surfaces, not via
 * box-shadow. Shadows on glass / blurred surfaces look uncertain;
 * tone-based elevation reads as deliberate and quiet.
 *
 * Why keep `.glass-card` underneath? It's the existing visual recipe
 * (backdrop-blur + glass-bg + glass-border) that already paints
 * correctly on both themes. The primitive is a typed wrapper, not a
 * replacement — `raised` (the default) maps directly to it.
 */

"use client";

import { cn } from "@inflect/ui/lib/cn";
import { type VariantProps } from "class-variance-authority";
import { forwardRef, type ElementType, type HTMLAttributes } from "react";

// `cardVariants` lives in a sibling non-`"use client"` module so
// SERVER components can import + call it. Re-exported here for
// existing callers that grab `{ Card, cardVariants }` together.
import { cardVariants } from "./card-variants";

type CardTag = "div" | "section" | "article" | "aside" | "li";

interface CardProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {
  /** Element override. Defaults to `<div>`. Use `section`/`article`
   * when the card represents a discrete content region the page
   * outline cares about. */
  as?: CardTag;
  className?: string;
}

const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { as = "div", density, elevation, className, children, ...rest },
  ref,
) {
  const Tag = as as ElementType;
  return (
    <Tag
      ref={ref}
      className={cn(cardVariants({ density, elevation }), className)}
      {...rest}
    >
      {children}
    </Tag>
  );
});

export { Card, cardVariants };
export type { CardProps };
