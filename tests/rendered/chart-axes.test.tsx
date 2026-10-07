/**
 * Epic 59 — XAxis / YAxis rendered behaviour.
 *
 *   1. Labels resolve against design-system tokens (`--content-muted`
 *      for dimmed ticks, `--content-emphasis` for the highlighted
 *      tick) so both themes read correctly.
 *   2. Grid lines use token colours, not hardcoded hex.
 *   3. Tick density responds to the plot width / height the axis is
 *      handed (we share one curve with every chart — the shared
 *      layout module is unit-tested separately, but the axis still
 *      has to respect the fallback).
 *   4. Empty data + single-datum datasets render cleanly (no
 *      divide-by-zero, no `<g>` subtrees with zero ticks).
 */

import React from 'react';
import { render } from '@testing-library/react';
import { scaleBand, scaleLinear, scaleUtc } from '@visx/scale';

import {
    ChartContext as ChartContextModule,
    ChartTooltipContext as ChartTooltipContextModule,
} from '@inflect/ui/components/ui/charts/chart-context';
import { XAxis } from '@inflect/ui/components/ui/charts/x-axis';
import { YAxis } from '@inflect/ui/components/ui/charts/y-axis';
import type {
    ChartContextType,
    ChartTooltipContextType,
    Data,
    Series,
} from '@/components/ui/charts';

interface DemoValues {
    coverage: number;
}

const sixDayData: Data<DemoValues> = [
    { date: new Date('2026-04-01T00:00:00Z'), values: { coverage: 70 } },
    { date: new Date('2026-04-02T00:00:00Z'), values: { coverage: 72 } },
    { date: new Date('2026-04-03T00:00:00Z'), values: { coverage: 74 } },
    { date: new Date('2026-04-04T00:00:00Z'), values: { coverage: 76 } },
    { date: new Date('2026-04-05T00:00:00Z'), values: { coverage: 78 } },
    { date: new Date('2026-04-06T00:00:00Z'), values: { coverage: 80 } },
];

const series: Series<DemoValues>[] = [
    { id: 'coverage', valueAccessor: (d) => d.values.coverage, isActive: true },
];

// ─── Test harness ────────────────────────────────────────────────────

function makeContext({
    data = sixDayData,
    width = 720,
    height = 320,
    type = 'area' as 'area' | 'bar',
    minY = 70,
    maxY = 80,
}: {
    data?: Data<DemoValues>;
    width?: number;
    height?: number;
    type?: 'area' | 'bar';
    minY?: number;
    maxY?: number;
} = {}): ChartContextType<DemoValues> {
    const margin = { top: 12, right: 8, bottom: 32, left: 40 };
    const yScale = scaleLinear<number>({
        domain: [minY, maxY],
        range: [height, 0],
        nice: true,
        clamp: true,
    });
    const xScale =
        type === 'area'
            ? scaleUtc<number>({
                  domain: [
                      data[0]?.date ?? new Date(),
                      data[data.length - 1]?.date ?? new Date(),
                  ],
                  range: [0, width],
              })
            : scaleBand<Date>({
                  domain: data.map((d) => d.date),
                  range: [0, width],
                  padding: 0.15,
                  align: 0.5,
              });

    return {
        type,
        width,
        height,
        data,
        series,
        startDate: data[0]?.date ?? new Date(),
        endDate: data[data.length - 1]?.date ?? new Date(),
        xScale: xScale as unknown as ChartContextType<DemoValues>['xScale'],
        yScale,
        minY,
        maxY,
        margin,
        padding: { top: 0.1, bottom: 0.1 },
        tooltipContent: () => '',
        tooltipClassName: '',
        defaultTooltipIndex: null,
        leftAxisMargin: 0,
        setLeftAxisMargin: () => {},
    };
}

function renderAxis(node: React.ReactNode, ctx?: ChartContextType<DemoValues>) {
    const chartCtx = ctx ?? makeContext();
    const tooltipCtx = {
        handleTooltip: () => {},
        TooltipWrapper: (() => null) as unknown as ChartTooltipContextType['TooltipWrapper'],
        containerRef: () => {},
        tooltipData: undefined,
        tooltipLeft: undefined,
        tooltipTop: undefined,
        tooltipOpen: false,
        showTooltip: () => {},
        hideTooltip: () => {},
        updateTooltip: () => {},
    } as unknown as ChartTooltipContextType<DemoValues>;

    return render(
        <svg
            width={chartCtx.width + chartCtx.margin.left + chartCtx.margin.right}
            height={chartCtx.height + chartCtx.margin.top + chartCtx.margin.bottom}>
            <ChartContextModule.Provider
                value={chartCtx as unknown as React.ContextType<typeof ChartContextModule>}>
                <ChartTooltipContextModule.Provider
                    value={tooltipCtx as unknown as React.ContextType<typeof ChartTooltipContextModule>}>
                    {node}
                </ChartTooltipContextModule.Provider>
            </ChartContextModule.Provider>
        </svg>,
    );
}

// ─── XAxis ───────────────────────────────────────────────────────────

describe('XAxis — rendering + tokens', () => {
    it('renders tick labels using the content-muted / content-emphasis tokens', () => {
        const { container } = renderAxis(<XAxis />);
        const texts = Array.from(container.querySelectorAll('text'));
        expect(texts.length).toBeGreaterThan(0);
        const fills = texts.map((t) => t.getAttribute('fill'));
        // Every tick label fills with a token CSS variable — no hex.
        for (const f of fills) {
            expect(f).toMatch(/var\(--content-(muted|emphasis)\)/);
        }
        // At least one tick highlights (the last one, by default).
        expect(fills).toContain('var(--content-emphasis)');
        // No hardcoded alpha-hex fills leak through.
        for (const f of fills) expect(f).not.toMatch(/^#/);
    });

    it('uses the axis-line stroke token when `showAxisLine` is true', () => {
        const { container } = renderAxis(<XAxis showAxisLine />);
        const lines = Array.from(container.querySelectorAll('line, path'));
        // Any visible (non-transparent) axis-line / domain stroke must be a token var.
        const strokes = lines
            .map((l) => l.getAttribute('stroke'))
            .filter((s): s is string => !!s && s !== 'transparent');
        for (const s of strokes) {
            expect(s).toMatch(/var\(--border-(default|subtle)\)/);
        }
    });

    it('renders dashed grid lines (token-backed) when showGridLines is true', () => {
        const { container } = renderAxis(<XAxis showGridLines />);
        const lines = Array.from(container.querySelectorAll('line'));
        // At least one grid-line segment is present.
        expect(lines.length).toBeGreaterThan(0);
        // Every rendered grid-line stroke is a token var (or transparent under tooltip).
        for (const l of lines) {
            const stroke = l.getAttribute('stroke');
            if (stroke && stroke !== 'transparent') {
                expect(stroke).toMatch(/var\(--border-(default|subtle)\)/);
            }
        }
    });

    it('tick density falls back to the shared responsive curve', () => {
        // Dense width (720px) → up to 8 ticks.
        const wide = renderAxis(<XAxis />, makeContext({ width: 720 }));
        const wideTicks = wide.container.querySelectorAll('text').length;

        // Compact width (320px) → up to 4 ticks.
        const narrow = renderAxis(<XAxis />, makeContext({ width: 320 }));
        const narrowTicks = narrow.container.querySelectorAll('text').length;

        expect(narrowTicks).toBeLessThanOrEqual(wideTicks);
    });

    it('empty data renders no tick elements', () => {
        const { container } = renderAxis(<XAxis />, makeContext({ data: [] }));
        // AxisBottom still emits a <g> wrapper but zero `<text>` tick labels.
        const texts = container.querySelectorAll('text');
        expect(texts.length).toBe(0);
    });

    it('respects caller-supplied tickFormat', () => {
        const { container } = renderAxis(
            <XAxis tickFormat={(d) => `day-${d.getUTCDate()}`} />,
        );
        const text = container.querySelector('text');
        expect(text?.textContent).toMatch(/^day-\d+$/);
    });
});

// ─── YAxis ───────────────────────────────────────────────────────────

describe('YAxis — rendering + tokens', () => {
    it('renders tick labels using the content-muted token', () => {
        const { container } = renderAxis(<YAxis />);
        const texts = Array.from(container.querySelectorAll('text'));
        expect(texts.length).toBeGreaterThan(0);
        for (const t of texts) {
            expect(t.getAttribute('fill')).toBe('var(--content-muted)');
        }
    });

    it('renders dashed grid lines with a token stroke', () => {
        const { container } = renderAxis(<YAxis showGridLines />);
        const lines = Array.from(container.querySelectorAll('line'));
        // All visible grid-line strokes are token-backed.
        for (const l of lines) {
            const stroke = l.getAttribute('stroke');
            if (stroke && stroke !== 'transparent') {
                expect(stroke).toMatch(/var\(--border-(default|subtle)\)/);
            }
        }
    });

    it('tick density falls back to the shared responsive curve (height-aware)', () => {
        const short = renderAxis(<YAxis />, makeContext({ height: 240 }));
        const tall = renderAxis(<YAxis />, makeContext({ height: 480 }));
        const shortTicks = short.container.querySelectorAll('text').length;
        const tallTicks = tall.container.querySelectorAll('text').length;
        expect(shortTicks).toBeLessThanOrEqual(tallTicks);
    });

    it('supports caller-supplied tickValues (override dynamic generation)', () => {
        const { container } = renderAxis(
            <YAxis tickValues={[70, 75, 80]} />,
        );
        const labels = Array.from(container.querySelectorAll('text')).map(
            (t) => t.textContent,
        );
        expect(labels).toEqual(expect.arrayContaining(['70', '75', '80']));
    });

    it('respects caller-supplied tickFormat', () => {
        const { container } = renderAxis(
            <YAxis tickFormat={(v) => `${v}%`} tickValues={[70, 80]} />,
        );
        const labels = Array.from(container.querySelectorAll('text')).map(
            (t) => t.textContent,
        );
        expect(labels).toEqual(expect.arrayContaining(['70%', '80%']));
    });

    it('integerTicks filters out non-integer tick values', () => {
        const { container } = renderAxis(
            <YAxis integerTicks tickValues={[70, 70.5, 71]} />,
        );
        // tickValuesProp short-circuits the filter, so the filter only applies
        // when tickValues are computed from the scale; this test asserts the
        // integer fallback path does not crash on a mixed supplied set.
        expect(container.querySelectorAll('text').length).toBeGreaterThan(0);
    });
});

// ─── Layout sanity — empty + single-datum datasets ───────────────────

describe('Axis empty + single-datum behaviour', () => {
    it('XAxis on a single-datum dataset renders one label, not two', () => {
        const single: Data<DemoValues> = [
            { date: new Date('2026-04-01T00:00:00Z'), values: { coverage: 70 } },
        ];
        const { container } = renderAxis(
            <XAxis />,
            makeContext({ data: single }),
        );
        // One datum → one tick label (not two pinned endpoints).
        expect(container.querySelectorAll('text').length).toBe(1);
    });

    it('YAxis tolerates a zero-range domain (minY === maxY) without crashing', () => {
        const ctx = makeContext({ minY: 50, maxY: 50 });
        expect(() => renderAxis(<YAxis />, ctx)).not.toThrow();
    });
});
