/**
 * Chart text a viewer reads or hears is in their language (#5312).
 *
 * Two pieces of chart chrome were English on every page: the gradient
 * legend's accessible name ("Activity: 0 to 5"), with the calendar heatmap
 * passing an English "Activity" label, and the time-series chart's default
 * empty state ("No data for this range"). These render with
 * next-intl backed by the BULGARIAN catalogue, so an English string anywhere in
 * them is a failure rather than something the English-backed global mock hides.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const bg = jest.requireActual('../../messages/bg.json');
    const lookup = (path: string): unknown =>
        path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), bg);
    const useTranslations = (namespace?: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const value = lookup(namespace ? `${namespace}.${key}` : key);
            const text = typeof value === 'string' ? value : key;
            return text.replace(/\{(\w+)\}/g, (m, name: string) => (params && name in params ? String(params[name]) : m));
        };
        return t;
    };
    return { useTranslations, useLocale: () => 'bg', useFormatter: () => ({}) };
});

jest.mock('@visx/responsive', () => {
    const actual = jest.requireActual('@visx/responsive');
    return {
        ...actual,
        ParentSize: ({ children }: { children: (a: { width: number; height: number }) => React.ReactNode }) => (
            <div>{children({ width: 640, height: 320 })}</div>
        ),
    };
});

import { ChartLegend, TimeSeriesChart, type HeatScale } from '@/components/ui/charts';
import { CalendarHeatmap } from '@/app/t/[tenantSlug]/(app)/calendar/_components/CalendarHeatmap';

const bg = jest.requireActual('../../messages/bg.json') as {
    common: { chart: Record<string, string> };
    calendar: Record<string, string>;
};

const HEAT: HeatScale = {
    colorFor: () => 'transparent',
    intensityFor: () => 0,
    gradientId: 'test-heat',
    startVar: '--chart-series-1-start',
    endVar: '--chart-series-1-end',
    domain: [0, 5],
} as unknown as HeatScale;

describe('chart chrome follows the locale', () => {
    it('the gradient legend announces its range in Bulgarian', () => {
        render(<ChartLegend variant="gradient" heatScale={HEAT} label="Етикет" />);
        const name = screen.getByRole('img').getAttribute('aria-label');
        expect(name).toBe('Етикет: от 0 до 5');
        expect(name).not.toMatch(/\bto\b/);
    });

    it('and without a label too', () => {
        render(<ChartLegend variant="gradient" heatScale={HEAT} />);
        expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Скала: от 0 до 5');
    });

    it('the calendar heatmap labels its legend in Bulgarian', () => {
        render(<CalendarHeatmap events={[]} from={new Date('2026-06-01T00:00:00Z')} to={new Date('2026-06-14T00:00:00Z')} />);
        const label = bg.calendar.heatmapLegendLabel;
        expect(label).toBeTruthy();
        expect(screen.getByText(label)).toBeTruthy();
        expect(screen.queryByText('Activity')).toBeNull();
        const legend = document.querySelector('[data-chart-legend-variant="gradient"] svg[role="img"]');
        expect(legend?.getAttribute('aria-label')?.startsWith(`${label}: от `)).toBe(true);
    });

    it("the time-series chart's default empty state is in Bulgarian", () => {
        render(<TimeSeriesChart data={[]} series={[]} />);
        expect(screen.getByRole('status').textContent).toBe(bg.common.chart.noDataForRange);
        expect(screen.queryByText('No data for this range')).toBeNull();
    });
});
