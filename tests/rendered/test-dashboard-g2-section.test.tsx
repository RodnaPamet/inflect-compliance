/**
 * Epic G-2 prompt 6 — TestDashboardG2Section render tests.
 *
 * Pins the operational-visibility contracts for the dashboard
 * widgets that close out the G-2 feature:
 *
 *   1. Overdue list: only items with daysUntilRun < 0 render;
 *      sorted most-overdue-first; "+N more" appears when the
 *      automation.overdueScheduled count exceeds the visible rows.
 *   2. Sparkline: per-day TimeSeriesPoint[] passed to MiniAreaChart;
 *      empty-data path renders the "no runs" placeholder.
 *   3. Empty state is correct (no scheduled plans).
 *
 * (R3-P3 removed the pass/fail donut — it duplicated the main
 * dashboard's Result Distribution card — so this section no longer
 * renders a distribution chart.)
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

jest.mock('@inflect/ui/lib/format-date', () => ({
    formatDate: (iso: string) => `formatted(${iso})`,
}));

// Capture the props the chart primitives receive so we can assert
// the data shape without rendering the full visx tree (it's heavy
// under jsdom and we only care about wiring here).
const sparklineSpy = jest.fn();
jest.mock('@/components/ui/mini-area-chart', () => ({
    __esModule: true,
    MiniAreaChart: (props: unknown) => {
        sparklineSpy(props);
        return <div data-testid="mock-sparkline" />;
    },
}));

import {
    TestDashboardG2Section,
    type DashboardUpcomingItem,
} from '@/components/TestDashboardG2Section';

// ─── Helpers ───────────────────────────────────────────────────────

function makeUpcoming(
    overrides: Partial<DashboardUpcomingItem> = {},
): DashboardUpcomingItem {
    return {
        planId: overrides.planId ?? 'p-1',
        planName: overrides.planName ?? 'Plan One',
        controlId: overrides.controlId ?? 'c-1',
        controlName: overrides.controlName ?? 'Control One',
        automationType: overrides.automationType ?? 'SCRIPT',
        schedule: overrides.schedule ?? '0 9 * * *',
        scheduleTimezone: overrides.scheduleTimezone ?? 'UTC',
        nextRunAtIso: overrides.nextRunAtIso ?? new Date().toISOString(),
        daysUntilRun: overrides.daysUntilRun ?? 0,
    };
}

const BASE_TREND = {
    days: ['2026-05-01', '2026-05-02', '2026-05-03'],
    pass: [1, 0, 2],
    fail: [0, 1, 0],
    inconclusive: [0, 0, 1],
};

const BASE_AUTOMATION = {
    plansManual: 5,
    plansScript: 3,
    plansIntegration: 1,
    plansScheduledActive: 4,
    overdueScheduled: 0,
};

const BASE_PROPS = {
    period: 30,
    passRuns: 8,
    failRuns: 1,
    inconclusiveRuns: 1,
    automation: BASE_AUTOMATION,
    upcoming: [] as DashboardUpcomingItem[],
    trend: BASE_TREND,
};

beforeEach(() => {
    sparklineSpy.mockReset();
});

// ─── 2. Overdue list ───────────────────────────────────────────────

describe('TestDashboardG2Section — overdue list', () => {
    test('renders only daysUntilRun < 0 items, sorted most-overdue-first', () => {
        const upcoming = [
            makeUpcoming({ planId: 'p-future', daysUntilRun: 3 }),
            makeUpcoming({
                planId: 'p-overdue-2',
                planName: 'Overdue 2 days',
                daysUntilRun: -2,
            }),
            makeUpcoming({
                planId: 'p-overdue-7',
                planName: 'Overdue 7 days',
                daysUntilRun: -7,
            }),
        ];
        render(
            <TestDashboardG2Section
                {...BASE_PROPS}
                upcoming={upcoming}
                automation={{ ...BASE_AUTOMATION, overdueScheduled: 2 }}
            />,
        );

        // Future row not present.
        expect(
            screen.queryByTestId('test-dashboard-g2-overdue-row-p-future'),
        ).not.toBeInTheDocument();

        // Overdue rows are present, in order.
        const sevenDay = screen.getByTestId(
            'test-dashboard-g2-overdue-row-p-overdue-7',
        );
        const twoDay = screen.getByTestId(
            'test-dashboard-g2-overdue-row-p-overdue-2',
        );
        expect(sevenDay).toBeInTheDocument();
        expect(twoDay).toBeInTheDocument();

        // 7-day row appears before 2-day row in the DOM.
        const allOverdueRows = Array.from(
            document.querySelectorAll(
                '[data-testid^="test-dashboard-g2-overdue-row-"]',
            ),
        );
        expect(allOverdueRows[0]).toBe(sevenDay);
        expect(allOverdueRows[1]).toBe(twoDay);

        // The "Xd overdue" copy uses absolute days.
        expect(sevenDay).toHaveTextContent('7d overdue');
        expect(twoDay).toHaveTextContent('2d overdue');

        // Each overdue row links to the test-plan detail page.
        const link = sevenDay as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe(
            '/t/acme/controls/c-1/tests/p-overdue-7',
        );
    });

    test('shows "+N more" affordance when overdueScheduled exceeds visible rows', () => {
        const overdueRows = Array.from({ length: 7 }, (_, i) =>
            makeUpcoming({ planId: `p-${i}`, daysUntilRun: -(i + 1) }),
        );
        render(
            <TestDashboardG2Section
                {...BASE_PROPS}
                upcoming={overdueRows}
                automation={{ ...BASE_AUTOMATION, overdueScheduled: 12 }}
            />,
        );
        // The component renders the first 5; the "+N more" line
        // accounts for the remaining (12 total - 5 visible) = 7.
        expect(screen.getByText(/\+ 7 more/)).toBeInTheDocument();
    });

    test('overdue empty-state copy distinguishes "none scheduled" from "all on track"', () => {
        // No scheduled plans at all → onboarding hint
        const { rerender } = render(
            <TestDashboardG2Section
                {...BASE_PROPS}
                automation={{
                    ...BASE_AUTOMATION,
                    plansScheduledActive: 0,
                    overdueScheduled: 0,
                }}
            />,
        );
        expect(
            screen.getByText(/Schedule a plan from its detail page/i),
        ).toBeInTheDocument();

        // Scheduled but all on time → success state
        rerender(
            <TestDashboardG2Section
                {...BASE_PROPS}
                automation={{
                    ...BASE_AUTOMATION,
                    plansScheduledActive: 3,
                    overdueScheduled: 0,
                }}
            />,
        );
        expect(
            screen.getByText(/All scheduled plans are on track/i),
        ).toBeInTheDocument();
    });

    test('overdue badge is danger-coloured when count > 0', () => {
        const upcoming = [
            makeUpcoming({ planId: 'p-1', daysUntilRun: -3 }),
        ];
        render(
            <TestDashboardG2Section
                {...BASE_PROPS}
                upcoming={upcoming}
                automation={{ ...BASE_AUTOMATION, overdueScheduled: 1 }}
            />,
        );
        const badge = screen.getByTestId('test-dashboard-g2-overdue-count');
        // PR-2: <StatusBadge variant="error"> replaces the legacy
        // <span className="badge badge-danger">.
        // R9-PR11 (2026-05-11): StatusBadge default tone flipped
        // `solid` → `subtle` (Dell light treatment). The error
        // variant now renders `bg-bg-subtle text-content-error`
        // by default — the canonical token is the text color, not
        // the background. If a future PR explicitly re-passes
        // `tone="solid"` here, the bg-bg-error assertion comes
        // back.
        expect(badge).toHaveClass('text-content-error');
        expect(badge).toHaveTextContent('1');
    });
});

// ─── 3. Sparkline ──────────────────────────────────────────────────

describe('TestDashboardG2Section — trend sparkline', () => {
    test('passes per-day TimeSeriesPoint[] to MiniAreaChart', () => {
        render(<TestDashboardG2Section {...BASE_PROPS} />);

        expect(sparklineSpy).toHaveBeenCalledTimes(1);
        const props = sparklineSpy.mock.calls[0][0] as {
            data: Array<{ date: Date; value: number }>;
            variant: string;
        };
        expect(props.variant).toBe('brand');
        // Three days, totals = pass + fail + inconclusive per day:
        // [1+0+0, 0+1+0, 2+0+1] = [1, 1, 3]
        expect(props.data.map((p) => p.value)).toEqual([1, 1, 3]);
        expect(props.data[0].date).toBeInstanceOf(Date);
    });

    test('renders the empty-state when every day has zero runs', () => {
        render(
            <TestDashboardG2Section
                {...BASE_PROPS}
                trend={{
                    days: ['2026-05-01', '2026-05-02'],
                    pass: [0, 0],
                    fail: [0, 0],
                    inconclusive: [0, 0],
                }}
            />,
        );
        expect(sparklineSpy).not.toHaveBeenCalled();
        expect(screen.getByText(/No runs to chart yet/i)).toBeInTheDocument();
    });
});

// ─── 4. Section header ────────────────────────────────────────────

describe('TestDashboardG2Section — header summary line', () => {
    test('summarises plan-counts: scheduled, manual, automated', () => {
        render(<TestDashboardG2Section {...BASE_PROPS} />);
        // 4 scheduled • 5 manual • (3 SCRIPT + 1 INTEGRATION) = 4 automated
        expect(
            screen.getByText(/4 scheduled • 5 manual • 4 automated/),
        ).toBeInTheDocument();
    });
});
