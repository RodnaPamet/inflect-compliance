/**
 * Regression lock for the org-dashboard "blank maturity radar" bug.
 *
 * Root cause: the radar's auto-sizer (`ParentSize` inside `<ChartFrame>`)
 * measured a 0-height box (collapsible flex parent + percentage-height
 * chain), so the render-prop short-circuited and the chart painted
 * nothing. The fix gives the measured area a guaranteed min-height box
 * and floors a 0 measure.
 *
 * jsdom does no layout, so `ParentSize` always measures 0×0 there — we
 * mock it to feed real dimensions, then assert:
 *   • with data  → the radar SVG renders (axis lines + a polygon path),
 *     never a blank box;
 *   • without data → the labeled empty state renders (not blank, not a
 *     0-height collapse).
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

// jsdom can't measure layout — feed the auto-sizer a real box so the
// ready branch actually renders its SVG (mirrors a sized container in
// the browser).
jest.mock('@visx/responsive', () => ({
    ParentSize: ({
        children,
    }: {
        children: (size: { width: number; height: number }) => React.ReactNode;
    }) => <>{children({ width: 400, height: 260 })}</>,
}));

import { RadarChart } from '@/components/ui/charts/radar-chart';
import { chartReady, chartEmpty } from '@inflect/ui/components/ui/charts/types';
import type { RadarAxisDatum } from '@/components/ui/charts/radar-chart';

const AXES: RadarAxisDatum[] = [
    { key: 'govern', label: 'Govern', value: 3 },
    { key: 'identify', label: 'Identify', value: 4 },
    { key: 'protect', label: 'Protect', value: 2 },
    { key: 'detect', label: 'Detect', value: 3 },
    { key: 'respond', label: 'Respond', value: 5 },
    { key: 'recover', label: 'Recover', value: 1 },
];

describe('org-dashboard maturity radar renders reliably (never blank)', () => {
    it('renders the radar SVG with axis lines + a polygon when data exists', () => {
        const { container } = render(
            <RadarChart
                state={chartReady(AXES)}
                seriesIndex={2}
                maxValue={5}
                testId="org-maturity-radar"
                ariaLabel="Security maturity by CSF function"
            />,
        );

        // The frame is in its READY branch (not blank, not empty).
        const frame = screen.getByTestId('org-maturity-radar');
        expect(frame.getAttribute('data-chart-state')).toBe('ready');

        // The actual chart SVG renders…
        const svg = container.querySelector('svg');
        expect(svg).toBeTruthy();
        // …with axis lines (one per CSF function) …
        expect(container.querySelectorAll('line').length).toBeGreaterThan(0);
        // …and a data polygon path.
        expect(container.querySelectorAll('path').length).toBeGreaterThan(0);
    });

    it('renders a labeled empty state (not a blank box) when there is no data', () => {
        render(
            <RadarChart
                state={chartEmpty<RadarAxisDatum[]>()}
                seriesIndex={2}
                maxValue={5}
                testId="org-maturity-radar"
                ariaLabel="Security maturity by CSF function"
                emptyFallback={
                    <div>Rate your maturity to populate this radar.</div>
                }
            />,
        );

        const frame = screen.getByTestId('org-maturity-radar');
        expect(frame.getAttribute('data-chart-state')).toBe('empty');
        expect(
            screen.getByText(/Rate your maturity to populate this radar/i),
        ).toBeInTheDocument();
        // No chart SVG in the empty branch.
        expect(frame.querySelector('svg')).toBeNull();
    });

    it('the frame carries a definite min-height so the box can never collapse to 0', () => {
        render(
            <RadarChart
                state={chartReady(AXES)}
                seriesIndex={2}
                maxValue={5}
                testId="org-maturity-radar"
            />,
        );
        const frame = screen.getByTestId('org-maturity-radar');
        // The outer frame style pins a non-zero min-height.
        expect(frame.style.minHeight).toMatch(/\d+px/);
        expect(parseInt(frame.style.minHeight, 10)).toBeGreaterThan(0);
    });
});
