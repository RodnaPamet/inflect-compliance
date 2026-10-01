"use client";

import { cn } from "@/lib/cn";
import { cva, type VariantProps } from "class-variance-authority";
import {
  CircleCheck,
  CircleHalfDottedCheck,
  CircleInfo,
  CircleWarning,
  Icon,
} from "./icons";
import { DynamicTooltipWrapper } from "./tooltip";

// v2-PR-3 — pill shape locked. Status surfaces in premium products
// (Linear / Stripe / Vercel) all converge on `rounded-full`. The
// previous `rounded-md` read more "label" than "status".
const statusBadgeVariants = cva(
  "inline-flex gap-1.5 items-center max-w-fit rounded-full font-medium whitespace-nowrap",
  {
    variants: {
      // Roadmap-6 PR-10 — `pending` retired. Zero callsites used it
      // across ~80 StatusBadge usages. The "pending" semantic is
      // expressible via `info` (in-progress / awaiting) or
      // `warning` (overdue / needs-attention) — `pending` was a
      // third name for one of those tones. Subtraction.
      variant: {
        neutral: "",
        info: "",
        success: "",
        warning: "",
        error: "",
      },
      tone: {
        // solid = the default tinted surface + tinted text (the
        // current visual). Tone-specific bg comes from the
        // `compoundVariants` table below.
        solid: "",
        // subtle = neutral surface with tone-tinted text only. For
        // tertiary status displays (draft, inactive, passive states)
        // where the standard tone would feel too loud.
        subtle: "bg-bg-subtle",
      },
      size: {
        sm: "px-1.5 py-0.5 text-[10px]",
        md: "px-2 py-1 text-xs",
      },
    },
    compoundVariants: [
      // ── Solid (default) — tinted bg + tinted text ─────────────────
      { variant: "neutral", tone: "solid", class: "bg-bg-subtle text-content-muted" },
      { variant: "info", tone: "solid", class: "bg-bg-info text-content-info" },
      { variant: "success", tone: "solid", class: "bg-bg-success text-content-success" },
      { variant: "warning", tone: "solid", class: "bg-bg-warning text-content-warning" },
      { variant: "error", tone: "solid", class: "bg-bg-error text-content-error" },
      // ── Subtle — neutral bg already applied; only the text color picks the tone ──
      { variant: "neutral", tone: "subtle", class: "text-content-muted" },
      { variant: "info", tone: "subtle", class: "text-content-info" },
      { variant: "success", tone: "subtle", class: "text-content-success" },
      { variant: "warning", tone: "subtle", class: "text-content-warning" },
      { variant: "error", tone: "subtle", class: "text-content-error" },
    ],
    // R9-PR11 — default tone flips solid → subtle, the "light"
    // treatment. Pages that genuinely need the loud
    // tinted-bg-on-tinted-text emphasis (critical errors that warrant
    // shouting) opt in with `tone="solid"` explicitly. Default chrome
    // is quieter; the eye anchors on tinted text alone instead of
    // tinted-on-tinted backgrounds, which were everywhere on every
    // row by default.
    defaultVariants: {
      variant: "neutral",
      tone: "subtle",
      size: "md",
    },
  },
);

const defaultIcons: Record<string, Icon> = {
  neutral: CircleInfo,
  info: CircleHalfDottedCheck,
  success: CircleCheck,
  warning: CircleWarning,
  error: CircleWarning,
};

/**
 * Concrete variant union for `<StatusBadge variant={...}>`. Exported so
 * call sites that build per-page mapping objects (`{ OPEN: 'error', ...}`)
 * can type the values with the same union the component itself accepts.
 */
type StatusBadgeVariant = NonNullable<
  VariantProps<typeof statusBadgeVariants>["variant"]
>;

interface StatusBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusBadgeVariants> {
  icon?: Icon | null;
  tooltip?: string | React.ReactNode;
}

function StatusBadge({
  className,
  variant,
  tone,
  size,
  icon,
  tooltip,
  onClick,
  children,
  ...props
}: StatusBadgeProps) {
  const ResolvedIcon =
    icon !== null ? icon ?? defaultIcons[variant ?? "neutral"] : null;

  return (
    <DynamicTooltipWrapper
      tooltipProps={tooltip ? { content: tooltip } : undefined}
    >
      <span
        className={cn(
          statusBadgeVariants({ variant, tone, size }),
          tooltip && "cursor-help",
          onClick &&
            "cursor-pointer select-none transition-[filter] duration-150 hover:brightness-75 hover:saturate-[1.25]",
          className,
        )}
        onClick={onClick}
        {...props}
      >
        {ResolvedIcon && <ResolvedIcon className="h-3 w-3 shrink-0" />}
        {children}
      </span>
    </DynamicTooltipWrapper>
  );
}

/**
 * Returns just the className portion of a status badge for surfaces that
 * can't be a `<StatusBadge>` element (e.g. interactive `<select>` /
 * `<button>` elements that need the badge visual but a different DOM
 * shape). Prefer `<StatusBadge>` everywhere it fits — only reach for
 * this helper when the parent element MUST be something else.
 */
function statusBadgeClassName(variant: StatusBadgeVariant): string {
  return statusBadgeVariants({ variant, tone: "solid" });
}

export { StatusBadge, statusBadgeVariants, statusBadgeClassName };
export type { StatusBadgeProps, StatusBadgeVariant };
