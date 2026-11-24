/**
 * On a touch screen a chart's drill-downs are a list a finger can hit, and its
 * marks take no taps (docs/charts.md, "Touch").
 *
 * - A donut legend row is the slice's drill-through link, and on a coarse
 *   pointer it is a 44px row (`pointer-coarse:min-h-11`). It was a 16px line
 *   of 12px text, measured on the dashboard at 390 and 360.
 * - A radar's vertices (8px) and axis labels (one 11px line) sit inside a group
 *   that ignores pointer events on a coarse pointer, so a tap lands on the
 *   chart as a whole. The chart itself must still take pointer events, and
 *   the marks keep their keyboard focus and accessible names.
 * - The posture ladder, the radar's values as a list, is at least 12px.
 *
 * jsdom evaluates no media query, so the classes that carry each rule are
 * what is read here; the mobile E2E project measures the result.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@visx/responsive', () => ({
    ParentSize: ({
        children,
    }: {
        children: (size: { width: number; height: number }) => React.ReactNode;
    }) => <>{children({ width: 360, height: 260 })}</>,
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
    usePermissions: () => ({ controls: { edit: true } }),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, opts?: Record<string, unknown>) => {
            const full = ns ? `${ns}.${key}` : key;
            let v = full
                .split('.')
                .reduce((o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), en as unknown);
            if (typeof v !== 'string') return key;
            if (opts) for (const [p, val] of Object.entries(opts)) v = (v as string).split(`{${p}}`).join(String(val));
            return v;
        },
    };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/components/onboarding/OnboardingBanner', () => {
    const Stub = () => null;
    Stub.displayName = 'OnboardingBannerStub';
    return Stub;
});

import { DonutLegendRow } from '@/app/t/[tenantSlug]/(app)/dashboard/DashboardClient';
import { PostureLadder } from '@/app/t/[tenantSlug]/(app)/dashboard/PostureLadder';
import { RadarChart, type RadarAxisDatum } from '@/components/ui/charts/radar-chart';
import { chartReady } from '@inflect/ui/components/ui/charts/types';
import type { PostureAxisRating } from '@/lib/charts/posture-radar';

const INERT_ON_TOUCH = 'pointer-coarse:pointer-events-none';

describe('a donut legend row on a touch screen', () => {
    it('is the slice link, 44px tall on a coarse pointer', () => {
        render(<DonutLegendRow label="Critical" value={2} dotColor="#000" href="/t/acme/risks?score=15|25" />);
        const link = screen.getByRole('link');
        expect(link).toHaveAttribute('href', '/t/acme/risks?score=15|25');
        expect(link.className.split(/\s+/)).toContain('pointer-coarse:min-h-11');
        // The row's own content still reads on one line on a desktop.
        expect(link.className.split(/\s+/)).not.toContain('min-h-11');
    });

    it('is plain text, not a target, when the slice has nowhere to go', () => {
        render(<DonutLegendRow label="Archived" value={0} dotColor="#000" />);
        expect(screen.queryByRole('link')).toBeNull();
        expect(screen.getByText('Archived')).toBeInTheDocument();
    });
});

describe('a radar on a touch screen', () => {
    const AXES: RadarAxisDatum[] = [
        { key: 'controls', label: 'Controls', value: 2 },
        { key: 'risk', label: 'Risk', value: 1 },
        { key: 'policies', label: 'Policies', value: 5 },
        { key: 'tasks', label: 'Tasks', value: 5 },
    ];

    function renderRadar() {
        return render(
            <RadarChart state={chartReady(AXES)} seriesIndex={2} maxValue={5} rings={5} testId="radar" ariaLabel="Posture" />,
        );
    }

    it('puts every vertex and every axis label inside the group that ignores taps', () => {
        const { container } = renderRadar();
        const vertices = Array.from(container.querySelectorAll('circle[tabindex="0"]'));
        const labels = Array.from(container.querySelectorAll('g[tabindex="0"]'));
        expect(vertices).toHaveLength(AXES.length);
        expect(labels).toHaveLength(AXES.length);
        for (const mark of [...vertices, ...labels]) {
            const inert = mark.parentElement?.closest('g');
            expect(inert?.getAttribute('class') ?? '').toContain(INERT_ON_TOUCH);
        }
    });

    it('leaves the chart itself taking pointer events, so a tap lands on it', () => {
        const { container } = renderRadar();
        const svg = container.querySelector('svg[role="img"]')!;
        expect(svg.getAttribute('class') ?? '').not.toContain(INERT_ON_TOUCH);
        expect(svg.getAttribute('pointer-events')).toBeNull();
    });

    it('keeps each vertex focusable by keyboard and named for a screen reader', () => {
        const { container } = renderRadar();
        const vertices = Array.from(container.querySelectorAll('circle[tabindex="0"]'));
        expect(vertices.map((v) => v.getAttribute('aria-label'))).toEqual(
            AXES.map((a) => expect.stringContaining(a.label)),
        );
    });
});

describe('the posture ladder', () => {
    const RATINGS: PostureAxisRating[] = [
        { key: 'controls', label: 'Controls', value: 50, level: 2, measured: 2, total: 4 },
        { key: 'evidence', label: 'Evidence', value: 0, level: null, measured: 0, total: 0 },
    ] as PostureAxisRating[];

    it('sets every row at 12px or more', () => {
        const { container } = render(<PostureLadder ratings={RATINGS} />);
        const rows = Array.from(container.querySelectorAll('[data-posture-axis]'));
        expect(rows).toHaveLength(RATINGS.length);
        for (const row of rows) {
            expect(row.className.split(/\s+/)).toContain('text-xs');
            expect(row.outerHTML).not.toMatch(/text-\[(?:[0-9]|1[01])px\]/);
        }
    });
});
