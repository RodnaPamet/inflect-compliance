"use client";

/**
 * `<RiskMatrixCell>` — single cell of the tenant-scoped risk matrix.
 *
 * Epic 44.2 primitive. Replaces the inline JSX block the legacy
 * `<RiskHeatmap>` rendered per `(likelihood, impact)` pair. Now:
 *
 *   - **Config-driven**: colour + band name + per-level labels all
 *     resolve from `RiskMatrixConfigShape`. Same shape powers a 5×5
 *     today and a 4×6 (or 7×7) tomorrow without a renderer change.
 *   - **Tooltip-aware**: hover/focus surfaces the score, band name,
 *     count, and (when supplied) a description line. Tooltip uses
 *     the existing Inflect primitive so it lives inside the app's
 *     `TooltipProvider` tree — pages already mount one in the root
 *     layout; tests wrap explicitly.
 *   - **Accessible**: `role="gridcell"` + `aria-label` carry the
 *     full "Likelihood Major × Impact Severe = 20 (Critical) — 3
 *     risks" sentence to screen readers. Keyboard activation goes
 *     through the cell's focusable wrapper when an `onClick` is
 *     supplied.
 *   - **Empty-state aware**: zero-count cells render with a subtle
 *     background instead of the band colour, so the matrix's
 *     positive density reads at a glance.
 *
 * What this is NOT:
 *   - The whole matrix. The grid layout, axis titles, and row/column
 *     headers live in a future `<RiskMatrix>` shell (a later prompt
 *     in this PR). The cell is a pure leaf — drop it into any
 *     `display: grid` parent.
 *   - A drill-down panel. `onClick` is a callback the consumer
 *     wires; the cell only paints the trigger.
 */

import { useMemo } from 'react';

import { Tooltip } from '@/components/ui/tooltip';
import {
    resolveCell,
    bandRangeLabel,
} from '@/lib/risk-matrix/scoring';
import { formatCompactCurrency } from '@/lib/risk-coherence';
import { pluralize } from '@/lib/pluralize';
import type { RiskMatrixConfigShape } from '@/lib/risk-matrix/types';

// ─── Props ──────────────────────────────────────────────────────────

export interface CellRisk {
    /** Stable id (e.g. `risk_…`). */
    id: string;
    /** Display title (truncated in bubble mode if needed). */
    title: string;
}

export interface RiskMatrixCellProps {
    /** Likelihood index (1-based, ≤ config.likelihoodLevels). */
    likelihood: number;
    /** Impact index (1-based, ≤ config.impactLevels). */
    impact: number;
    /** Number of risks at this (likelihood, impact). 0 renders the empty-state cell. */
    count: number;
    /** Effective config the matrix is rendering against. */
    config: RiskMatrixConfigShape;
    /**
     * Render mode.
     *   - `count`  — classic heatmap: just the numeric tally.
     *   - `bubble` — show up to `bubbleLimit` scenario titles inside
     *     the cell with a "+N more" overflow chip when the cell
     *     holds more risks than will fit. The tooltip carries the
     *     full list either way.
     * Default: `count`.
     */
    mode?: 'count' | 'bubble';
    /** Per-risk data — only consumed in bubble mode. */
    risks?: ReadonlyArray<CellRisk>;
    /** Maximum chips rendered in bubble mode before "+N more". Default 3. */
    bubbleLimit?: number;
    /**
     * Optional human description shown in the tooltip after the
     * score line. Useful when each band has a runbook hint or when
     * a domain (e.g. clinical) attaches per-cell narrative.
     */
    description?: string;
    /** Optional click handler — drill into the cell's risk list. */
    onClick?: () => void;
    /** Visual emphasis when this is the active cell. */
    selected?: boolean;
    /**
     * RQ2-5 — ALE heat overlay. When enabled the cell's paint
     * intensity tracks `aleShare` (this cell's summed ALE as a
     * fraction of the largest cell's), so the matrix reads monetary
     * concentration instead of just counts. `totalAle` renders as a
     * compact € line under the count and joins the tooltip.
     */
    aleOverlay?: boolean;
    /** Summed ALE of this cell's risks (currency). */
    totalAle?: number;
    /** This cell's ALE ÷ the max cell ALE (0..1). */
    aleShare?: number;
    /**
     * RQ3-5 — same-cell ALEs differ by this ratio (>10× threshold).
     * Renders the range-compression marker: the matrix structurally
     * compresses these risks into one cell; the marker says so.
     */
    collisionRatio?: number;
    /** Stable DOM id (E2E hook). */
    id?: string;
    /** Test id forwarded to the cell wrapper. */
    'data-testid'?: string;
    /** Override class merged onto the cell's box. */
    className?: string;
    /**
     * RQ3-OB-E — roving tabindex. The matrix grid keeps exactly ONE
     * cell tabbable at any time; the others sit on `-1` so the user
     * Tabs INTO the grid once, then steers with arrow keys. The
     * matrix owns the focused-cell state; the cell just reflects it.
     * Defaults to `true` so the legacy single-cell use case (no
     * arrow nav) keeps its existing tab-stop.
     */
    tabbable?: boolean;
    /**
     * RQ3-OB-E — emitted on arrow-key press (Up/Down/Left/Right) +
     * Home/End. The matrix translates the direction into a focus
     * move on the next gridcell, wrapping at the edges OR clamping
     * (the matrix decides — the cell stays direction-agnostic).
     */
    onArrowKey?: (
        key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
    ) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Pick a foreground colour for the chip (white vs near-black) given
 * the band's hex background. Uses the W3C-recommended luminance
 * formula so a hex from any consumer (admin UI, defaults, theme) gets
 * a contrasting count label without per-band configuration.
 */
function readableTextOnHex(hex: string): string {
    if (!hex || hex[0] !== '#') return 'rgb(15, 23, 42)';
    let h = hex.slice(1);
    if (h.length === 3) {
        h = h
            .split('')
            .map((c) => c + c)
            .join('');
    }
    if (h.length !== 6) return 'rgb(15, 23, 42)';
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    // Relative luminance per WCAG. Threshold 0.55 picks white earlier
    // than the strict 0.179 contrast cutoff because tabular numerics
    // on a coloured chip read better with bias toward white text.
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.55 ? 'rgb(15, 23, 42)' : 'rgb(255, 255, 255)';
}

// RQ3-OB-A — pluralization moved to the shared helper.

// ─── Component ──────────────────────────────────────────────────────

export function RiskMatrixCell({
    likelihood,
    impact,
    count,
    config,
    mode = 'count',
    risks,
    bubbleLimit = 3,
    description,
    onClick,
    selected = false,
    aleOverlay = false,
    totalAle,
    aleShare,
    collisionRatio,
    id,
    'data-testid': dataTestId,
    className = '',
    tabbable = true,
    onArrowKey,
}: RiskMatrixCellProps) {
    const resolved = useMemo(
        () => resolveCell(likelihood, impact, config),
        [likelihood, impact, config],
    );
    const { score, band, likelihoodLabel, impactLabel } = resolved;
    const isEmpty = count <= 0;

    const hasAle = typeof totalAle === 'number' && totalAle > 0;
    const hasCollision = typeof collisionRatio === 'number' && collisionRatio > 1;
    const ariaLabel =
        `${config.axisLikelihoodLabel} ${likelihoodLabel} × ` +
        `${config.axisImpactLabel} ${impactLabel} = ${score} (${band.name})` +
        ` — ${count} ${pluralize(count, 'risk')}` +
        (aleOverlay && hasAle
            ? ` — annualised loss expectancy ${formatCompactCurrency(totalAle)}`
            : '') +
        (hasCollision
            ? ` — warning: same-cell loss estimates differ ~${Math.round(collisionRatio)}×`
            : '');

    const tooltipContent = (
        <div className="space-y-0.5 text-xs">
            <p className="font-semibold">
                {likelihoodLabel} × {impactLabel} = {score}
            </p>
            <p className="text-content-muted">
                {band.name} ({bandRangeLabel(band)})
            </p>
            <p className="text-content-default">
                {count} {pluralize(count, 'risk')}
            </p>
            {hasAle && (
                <p className="text-content-default">
                    ALE {formatCompactCurrency(totalAle)}
                </p>
            )}
            {hasCollision && (
                <p className="text-content-warning">
                    ALEs in this cell differ ~{Math.round(collisionRatio)}× — the
                    matrix compresses them into one box; check the histogram view.
                </p>
            )}
            {description && (
                <p className="pt-1 text-content-muted">{description}</p>
            )}
            {mode === 'bubble' && risks && risks.length > 0 && (
                <ul className="mt-1 space-y-0.5 border-t border-border-subtle pt-1 text-content-muted">
                    {risks.slice(0, 8).map((r) => (
                        <li key={r.id} className="truncate">
                            • {r.title}
                        </li>
                    ))}
                    {risks.length > 8 && (
                        <li className="text-content-subtle">
                            … + {risks.length - 8} more
                        </li>
                    )}
                </ul>
            )}
        </div>
    );

    const interactive = Boolean(onClick) && !isEmpty;
    const fg = readableTextOnHex(band.color);

    const cell = (
        <div
            id={id}
            role="gridcell"
            // RQ3-OB-E — roving tabindex. The grid keeps exactly one
            // tabbable cell at a time when arrow-key nav is wired; the
            // others stay at `-1` until they become the active cell.
            // Non-interactive cells stay at `-1` regardless (a focused
            // empty cell with no callbacks would be a dead-end stop).
            tabIndex={interactive ? (tabbable ? 0 : -1) : -1}
            aria-label={ariaLabel}
            data-testid={dataTestId ?? `risk-matrix-cell-${likelihood}-${impact}`}
            data-empty={isEmpty ? 'true' : 'false'}
            data-selected={selected ? 'true' : 'false'}
            data-band={band.name}
            data-score={score}
            data-count={count}
            data-ale={aleOverlay && hasAle ? Math.round(totalAle) : undefined}
            data-collision-ratio={hasCollision ? Math.round(collisionRatio) : undefined}
            onClick={interactive ? onClick : undefined}
            onKeyDown={
                interactive
                    ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onClick?.();
                              return;
                          }
                          // RQ3-OB-E — arrow / Home / End route to the
                          // matrix so it can steer focus across cells.
                          // preventDefault stops page-scroll on arrow
                          // press; the matrix handles wrap/clamp.
                          if (
                              onArrowKey &&
                              (e.key === 'ArrowUp' ||
                                  e.key === 'ArrowDown' ||
                                  e.key === 'ArrowLeft' ||
                                  e.key === 'ArrowRight' ||
                                  e.key === 'Home' ||
                                  e.key === 'End')
                          ) {
                              e.preventDefault();
                              onArrowKey(e.key);
                          }
                      }
                    : undefined
            }
            className={[
                // RQ3-OB-E — motion-reduce:transition-none collapses
                // the color crossfade when the user opts out. The
                // global token override (--duration-fast → 1ms) only
                // catches utilities that READ the var; a literal
                // `duration-150` does not, so this is the belt to the
                // global rule's braces.
                'group relative flex min-h-[28px] items-center justify-center rounded-sm text-xs font-semibold tabular-nums transition-colors duration-150 ease-out motion-reduce:transition-none',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-default)] focus-visible:ring-offset-1',
                interactive ? 'cursor-pointer hover:brightness-110' : 'cursor-default',
                selected ? 'ring-2 ring-[var(--brand-default)] ring-offset-1' : '',
                // R18 visible-uplift — gloss sheen on the filled
                // heatmap cells. R18's gloss primitive is SVG-only;
                // RiskMatrixCell is an HTML div, so it gets the same
                // white→transparent ramp as the ProgressCard track,
                // here as a `::before` (paints over the `band.color`
                // fill, UNDER the count span — the count's own
                // `absolute inset-0` span renders after the pseudo).
                // `rounded-sm` to track the cell, `pointer-events-
                // none` so it never eats a click. Filled cells only —
                // empty cells stay the flat `bg-bg-subtle` fallback.
                !isEmpty
                    ? "before:content-[''] before:absolute before:inset-0 before:rounded-sm before:pointer-events-none before:bg-[linear-gradient(180deg,rgba(255,255,255,0.22)_0%,rgba(255,255,255,0.04)_50%,transparent_100%)]"
                    : '',
                className,
            ]
                .filter(Boolean)
                .join(' ')}
            style={
                isEmpty
                    ? undefined
                    : {
                          // Direct hex from `band.color` (RiskMatrixConfig)
                          // — Epic 44 deliberately moves away from the
                          // legacy `bg-bg-success` Tailwind dark-with-
                          // 50%-opacity classes the pre-config heatmap
                          // used. The new colours are brighter at high
                          // opacity (default Low/Medium/High/Critical
                          // hexes are #22c55e / #f59e0b / #ef4444 /
                          // #7c2d12). Tenants can re-skin via the admin
                          // editor; no dark-mode coupling required.
                          backgroundColor: band.color,
                          color: fg,
                          // RQ2-5 — in ALE-overlay mode the paint
                          // intensity tracks monetary concentration:
                          // the heaviest cell stays fully saturated,
                          // unquantified cells fade. Count mode keeps
                          // the classic flat 0.92.
                          opacity: aleOverlay
                              ? 0.2 + 0.72 * Math.min(Math.max(aleShare ?? 0, 0), 1)
                              : 0.92,
                      }
            }
        >
            {/* Empty cells use the page's subtle bg via the class
                fallback; the inline `style` block stays absent so
                Tailwind's tokens apply. */}
            <span
                className={isEmpty ? 'block h-full w-full rounded-sm bg-bg-subtle' : ''}
                aria-hidden={isEmpty}
            />
            {!isEmpty && mode === 'count' && (
                <span className="absolute inset-0 flex flex-col items-center justify-center leading-tight">
                    {count}
                    {aleOverlay && hasAle && (
                        <span
                            className="text-[9px] font-medium"
                            data-testid="risk-matrix-cell-ale"
                        >
                            {formatCompactCurrency(totalAle)}
                        </span>
                    )}
                </span>
            )}
            {/* RQ3-5 — range-compression marker. Decorative (the
                aria-label + tooltip carry the words). */}
            {!isEmpty && hasCollision && (
                <span
                    aria-hidden="true"
                    data-testid="risk-matrix-cell-collision"
                    className="absolute right-0.5 top-0.5 rounded-sm bg-bg-default/80 px-0.5 text-[9px] font-bold leading-none text-content-error"
                >
                    ≠
                </span>
            )}
            {!isEmpty && mode === 'bubble' && (
                <BubbleOverlay
                    risks={risks ?? []}
                    count={count}
                    limit={bubbleLimit}
                    fg={fg}
                />
            )}
        </div>
    );

    return <Tooltip content={tooltipContent}>{cell}</Tooltip>;
}

// ─── Bubble overlay ─────────────────────────────────────────────────
//
// A cell holding ONE risk shows that risk's (truncated) title inline —
// a scannable hint. A cell holding TWO OR MORE risks collapses to a
// "N Risks identified" count summary: stacking multiple truncated
// titles inside the ~28px cell overlapped and clipped them (the broken
// box this replaces). Either way the full list of names lives in the
// hover/focus tooltip that `<RiskMatrixCell>` renders.

function BubbleOverlay({
    risks,
    count,
    limit,
    fg,
}: {
    risks: ReadonlyArray<CellRisk>;
    count: number;
    limit: number;
    fg: string;
}) {
    // `count` is authoritative; `risks.length` guards the (pathological)
    // case where the two disagree so we never cram a multi-risk cell.
    const total = Math.max(count, risks.length);

    if (total > 1) {
        return (
            <span
                className="absolute inset-0 flex items-center justify-center px-0.5 text-center text-[10px] font-semibold leading-tight"
                style={{ color: fg }}
                data-testid="risk-matrix-cell-count-summary"
            >
                {total} {pluralize(total, 'Risk')} identified
            </span>
        );
    }

    // Defensive: when only `count` is supplied (no per-risk data),
    // fall back to the count number. This keeps the overlay honest
    // when the data layer hasn't been migrated to ship risks per cell.
    if (risks.length === 0 && count > 0) {
        return (
            <span
                className="absolute inset-0 flex items-center justify-center text-xs font-semibold"
                style={{ color: fg }}
            >
                {count}
            </span>
        );
    }

    // Exactly one risk with data — show its title inline.
    const visible = risks.slice(0, limit);
    return (
        <div
            className="absolute inset-0 flex flex-col items-stretch justify-center gap-[2px] overflow-hidden p-1"
            data-testid="risk-matrix-cell-bubbles"
        >
            {visible.map((r) => (
                <span
                    key={r.id}
                    className="truncate rounded-sm bg-white/15 px-1 py-[1px] text-[9px] font-medium leading-tight"
                    style={{ color: fg }}
                    title={r.title}
                >
                    {r.title}
                </span>
            ))}
        </div>
    );
}
