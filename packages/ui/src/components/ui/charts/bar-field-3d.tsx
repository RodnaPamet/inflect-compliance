'use client';

/**
 * Roadmap-21 PR-F — `<BarField3D>`, the first 3D chart in IC (STUB).
 *
 * ### Status
 *
 * **This is a SCAFFOLD, not a working 3D renderer.** R21-PR-E
 * documents the compatibility deadlock that prevents
 * `@react-three/fiber` from landing under React 19 today; see
 * `chart-3d.tsx` head matter for the full explanation.
 *
 * BarField3D therefore renders ONLY its `FallbackComponent` (the
 * 2D representation of the same data). When the future renderer
 * lands, BarField3D's body grows the actual 3D bar field; until
 * then the fallback IS the visible chart.
 *
 * ### The future shape (locked here)
 *
 * BarField3D renders a cross-tab of two discrete dimensions
 * (typically time × category) as a grid of bars with value-
 * encoded heights. Composes onto `<Chart3D>` from PR-E; bars
 * colour-map via `tokenColor(seriesIndex, 'start' | 'end')` —
 * base reads the gradient's start stop, tip reads the end stop.
 * Missing cells render as gaps in the floor plane (NOT bars
 * with zero height) — the user reads the absence as "no data",
 * not "value=0".
 *
 * For now: callers pass the same data shape, supply a 2D
 * `FallbackComponent` (typically a heatmap), and accept that the
 * visible render is the 2D fallback. When the renderer lands,
 * NO API change at the call site — the inner branch swaps.
 *
 * ### Accessibility
 *
 *   - Required `ariaLabel` describes the chart's data story.
 *   - `FallbackComponent` (passed through to `<Chart3D>`) renders
 *     a 2D representation accessible to screen readers, reduced-
 *     motion users, and WebGL-unsupported browsers. Charts
 *     consuming `<BarField3D>` MUST supply this in the stub state
 *     (without it, the chart renders an empty placeholder).
 */

import type { Chart3DProps } from './chart-3d';
import { Chart3D } from './chart-3d';
import type { ChartSeriesIndex } from './chart-gradient';

export interface BarField3DDatum {
    /** Discrete X-axis category (e.g. quarter, framework). */
    x: string;
    /** Discrete Z-axis category (e.g. maturity, severity). */
    z: string;
    /** Bar height value. Non-negative. */
    y: number;
}

export interface BarField3DProps {
    data: BarField3DDatum[];
    /**
     * Chart-series index driving the bar gradient. Bars colour-map
     * from `--chart-series-${seriesIndex}-start` at the bar's base
     * to `--chart-series-${seriesIndex}-end` at the bar's top via
     * `tokenColor()`. Default 1. (Currently unused in the stub —
     * the FallbackComponent owns its own colour vocabulary.)
     */
    seriesIndex?: ChartSeriesIndex;
    /**
     * Maximum bar height in world units. Default 4. (Currently
     * unused in the stub.)
     */
    maxHeight?: number;
    /**
     * Accessible description forwarded to <Chart3D>.
     */
    ariaLabel: string;
    /**
     * 2D fallback rendered when prefers-reduced-motion is set OR
     * when WebGL is unavailable. In the stub state this IS the
     * rendered chart — supply it.
     */
    FallbackComponent?: Chart3DProps['FallbackComponent'];
    className?: string;
    'data-testid'?: string;
}

export function BarField3D({
    data: _data,
    seriesIndex: _seriesIndex = 1,
    maxHeight: _maxHeight = 4,
    ariaLabel,
    FallbackComponent,
    className,
    'data-testid': dataTestId = 'bar-field-3d',
}: BarField3DProps) {
    return (
        <Chart3D
            ariaLabel={ariaLabel}
            FallbackComponent={FallbackComponent}
            className={className}
            data-testid={dataTestId}
        >
            {/* Future renderer mounts the real 3D scene here.
                In the stub state, Chart3D's fallback branch
                renders the FallbackComponent (or a placeholder
                div if none is supplied). The data + seriesIndex
                + maxHeight props are captured at the API level
                so the inner branch swap doesn't churn call
                sites when the real renderer lands. The empty
                fragment satisfies Chart3D's `children: ReactNode`
                contract — the eventual r3f scene replaces it. */}
            <></>
        </Chart3D>
    );
}
