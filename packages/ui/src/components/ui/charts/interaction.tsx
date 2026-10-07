'use client';

/**
 * Epic 59 — shared chart interaction primitives.
 *
 * This file is the single place every Inflect chart surface reaches
 * for when it needs hover / focus / tooltip machinery beyond the
 * visx primitives `use-tooltip.ts` already wraps. It stays UI-pure
 * and token-backed so any chart — dashboard KPI spark, reporting
 * TimeSeriesChart, future audit funnel — renders a consistent
 * tooltip and respects the same keyboard contract.
 *
 * Exports:
 *
 *   - `useChartHover()` — subscribes to `ChartTooltipSync` and
 *     surfaces the currently-hovered `{ date, index, datum }` so a
 *     non-chart widget (KPI summary, activity pill) can echo the
 *     hover state without knowing about visx internals.
 *
 *   - `useChartKeyboardNavigation()` — returns an `onKeyDown`
 *     handler plus `{ focusedIndex, setFocusedIndex }`. Binds to
 *     any focusable element wrapping a chart; arrow keys step
 *     through data points, Home / End jump to the endpoints, and
 *     Escape clears the selection. Integrates with the shared
 *     `ChartTooltipSync` so the rest of the dashboard echoes the
 *     navigation focus, not just the pointer.
 *
 *   - `<ChartTooltipContainer>` — token-backed surface matching the
 *     Epic 56 Tooltip palette. Wraps tooltip content so every
 *     chart's tooltip feels like part of the same system.
 *
 *   - `<ChartTooltipRow>` — labelled key / value row with an
 *     optional colour swatch. Renders the per-series breakdown
 *     inside a tooltip container.
 */

import { cn } from '@inflect/ui/lib/cn';
import {
    useCallback,
    useContext,
    useMemo,
    useState,
    type KeyboardEvent,
    type ReactNode,
} from 'react';

import { ChartTooltipSyncContext } from './tooltip-sync';
import type {
    Data,
    Datum,
    TimeSeriesDatum,
} from './types';

// ─── useChartHover ────────────────────────────────────────────────────

export interface ChartHoverState<T extends Datum = Datum> {
    /** The hovered UTC calendar moment. `null` once the hover clears. */
    date: Date | null;
    /** Index of the hovered datum within `data`, or `-1` when cleared. */
    index: number;
    /** The matched datum, or `null` when no hover / index out of range. */
    datum: TimeSeriesDatum<T> | null;
    /**
     * Clear any active hover. Forwards to the `ChartTooltipSync` so
     * every participating chart tears its tooltip down.
     */
    clear: () => void;
}

/**
 * Subscribe to the shared `ChartTooltipSync` context and return a
 * structured hover snapshot for the given data array. Safe to call
 * outside a sync provider — returns a cleared state.
 *
 * Typical use: a KPI label above a chart echoing the hovered value:
 *
 *   const { datum } = useChartHover<MyValues>(data);
 *   const coverage = datum?.values.coverage ?? summary.coverage;
 */
export function useChartHover<T extends Datum = Datum>(
    data: Data<T>,
): ChartHoverState<T> {
    const sync = useContext(ChartTooltipSyncContext);
    const date = sync.tooltipDate ?? null;

    return useMemo<ChartHoverState<T>>(() => {
        if (!date) {
            return {
                date: null,
                index: -1,
                datum: null,
                clear: () => sync.setTooltipDate?.(null),
            };
        }
        const target = date.getTime();
        let foundIndex = -1;
        for (let i = 0; i < data.length; i++) {
            if (data[i].date.getTime() === target) {
                foundIndex = i;
                break;
            }
        }
        return {
            date,
            index: foundIndex,
            datum: foundIndex === -1 ? null : data[foundIndex],
            clear: () => sync.setTooltipDate?.(null),
        };
    }, [date, data, sync]);
}

// ─── useChartKeyboardNavigation ──────────────────────────────────────

export interface ChartKeyboardNavigationOptions<T extends Datum = Datum> {
    data: Data<T>;
    /** Controlled focus index. Omit for uncontrolled mode. */
    focusedIndex?: number;
    /** Fires whenever the focused index changes. */
    onFocusIndexChange?: (index: number) => void;
    /** Whether the handler is active. Defaults to `true`. */
    enabled?: boolean;
    /** When true, horizontal arrow keys move the focus. Default `true`. */
    useArrowKeys?: boolean;
}

export interface ChartKeyboardNavigationReturn {
    /** Current focused datum index. `-1` means "no focus". */
    focusedIndex: number;
    setFocusedIndex: (next: number) => void;
    /** Bind to the focusable wrapper around the chart (SVG, section, etc). */
    onKeyDown: (event: KeyboardEvent<Element>) => void;
}

/**
 * Keyboard navigation state machine for a chart's x-axis. Bind the
 * returned `onKeyDown` to a focusable wrapper (an SVG with
 * `tabIndex={0}` works), and the hook handles arrow-keys to step
 * through data points, Home / End for endpoints, Escape to clear.
 *
 * Integrates with `ChartTooltipSync` so every participating chart
 * echoes the focused date, not just the pointer-hovered date.
 */
export function useChartKeyboardNavigation<T extends Datum = Datum>({
    data,
    focusedIndex: controlledIndex,
    onFocusIndexChange,
    enabled = true,
    useArrowKeys = true,
}: ChartKeyboardNavigationOptions<T>): ChartKeyboardNavigationReturn {
    const [internalIndex, setInternalIndex] = useState<number>(-1);
    const sync = useContext(ChartTooltipSyncContext);

    const isControlled = controlledIndex !== undefined;
    const focusedIndex = isControlled ? controlledIndex : internalIndex;

    const setFocusedIndex = useCallback(
        (next: number) => {
            const clamped = next < -1 ? -1 : next >= data.length ? data.length - 1 : next;
            if (!isControlled) setInternalIndex(clamped);
            onFocusIndexChange?.(clamped);
            // Sync with the shared tooltip sync so non-keyboard charts echo the focus.
            if (clamped === -1) {
                sync.setTooltipDate?.(null);
            } else {
                sync.setTooltipDate?.(data[clamped]?.date ?? null);
            }
        },
        [data, isControlled, onFocusIndexChange, sync],
    );

    const onKeyDown = useCallback(
        (event: KeyboardEvent<Element>) => {
            if (!enabled || data.length === 0) return;
            const current = focusedIndex < 0 ? 0 : focusedIndex;

            if (useArrowKeys && event.key === 'ArrowRight') {
                event.preventDefault();
                setFocusedIndex(Math.min(current + 1, data.length - 1));
                return;
            }
            if (useArrowKeys && event.key === 'ArrowLeft') {
                event.preventDefault();
                setFocusedIndex(Math.max(current - 1, 0));
                return;
            }
            if (event.key === 'Home') {
                event.preventDefault();
                setFocusedIndex(0);
                return;
            }
            if (event.key === 'End') {
                event.preventDefault();
                setFocusedIndex(data.length - 1);
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                setFocusedIndex(-1);
                return;
            }
        },
        [enabled, data, focusedIndex, setFocusedIndex, useArrowKeys],
    );

    return { focusedIndex, setFocusedIndex, onKeyDown };
}

// ─── Token-backed tooltip primitives ─────────────────────────────────

export interface ChartTooltipContainerProps {
    children: ReactNode;
    className?: string;
    /**
     * Optional heading rendered on top of the container — typically the
     * formatted date of the hovered datum.
     */
    title?: ReactNode;
}

/**
 * Canonical tooltip surface for every chart. Uses the same token
 * vocabulary as the Epic 56 Tooltip primitive (`bg-bg-elevated`,
 * `border-border-default`) and the same layering (`z-[99]`) so it
 * reads as part of the broader tooltip system.
 *
 * Consumers render this *inside* the visx tooltip wrapper
 * (`TooltipWrapper` from `useTooltip`) rather than as a portal of
 * their own — the wrapper owns positioning, this primitive owns
 * the surface.
 */
export function ChartTooltipContainer({
    children,
    className,
    title,
}: ChartTooltipContainerProps) {
    return (
        <div
            data-chart-tooltip
            className={cn(
                'pointer-events-none',
                'rounded-lg border border-border-default bg-bg-elevated shadow-lg',
                'px-3 py-2',
                'text-xs leading-snug text-content-default',
                'min-w-[8rem] max-w-xs',
                className,
            )}
        >
            {title ? (
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-content-muted">
                    {title}
                </div>
            ) : null}
            <div className="flex flex-col gap-1">{children}</div>
        </div>
    );
}

export interface ChartTooltipRowProps {
    /** The series / metric label. */
    label: ReactNode;
    /** The formatted value. Accept a string so the caller formats it. */
    value: ReactNode;
    /**
     * Colour swatch — Tailwind class (token-backed) OR a CSS colour.
     * Passing a className (prefixed with `bg-`) is preferred so the
     * swatch follows theme changes.
     */
    swatch?: string;
    className?: string;
}

export function ChartTooltipRow({
    label,
    value,
    swatch,
    className,
}: ChartTooltipRowProps) {
    const swatchIsClass = typeof swatch === 'string' && swatch.startsWith('bg-');
    return (
        <div
            data-chart-tooltip-row
            className={cn(
                'flex items-center justify-between gap-default',
                className,
            )}
        >
            <span className="inline-flex items-center gap-1.5 text-content-muted">
                {swatch ? (
                    swatchIsClass ? (
                        <span
                            aria-hidden="true"
                            className={cn('size-2 rounded-full', swatch)}
                        />
                    ) : (
                        <span
                            aria-hidden="true"
                            className="size-2 rounded-full"
                            style={{ backgroundColor: swatch }}
                        />
                    )
                ) : null}
                <span>{label}</span>
            </span>
            <span className="font-medium text-content-emphasis tabular-nums">
                {value}
            </span>
        </div>
    );
}
