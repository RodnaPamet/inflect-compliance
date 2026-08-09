"use client";

/**
 * `<RiskMatrix>` — config-driven matrix engine for Epic 44.3.
 *
 * Replaces the legacy `<RiskHeatmap>`'s hardcoded 5×5 layout with an
 * NxN renderer that reads dimensions, axis labels, severity bands,
 * and per-level vocabulary from `RiskMatrixConfigShape`. All cell
 * painting + tooltips delegate to `<RiskMatrixCell>`; the legend
 * delegates to `<RiskMatrixLegend>`. Both primitives ship from the
 * same Epic 44 contract so the engine stays presentational —
 * arrangement only, no per-band logic of its own.
 *
 * ## Default-parity guarantee
 *
 * When the engine is fed `DEFAULT_RISK_MATRIX_CONFIG`, the rendered
 * grid matches the legacy `<RiskHeatmap>` cell-for-cell:
 *
 *   - rows = likelihood, descending top-to-bottom (5 → 1)
 *   - cols = impact, ascending left-to-right (1 → 5)
 *   - row + column header columns at 24 px / 20 px reservations
 *   - "Likelihood" Y-axis title (vertical-LR rotated) on the left
 *   - "Impact" X-axis title under the grid
 *   - Low / Medium / High / Critical legend chips below
 *
 * The structural ratchet `tests/rendered/risk-matrix-default-parity.test.tsx`
 * locks this so a future "tidy-up" can't drift the visual.
 *
 * ## NxN
 *
 * `likelihoodLevels × impactLevels` drive the row + column counts.
 * Cell placement uses the SEMANTIC `(likelihood, impact)` pair from
 * the data, never the rendered (row, col) — `cellLookup.get(`${l}-${i}`)`
 * works identically whether the matrix is 5×5, 4×6, or 7×7.
 *
 * ## Axis swap
 *
 * `swapAxes={false}` (default): rows = likelihood (y), cols = impact (x).
 * `swapAxes={true}`: rows = impact (y), cols = likelihood (x).
 *
 * The data shape doesn't change — `(likelihood, impact)` stays
 * semantic — only the rendered axis assignment flips. Useful when
 * the operator wants probability on X vs Y depending on convention.
 *
 * ## Bubble overlay
 *
 * `mode='count'` (default): each cell shows the numeric count.
 * `mode='bubble'`: each cell shows up to `bubbleLimit` scenario
 * titles inline with a "+N more" overflow. Tooltip carries the
 * full list either way.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeftRight } from 'lucide-react';
import { useLocalStorage } from '@/components/ui/hooks';

import {
    RiskMatrixCell,
    type CellRisk,
} from '@/components/risks/RiskMatrixCell';
import { RiskMatrixLegend } from '@/components/risks/RiskMatrixLegend';
import type { RiskMatrixConfigShape } from '@/lib/risk-matrix/types';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

// RQ3-OB-D — a deduped movement arrow names the risks that took its
// path, not just a count. The list is bounded (top N + "+M more") so
// a path shared by 40 risks doesn't produce an unreadable tooltip.
export const MOVEMENT_ARROW_TOOLTIP_MAX = 8;

/**
 * Compose the movement-arrow tooltip text from the per-path risk
 * titles. Pure + exported for unit coverage: top `max` titles joined,
 * then a "+N more" overflow tail. Empty list → empty string (the
 * caller skips the `<title>` when there's nothing to say).
 */
export function movementArrowTitle(
    titles: ReadonlyArray<string>,
    max: number = MOVEMENT_ARROW_TOOLTIP_MAX,
): string {
    if (titles.length === 0) return '';
    const shown = titles.slice(0, max);
    const overflow = titles.length - shown.length;
    const head = shown.join(', ');
    return overflow > 0 ? `${head} +${overflow} more` : head;
}

// ─── Public types ───────────────────────────────────────────────────

export interface RiskMatrixDataCell {
    /** 1-based likelihood (semantic axis). */
    likelihood: number;
    /** 1-based impact (semantic axis). */
    impact: number;
    /** Risk count at this (likelihood, impact). */
    count: number;
    /**
     * Optional per-risk metadata. Required for `mode='bubble'` to
     * render scenario chips; harmless to ship even in count mode.
     */
    risks?: ReadonlyArray<CellRisk>;
    /**
     * RQ2-5 — summed resolved ALE of this cell's risks. Enables the
     * ALE heat overlay toggle; omit (or 0) everywhere and the matrix
     * behaves exactly as before — the toggle never renders.
     */
    totalAle?: number;
    /**
     * RQ3-5 — when this cell's quantified ALEs differ by more than
     * the collision threshold (10×), the max/min ratio. The cell
     * renders the range-compression marker.
     */
    collisionRatio?: number;
}

/**
 * RQ2-9 — one inherent → residual movement. Only risks with a
 * DECOMPOSED residual (RQ2-1 dims) can draw an arrow; legacy
 * undecomposed rows have no destination cell and are excluded by
 * the caller.
 */
export interface RiskMovement {
    riskId: string;
    title: string;
    from: { likelihood: number; impact: number };
    to: { likelihood: number; impact: number };
}

export interface RiskMatrixProps {
    /** Effective config for this tenant. */
    config: RiskMatrixConfigShape;
    /** Sparse list of cells with risks. Cells absent from the list render as empty (count=0). */
    cells: ReadonlyArray<RiskMatrixDataCell>;
    /**
     * RQ2-9 — inherent → residual movements. Enables the movement
     * toggle; omit (or empty) and the matrix behaves exactly as
     * before — the toggle never renders.
     */
    movements?: ReadonlyArray<RiskMovement>;
    /** Render mode. Default: 'count'. */
    mode?: 'count' | 'bubble';
    /** Max risks per cell in bubble mode before "+N more". Default: 3. */
    bubbleLimit?: number;
    /**
     * When false (default), rows=likelihood / cols=impact. When true,
     * the axes flip: rows=impact / cols=likelihood. The DATA contract
     * is unchanged — only the rendered grid swaps axes.
     */
    swapAxes?: boolean;
    /** Show the built-in axis-swap toggle in the header. Default: true. */
    showSwapToggle?: boolean;
    /** Show the title + count chrome above the grid. Default: true. */
    showHeader?: boolean;
    /** Header title. Default: "Risk Matrix". */
    title?: string;
    /** Click handler — invoked with the underlying (semantic) cell. */
    onCellClick?: (cell: RiskMatrixDataCell) => void;
    /** Optional id of the currently-selected cell, in the form `${L}-${I}`. */
    selectedKey?: string | null;
    /**
     * polish #13 — when present, the ALE and Movement toggle states
     * persist to localStorage under `${storageKey}:overlay`. Pass a
     * per-tenant key (e.g. `inflect:risk-matrix:${tenantSlug}`) so
     * one operator's preferences don't leak across tenants. Omit and
     * the toggles stay session-local (the pre-polish behaviour).
     */
    storageKey?: string;
    className?: string;
    id?: string;
    /** Test id forwarded to the outer card. */
    'data-testid'?: string;
}

// ─── Engine ─────────────────────────────────────────────────────────

export function RiskMatrix({
    config,
    cells,
    movements,
    mode = 'count',
    bubbleLimit = 3,
    swapAxes: swapAxesProp,
    showSwapToggle = true,
    showHeader = true,
    title: titleProp,
    onCellClick,
    selectedKey = null,
    storageKey,
    className = '',
    id,
    'data-testid': dataTestId = 'risk-matrix',
}: RiskMatrixProps) {
    const t = useTranslations('common.chart');
    const title = titleProp ?? t('riskMatrix');
    // The toggle is internal-state-by-default but accepts an external
    // override via `swapAxesProp` so a parent (e.g. a saved view) can
    // pin the value without us flickering on first render.
    const [internalSwap, setInternalSwap] = useState(false);
    const swapAxes = swapAxesProp ?? internalSwap;

    // RQ2-5 — ALE heat overlay. The toggle only exists when at least
    // one cell carries monetary data: an unquantified portfolio pays
    // zero cost and sees zero new chrome.
    // polish #13 — overlay toggles persist when a storageKey is
    // supplied; session-local otherwise. Falls back to useState on
    // SSR via the hook's initialValue contract.
    /* eslint-disable react-hooks/rules-of-hooks -- the storageKey is
       stable for the lifetime of the component (it's a render-prop
       string), so the conditional hook call is safe by construction. */
    const [aleOverlay, setAleOverlay] = storageKey
        ? useLocalStorage<boolean>(`${storageKey}:overlay:ale`, false)
        : useState(false);
    const maxCellAle = useMemo(
        () => cells.reduce((m, c) => Math.max(m, c.totalAle ?? 0), 0),
        [cells],
    );
    const hasAleData = maxCellAle > 0;
    const aleOverlayActive = aleOverlay && hasAleData;

    // RQ2-9 — movement overlay. Zero-cost without movement data.
    const [showMovement, setShowMovement] = storageKey
        ? useLocalStorage<boolean>(`${storageKey}:overlay:movement`, false)
        : useState(false);
    /* eslint-enable react-hooks/rules-of-hooks */
    const hasMovements = (movements?.length ?? 0) > 0;
    const movementActive = showMovement && hasMovements;
    // Deduplicate identical (from → to) pairs into one arrow with a
    // count — ten risks taking the same path is one fat arrow, not
    // ten overdrawn ones. Same-cell pairs (no movement) are skipped.
    const movementArrows = useMemo(() => {
        if (!movements) return [];
        // RQ3-OB-D — retain the per-path risk TITLES, not just the
        // count. The deduped arrow used to collapse "three risks
        // moved" to a bare ×3; the tooltip now names which three.
        const byPath = new Map<string, { from: { likelihood: number; impact: number }; to: { likelihood: number; impact: number }; count: number; titles: string[] }>();
        for (const m of movements) {
            if (m.from.likelihood === m.to.likelihood && m.from.impact === m.to.impact) continue;
            const key = `${m.from.likelihood}-${m.from.impact}>${m.to.likelihood}-${m.to.impact}`;
            const cur = byPath.get(key);
            if (cur) {
                cur.count += 1;
                cur.titles.push(m.title);
            } else {
                byPath.set(key, { from: m.from, to: m.to, count: 1, titles: [m.title] });
            }
        }
        return Array.from(byPath.values());
    }, [movements]);

    const lookup = useMemo(() => {
        const m = new Map<string, RiskMatrixDataCell>();
        for (const cell of cells) {
            m.set(`${cell.likelihood}-${cell.impact}`, cell);
        }
        return m;
    }, [cells]);

    const totalRisks = cells.reduce((s, c) => s + c.count, 0);

    // ── Rendered axes ───────────────────────────────────────────────
    //
    // In default orientation: rows = likelihood (top → bottom = max
    // → 1 — high likelihood at the top, the legacy heatmap shape),
    // cols = impact (left → right = 1 → max).
    //
    // Swapped: rows = impact (top → bottom = max → 1, "high impact
    // at the top" so visually-severe still reads up), cols =
    // likelihood (left → right = 1 → max).
    const yLevels = swapAxes ? config.impactLevels : config.likelihoodLevels;
    const xLevels = swapAxes ? config.likelihoodLevels : config.impactLevels;
    const yAxisLabel = swapAxes ? config.axisImpactLabel : config.axisLikelihoodLabel;
    const xAxisLabel = swapAxes ? config.axisLikelihoodLabel : config.axisImpactLabel;
    const yLabels = swapAxes
        ? config.levelLabels.impact
        : config.levelLabels.likelihood;
    const xLabels = swapAxes
        ? config.levelLabels.likelihood
        : config.levelLabels.impact;

    // Top → bottom: max → 1 (high severity / likelihood at the top,
    // matching the legacy heatmap's visual convention).
    const rows = useMemo(
        () => Array.from({ length: yLevels }, (_, i) => yLevels - i),
        [yLevels],
    );
    const cols = useMemo(
        () => Array.from({ length: xLevels }, (_, i) => i + 1),
        [xLevels],
    );

    // Resolve a SEMANTIC cell from a (rendered-row, rendered-col) pair.
    const cellAt = (yIdx: number, xIdx: number): RiskMatrixDataCell => {
        const likelihood = swapAxes ? xIdx : yIdx;
        const impact = swapAxes ? yIdx : xIdx;
        return (
            lookup.get(`${likelihood}-${impact}`) ?? {
                likelihood,
                impact,
                count: 0,
            }
        );
    };

    // RQ3-OB-E — grid keyboard navigation.
    //
    // The matrix advertises `role="grid"`, which contracts arrow-key
    // navigation across cells. Roving tabindex: exactly ONE cell is
    // in the tab order at any time (`focusedKey`); arrow keys move
    // it. Default tab-stop is the top-left rendered cell so a fresh
    // Tab into the grid lands somewhere predictable.
    //
    // Roving tabindex only engages when the grid is INTERACTIVE
    // (`onCellClick` is wired). For a read-only matrix every cell
    // already sits on `tabIndex=-1` so this state is a no-op.
    const interactive = Boolean(onCellClick);
    const defaultKey = `${cellAt(rows[0], cols[0]).likelihood}-${cellAt(rows[0], cols[0]).impact}`;
    const [focusedKey, setFocusedKey] = useState<string | null>(null);
    const gridRef = useRef<HTMLDivElement | null>(null);
    const effectiveFocusedKey = focusedKey ?? defaultKey;

    const handleArrowKey = useCallback(
        (yIdx: number, xIdx: number, key: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End') => {
            // Compute next rendered (y, x). Clamp at edges — wrap-
            // around in a grid that conveys position (likelihood ×
            // impact is geographic, not a list) would confuse the
            // mental model. Home / End jump to the row's edges.
            let nextY = yIdx;
            let nextX = xIdx;
            if (key === 'ArrowUp') nextY = Math.max(0, yIdx - 1);
            else if (key === 'ArrowDown') nextY = Math.min(yLevels - 1, yIdx + 1);
            else if (key === 'ArrowLeft') nextX = Math.max(0, xIdx - 1);
            else if (key === 'ArrowRight') nextX = Math.min(xLevels - 1, xIdx + 1);
            else if (key === 'Home') nextX = 0;
            else if (key === 'End') nextX = xLevels - 1;
            const nextRow = rows[nextY];
            const nextCol = cols[nextX];
            const nextCell = cellAt(nextRow, nextCol);
            const nextKey = `${nextCell.likelihood}-${nextCell.impact}`;
            if (nextKey === effectiveFocusedKey) return;
            setFocusedKey(nextKey);
            // Imperatively focus the new cell DOM node. tabIndex
            // updates in React's render cycle, so we focus after
            // the commit via the gridRef + the cell's data-testid.
            requestAnimationFrame(() => {
                const next = gridRef.current?.querySelector<HTMLDivElement>(
                    `[data-testid="risk-matrix-cell-${nextCell.likelihood}-${nextCell.impact}"]`,
                );
                next?.focus();
            });
        },
        [rows, cols, yLevels, xLevels, effectiveFocusedKey],
    );

    return (
        <div
            id={id}
            data-testid={dataTestId}
            data-swap-axes={swapAxes ? 'true' : 'false'}
            data-mode={mode}
            data-ale-overlay={aleOverlayActive ? 'true' : 'false'}
            data-movement={movementActive ? 'true' : 'false'}
            className={cn(cardVariants(), className)}
        >
            {showHeader && (
                <div className="mb-3 flex items-center justify-between">
                    <Heading level={3}>
                        {title}
                    </Heading>
                    <div className="flex items-center gap-compact">
                        {hasMovements && (
                            <button
                                type="button"
                                onClick={() => setShowMovement((p) => !p)}
                                aria-pressed={showMovement}
                                className={cn(
                                    'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] transition-colors',
                                    showMovement
                                        ? 'border-border-emphasis text-content-emphasis'
                                        : 'border-border-subtle text-content-muted hover:border-border-emphasis hover:text-content-emphasis',
                                )}
                                aria-label={t('movementAria')}
                                data-testid="risk-matrix-movement-toggle"
                            >
                                → {t('movement')}
                            </button>
                        )}
                        {hasAleData && (
                            <button
                                type="button"
                                onClick={() => setAleOverlay((p) => !p)}
                                aria-pressed={aleOverlay}
                                className={cn(
                                    'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] transition-colors',
                                    aleOverlay
                                        ? 'border-border-emphasis text-content-emphasis'
                                        : 'border-border-subtle text-content-muted hover:border-border-emphasis hover:text-content-emphasis',
                                )}
                                aria-label={t('aleHeatAria')}
                                data-testid="risk-matrix-ale-toggle"
                            >
                                {t('aleHeat')}
                            </button>
                        )}
                        {showSwapToggle && swapAxesProp === undefined && (
                            <button
                                type="button"
                                onClick={() => setInternalSwap((p) => !p)}
                                className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2 py-0.5 text-[10px] text-content-muted transition-colors hover:border-border-emphasis hover:text-content-emphasis"
                                aria-label={t('swapAxesAria')}
                                data-testid="risk-matrix-swap"
                            >
                                <ArrowLeftRight size={12} />
                                {t('swapAxes')}
                            </button>
                        )}
                        <span className="text-xs text-content-subtle tabular-nums">
                            {totalRisks} {t(totalRisks === 1 ? 'riskOne' : 'riskOther')}
                        </span>
                    </div>
                </div>
            )}

            <div className="flex gap-tight">
                {/* Y-axis title (vertical-LR rotation matches the legacy heatmap). */}
                <div className="-mr-1 flex flex-col items-center justify-center">
                    <span className="rotate-180 text-[10px] uppercase tracking-widest text-content-subtle [writing-mode:vertical-lr]">
                        {yAxisLabel}
                    </span>
                </div>

                <div className="flex-1">
                    {/* Grid — header column (24px) + N data columns;
                        data rows + footer row (20px). Each `[role=row]`
                        wrapper uses `display: contents` so the CSS Grid
                        layout still treats the row's children as direct
                        grid items, while ARIA gets the
                        `grid → row → {rowheader,gridcell,columnheader}`
                        hierarchy axe-AA's `aria-required-children`
                        rule expects. */}
                    <div
                        ref={gridRef}
                        role="grid"
                        aria-label={t('matrixAria', { y: yAxisLabel, x: xAxisLabel })}
                        data-testid="risk-matrix-grid"
                        className="relative grid gap-[3px]"
                        style={{
                            gridTemplateColumns: `24px repeat(${xLevels}, 1fr)`,
                            gridTemplateRows: `repeat(${yLevels}, 1fr) 20px`,
                        }}
                    >
                        {rows.map((rowVal, yIdx) => (
                            <div
                                key={`row-${rowVal}`}
                                role="row"
                                style={{ display: 'contents' }}
                            >
                                {/* Row label (numeric). */}
                                <div
                                    role="rowheader"
                                    className="flex items-center justify-center text-[10px] tabular-nums text-content-subtle"
                                    title={
                                        yLabels[rowVal - 1] ?? String(rowVal)
                                    }
                                    data-testid={`risk-matrix-row-label-${rowVal}`}
                                >
                                    {rowVal}
                                </div>
                                {cols.map((colVal, xIdx) => {
                                    // yIdx tells us which rendered row;
                                    // we resolve the semantic cell from
                                    // (rowVal, colVal) under the
                                    // current swap state.
                                    const cell = cellAt(rowVal, colVal);
                                    const cellKey = `${cell.likelihood}-${cell.impact}`;
                                    return (
                                        <RiskMatrixCell
                                            key={cellKey}
                                            likelihood={cell.likelihood}
                                            impact={cell.impact}
                                            count={cell.count}
                                            risks={cell.risks}
                                            mode={mode}
                                            bubbleLimit={bubbleLimit}
                                            config={config}
                                            // RQ3-OB-E — roving tabindex + arrow
                                            // routing. Only the focused cell is
                                            // tabbable; arrows steer.
                                            tabbable={interactive && cellKey === effectiveFocusedKey}
                                            onArrowKey={
                                                interactive
                                                    ? (k) => handleArrowKey(yIdx, xIdx, k)
                                                    : undefined
                                            }
                                            aleOverlay={aleOverlayActive}
                                            totalAle={cell.totalAle}
                                            collisionRatio={cell.collisionRatio}
                                            aleShare={
                                                aleOverlayActive && maxCellAle > 0
                                                    ? (cell.totalAle ?? 0) / maxCellAle
                                                    : undefined
                                            }
                                            selected={selectedKey === cellKey}
                                            onClick={
                                                onCellClick
                                                    ? () => onCellClick(cell)
                                                    : undefined
                                            }
                                        />
                                    );
                                })}
                            </div>
                        ))}

                        {/* RQ2-9 — movement overlay. Absolutely
                            positioned over the data-cell area only
                            (header column + footer row excluded), so
                            percentage coordinates in the NxN space
                            map 1:1 onto cell centres. Decorative —
                            the per-risk story lives in the
                            assessment tab; aria summarises. */}
                        {movementActive && (
                            <svg
                                viewBox="0 0 100 100"
                                preserveAspectRatio="none"
                                role="img"
                                aria-label={t('movementOverlayAria', {
                                    count: movementArrows.reduce((sum, a) => sum + a.count, 0),
                                })}
                                data-testid="risk-matrix-movement-overlay"
                                className="pointer-events-none"
                                style={{
                                    position: 'absolute',
                                    left: 27,
                                    top: 0,
                                    right: 0,
                                    bottom: 23,
                                    width: 'calc(100% - 27px)',
                                    height: 'calc(100% - 23px)',
                                }}
                            >
                                {movementArrows.map((a) => {
                                    const px = (p: { likelihood: number; impact: number }) => {
                                        const xVal = swapAxes ? p.likelihood : p.impact;
                                        const yVal = swapAxes ? p.impact : p.likelihood;
                                        return {
                                            x: ((xVal - 0.5) / xLevels) * 100,
                                            y: ((yLevels - yVal + 0.5) / yLevels) * 100,
                                        };
                                    };
                                    const from = px(a.from);
                                    const to = px(a.to);
                                    const key = `${a.from.likelihood}-${a.from.impact}>${a.to.likelihood}-${a.to.impact}`;
                                    // RQ3-OB-D — the arrow names its risks on hover.
                                    // The overlay SVG is pointer-events-none (so it
                                    // never blocks cell clicks); this single arrow
                                    // group opts back IN so the native <title> fires.
                                    const tooltip = movementArrowTitle(a.titles);
                                    return (
                                        <g
                                            key={key}
                                            data-testid="risk-matrix-movement-arrow"
                                            data-count={a.count}
                                            style={{ pointerEvents: 'auto' }}
                                        >
                                            <title>{tooltip}</title>
                                            {/* Transparent wide hit-line — the visible
                                                stroke is too thin to hover reliably. */}
                                            <line
                                                x1={from.x}
                                                y1={from.y}
                                                x2={to.x}
                                                y2={to.y}
                                                stroke="transparent"
                                                strokeWidth={4}
                                            />
                                            <line
                                                x1={from.x}
                                                y1={from.y}
                                                x2={to.x}
                                                y2={to.y}
                                                stroke="var(--content-emphasis, #0f172a)"
                                                strokeWidth={a.count > 1 ? 1.2 : 0.7}
                                                strokeOpacity={0.75}
                                            />
                                            {/* origin ring + destination dot — the
                                                pair reads direction without an
                                                aspect-distorted arrowhead. */}
                                            <circle cx={from.x} cy={from.y} r={1.6} fill="none" stroke="var(--content-emphasis, #0f172a)" strokeWidth={0.5} strokeOpacity={0.75} />
                                            <circle cx={to.x} cy={to.y} r={1.6} fill="var(--content-emphasis, #0f172a)" fillOpacity={0.9} />
                                            {a.count > 1 && (
                                                <text
                                                    x={(from.x + to.x) / 2}
                                                    y={(from.y + to.y) / 2 - 1.5}
                                                    fontSize={4}
                                                    textAnchor="middle"
                                                    fill="var(--content-emphasis, #0f172a)"
                                                >
                                                    ×{a.count}
                                                </text>
                                            )}
                                        </g>
                                    );
                                })}
                            </svg>
                        )}

                        {/* X-axis numeric labels (footer row). */}
                        <div role="row" style={{ display: 'contents' }}>
                            <div /> {/* spacer for the row-label column */}
                            {cols.map((colVal) => (
                                <div
                                    key={`col-${colVal}`}
                                    role="columnheader"
                                    className="flex items-center justify-center text-[10px] tabular-nums text-content-subtle"
                                    title={xLabels[colVal - 1] ?? String(colVal)}
                                    data-testid={`risk-matrix-col-label-${colVal}`}
                                >
                                    {colVal}
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="mt-1 text-center">
                        <span className="text-[10px] uppercase tracking-widest text-content-subtle">
                            {xAxisLabel}
                        </span>
                    </div>
                </div>
            </div>

            {/* polish #2 — movement legend. Only renders alongside
                the overlay so an off-toggle matrix stays uncluttered. */}
            {movementActive && (
                <div
                    className="mt-3 flex flex-wrap items-center gap-default text-[10px] text-content-muted"
                    data-testid="risk-matrix-movement-legend"
                >
                    <span className="inline-flex items-center gap-1">
                        <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full border border-content-emphasis bg-transparent" />
                        {t('inherentOrigin')}
                    </span>
                    <span className="inline-flex items-center gap-1">
                        <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-content-emphasis" />
                        {t('residualDestination')}
                    </span>
                    <span>·</span>
                    <span>{t('movementLegendHint')}</span>
                </div>
            )}

            <div className="mt-3">
                <RiskMatrixLegend config={config} />
            </div>
        </div>
    );
}
