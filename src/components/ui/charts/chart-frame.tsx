'use client';

/**
 * Roadmap-16 PR-3 — `<ChartFrame>` wrapper. Hardened for reliable
 * rendering (no blank/0-height charts).
 *
 * Every R16 chart consumer (donut, line, radar, gantt) mounts inside
 * `<ChartFrame>`. The wrapper owns:
 *
 *   - Responsive sizing via `@visx/responsive`'s `ParentSize`.
 *   - Render-prop children: `({width, height, data}) => svg-tree`.
 *   - State-driven branch rendering (`loading | empty | error | ready`).
 *   - A GUARANTEED non-zero height for the measured area + every state
 *     fallback (see "Reliability contract" below).
 *   - Client-only rendering — the auto-sizer measures the DOM, so it
 *     only runs after hydration (a `mounted` gate shows the skeleton
 *     until then, never a 0×0 chart).
 *   - Token-backed chrome + skeleton / empty / error vocabularies.
 *
 * ─── Reliability contract (the blank-radar fix) ───
 *
 * The bug: `ParentSize` returns `{width, height}` by measuring its box.
 * The previous layout put `ParentSize` on a `size-full` (height: 100%)
 * element whose height never resolved against a min-height-only parent —
 * so it measured `height: 0`, the render-prop short-circuited, and the
 * chart rendered nothing (the org-dashboard maturity radar's blank box).
 *
 * The fix, applied to EVERY chart that uses this frame at once:
 *   1. The outer frame is `position: relative` with a definite
 *      `min-height`. Its inner content (the measured area AND the
 *      loading/empty/error fallbacks) is `position: absolute; inset: 0`.
 *      Absolute children are out of flow, so the frame's used height
 *      resolves to its `min-height` — giving `ParentSize` a real,
 *      non-zero box to measure regardless of how the parent flexes.
 *   2. If a measure still yields `height === 0` (transient), the
 *      render-prop falls back to the frame's `min-height` rather than
 *      rendering a 0-tall chart.
 *   3. If `width === 0` (the box is genuinely unmeasurable — detached
 *      or display:none), the frame shows its skeleton, never a blank.
 */
import { useTranslations } from 'next-intl';
import {
    ReactElement,
    ReactNode,
    useEffect,
    useState,
} from 'react';
import { ParentSize } from '@visx/responsive';

import { cn } from '@inflect/ui/lib/cn';
import { EmptyState } from '../empty-state';
import { ErrorState } from '../error-state';
import { Skeleton } from '../skeleton';

import type { ChartState } from './types';

/** Locked minimum chart height. Prevents layout shift + 0-height collapse. */
export const DEFAULT_MIN_HEIGHT = 240;

interface ChartFrameProps<T> {
    /** Discriminated data state. R16 consumers thread the whole `ChartState`. */
    state: ChartState<T>;
    /**
     * Render-prop body — called only when `state.kind === 'ready'` AND
     * the frame has a measurable box. Receives the measured (or
     * min-height-floored) `{ width, height }`. Returns the SVG tree.
     */
    children: (args: {
        width: number;
        height: number;
        data: T;
    }) => ReactNode;
    /** Extra classes on the outer wrapper. */
    className?: string;
    /** data-testid for the outer wrapper. */
    testId?: string;
    /** Override the default min-height (240 px). Pass `null` to disable. */
    minHeight?: number | null;
    /**
     * Optional override for the loading branch. Default: a generic
     * `<Skeleton>` block sized to fill the frame.
     */
    loadingFallback?: ReactNode;
    /**
     * Optional override for the empty branch. Default:
     * `<EmptyState size="sm" title="No data yet" description="..."/>`.
     */
    emptyFallback?: ReactNode;
    /**
     * Optional override for the error branch. Default:
     * `<ErrorState title="Couldn’t load chart" message={state.message}/>`.
     */
    errorFallback?: ReactNode;
}

/**
 * Responsive chart container with state-driven branch rendering.
 *
 * Typical consumer shape:
 *
 *     const state = useReadinessTrend();
 *     return (
 *       <ChartFrame state={state} testId="readiness-trend">
 *         {({ width, height, data }) => (
 *           <svg width={width} height={height}>…</svg>
 *         )}
 *       </ChartFrame>
 *     );
 */
export function ChartFrame<T>({
    state,
    children,
    className,
    testId,
    minHeight = DEFAULT_MIN_HEIGHT,
    loadingFallback,
    emptyFallback,
    errorFallback,
}: ChartFrameProps<T>): ReactElement {
    const t = useTranslations('common.chart');
    // Client-only gate. The auto-sizer measures the DOM, which is 0×0
    // during SSR + the first synchronous client render. Showing the
    // skeleton until mount guarantees the measure runs against a real
    // box — never a 0×0 chart that looks broken.
    const [mounted, setMounted] = useState(false);
    useEffect(() => setMounted(true), []);

    // The floor we fall back to whenever a measure yields 0.
    const floor = minHeight ?? DEFAULT_MIN_HEIGHT;

    if (!mounted || state.kind === 'loading') {
        return (
            <ChartFrameOuter
                className={className}
                testId={testId}
                minHeight={minHeight}
                stateKind="loading"
            >
                {loadingFallback ?? (
                    <Skeleton className="size-full rounded-lg" />
                )}
            </ChartFrameOuter>
        );
    }

    if (state.kind === 'error') {
        return (
            <ChartFrameOuter
                className={className}
                testId={testId}
                minHeight={minHeight}
                stateKind="error"
            >
                {errorFallback ?? (
                    <ErrorState
                        title={t('couldntLoadChart')}
                        description={state.message}
                    />
                )}
            </ChartFrameOuter>
        );
    }

    if (state.kind === 'empty') {
        return (
            <ChartFrameOuter
                className={className}
                testId={testId}
                minHeight={minHeight}
                stateKind="empty"
            >
                {emptyFallback ?? (
                    <EmptyState
                        size="sm"
                        title={t('noDataYet')}
                        description={t('emptyDescription')}
                    />
                )}
            </ChartFrameOuter>
        );
    }

    // state.kind === 'ready' — measure and render. The `ParentSize` is
    // `absolute inset-0` (via ChartFrameOuter's `fill` mode) so it
    // measures the frame's min-height box, never a collapsed 0.
    return (
        <ChartFrameOuter
            className={className}
            testId={testId}
            minHeight={minHeight}
            stateKind="ready"
            fill
        >
            <ParentSize className="size-full" debounceTime={0}>
                {({ width, height }) => {
                    // Genuinely unmeasurable (detached / display:none) →
                    // keep the skeleton, never a blank.
                    if (width === 0) {
                        return <Skeleton className="size-full rounded-lg" />;
                    }
                    // Floor the height so a transient 0 never produces a
                    // 0-tall chart.
                    const h = height === 0 ? floor : height;
                    return children({ width, height: h, data: state.data });
                }}
            </ParentSize>
        </ChartFrameOuter>
    );
}

interface ChartFrameOuterProps {
    children: ReactNode;
    className?: string;
    testId?: string;
    minHeight: number | null;
    stateKind: ChartState<unknown>['kind'];
    /**
     * Ready (measured) mode: render the child edge-to-edge filling the
     * frame instead of centring it. The child (`<ParentSize>`) is
     * positioned `absolute inset-0` so it measures the frame's
     * min-height box.
     */
    fill?: boolean;
}

/**
 * The chrome around the inner branch. A `relative` box with a definite
 * `min-height`; its single child is positioned `absolute inset-0` so the
 * box's used height resolves to the min-height (the child is out of
 * flow) — every branch (skeleton, empty, error, the measured chart) gets
 * a guaranteed non-zero box. `data-chart-state` differs per branch so
 * consumers can style per-state.
 */
function ChartFrameOuter({
    children,
    className,
    testId,
    minHeight,
    stateKind,
    fill = false,
}: ChartFrameOuterProps): ReactElement {
    return (
        <div
            data-chart-frame="true"
            data-chart-state={stateKind}
            data-testid={testId}
            className={cn(
                // Outer chrome — relative anchor (so the absolute inner
                // resolves the min-height), bg + rounded corner.
                'relative rounded-lg bg-bg-elevated/40',
                className,
            )}
            style={
                minHeight !== null ? { minHeight: `${minHeight}px` } : undefined
            }
        >
            <div
                className={cn(
                    // Fill the frame's min-height box. Absolute + inset-0
                    // means this child is out of flow, so the parent's
                    // used height collapses to its `min-height` floor.
                    'absolute inset-0 p-4',
                    fill
                        ? // Measured chart: edge-to-edge, no centring.
                          ''
                        : // Fallback: centre the skeleton / empty / error.
                          'flex items-center justify-center',
                )}
            >
                {children}
            </div>
        </div>
    );
}
