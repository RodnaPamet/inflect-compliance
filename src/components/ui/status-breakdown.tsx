"use client";

/**
 * Epic 59 — status-distribution breakdown.
 *
 * The repeated per-row distribution bar pattern on vendors, tasks,
 * and risks dashboards:
 *
 *     [●] Active            12  [▓▓▓▓▓▓░░░░]
 *     [●] Pending            3  [▓▓░░░░░░░░]
 *     [●] Offboarding        1  [▓░░░░░░░░░]
 *
 * This is NOT a single-value progress. Each row is a category whose
 * bar represents its share of the total (or of a specified max). The
 * shared `<ProgressBar>` is semantically wrong here — it's one
 * "progress toward goal" affordance, and forcing categorical rows
 * through it would misrepresent what users see. The audit also
 * explicitly called for a dedicated abstraction so future dashboards
 * don't re-derive the same math + JSX.
 *
 * ## When to use `<StatusBreakdown>` vs. `<ProgressBar>`
 *
 *   ProgressBar:        one value advancing toward a max. "Coverage 73%".
 *   StatusBreakdown:    several labelled categories sharing a total.
 *                       "12 Active, 3 Pending, 1 Offboarding".
 *
 * If a dashboard needs both, use both — they're different visuals.
 *
 * ## API contract
 *
 *   items   — array of `{ label, value, variant? | colorClass? }`.
 *             `variant` drives token-backed color; `colorClass` is
 *             an escape hatch for legacy brand-specific palettes
 *             (used by vendors dashboard's criticality scale).
 *   total   — explicit total; defaults to `sum(items.value)`.
 *   size    — `sm` (compact toolbar row) | `md` (dashboard card).
 *   showDot — render a colored dot to the left of each label.
 *   showCount, showPercent — toggles for the right-edge labels.
 *   emptyState — ReactNode shown when total === 0 (default: "No data").
 */

import { cn } from "@inflect/ui/lib/cn";
import type { ReactNode } from "react";

export type StatusBreakdownVariant =
    | "brand"
    | "success"
    | "warning"
    | "error"
    | "info"
    | "neutral";

export type StatusBreakdownSize = "sm" | "md";

export interface StatusBreakdownItem {
    /** Row label — short, plain text. */
    label: ReactNode;
    /** Numeric value for this row. */
    value: number;
    /**
     * Semantic variant — drives the token-backed fill color. Omit
     * and pass `colorClass` instead when a legacy / brand palette
     * needs to be preserved.
     */
    variant?: StatusBreakdownVariant;
    /**
     * Escape hatch: an explicit Tailwind `bg-*` class used for both
     * the dot and the bar. Takes precedence over `variant`.
     */
    colorClass?: string;
    /** Stable key for the row. Falls back to `label + index`. */
    id?: string;
}

export interface StatusBreakdownProps {
    items: StatusBreakdownItem[];
    /** Explicit total. Defaults to `sum(items.value)`. */
    total?: number;
    size?: StatusBreakdownSize;
    showDot?: boolean;
    showCount?: boolean;
    showPercent?: boolean;
    emptyState?: ReactNode;
    /** Screen-reader label for the whole breakdown group. */
    ariaLabel?: string;
    className?: string;
}

const VARIANT_FILL: Record<StatusBreakdownVariant, string> = {
    brand: "bg-brand-emphasis",
    success: "bg-[var(--content-success)]",
    warning: "bg-[var(--content-warning)]",
    error: "bg-[var(--content-error)]",
    info: "bg-[var(--content-info)]",
    neutral: "bg-content-muted",
};

const SIZE_BAR_HEIGHT: Record<StatusBreakdownSize, string> = {
    sm: "h-1.5",
    md: "h-2",
};

const SIZE_DOT: Record<StatusBreakdownSize, string> = {
    sm: "w-2 h-2",
    md: "w-2.5 h-2.5",
};

const SIZE_TEXT: Record<StatusBreakdownSize, string> = {
    sm: "text-xs",
    md: "text-sm",
};

function resolveFill(item: StatusBreakdownItem): string {
    if (item.colorClass) return item.colorClass;
    return VARIANT_FILL[item.variant ?? "brand"];
}

export function StatusBreakdown({
    items,
    total,
    size = "md",
    showDot = true,
    showCount = true,
    showPercent = false,
    emptyState = (
        <p className="text-sm text-content-subtle">No data</p>
    ),
    ariaLabel,
    className,
}: StatusBreakdownProps) {
    const computedTotal =
        total ?? items.reduce((sum, item) => sum + item.value, 0);

    if (computedTotal === 0 || items.length === 0) {
        return <div className={className}>{emptyState}</div>;
    }

    const barHeight = SIZE_BAR_HEIGHT[size];
    const dotSize = SIZE_DOT[size];
    const textSize = SIZE_TEXT[size];

    return (
        <div
            className={cn("space-y-tight", className)}
            role="group"
            aria-label={ariaLabel}
        >
            {items.map((item, idx) => {
                const fill = resolveFill(item);
                const percent =
                    computedTotal > 0 ? (item.value / computedTotal) * 100 : 0;
                const percentLabel = `${Math.round(percent)}%`;
                const key = item.id ?? `${typeof item.label === "string" ? item.label : ""}-${idx}`;

                return (
                    <div
                        key={key}
                        className={cn("flex items-center gap-tight", textSize)}
                    >
                        {showDot && (
                            <span
                                aria-hidden
                                className={cn(
                                    "shrink-0 rounded-full",
                                    dotSize,
                                    fill,
                                )}
                            />
                        )}
                        <span className="flex-1 min-w-0 truncate text-content-muted">
                            {item.label}
                        </span>
                        {showCount && (
                            <span
                                className="min-w-[2rem] text-right font-mono text-content-emphasis"
                                aria-label={`Count ${item.value}`}
                            >
                                {item.value}
                            </span>
                        )}
                        {showPercent && (
                            <span
                                className="min-w-[3rem] text-right text-content-muted"
                                aria-label={`${percentLabel} of total`}
                            >
                                {percentLabel}
                            </span>
                        )}
                        <div
                            className={cn(
                                "w-16 overflow-hidden rounded-full bg-bg-subtle",
                                barHeight,
                            )}
                            role="progressbar"
                            aria-label={
                                typeof item.label === "string"
                                    ? `${item.label}: ${item.value} of ${computedTotal}`
                                    : undefined
                            }
                            aria-valuenow={item.value}
                            aria-valuemin={0}
                            aria-valuemax={computedTotal}
                        >
                            <div
                                className={cn(
                                    "h-full rounded-full transition-all",
                                    fill,
                                )}
                                style={{
                                    // Width is the one legitimate inline style: a
                                    // percentage computed from data. The width is
                                    // the PROPORTION represented visually — same
                                    // as ProgressBar's internal fill. Tailwind's
                                    // JIT can't emit arbitrary percentages, so an
                                    // inline style here is the canonical pattern.
                                    width: `${percent}%`,
                                    minWidth: item.value > 0 ? "4px" : "0",
                                }}
                            />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
