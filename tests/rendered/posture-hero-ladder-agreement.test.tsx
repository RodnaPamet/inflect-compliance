/**
 * The hero's dial and the list beneath it must tell ONE story.
 *
 * The reported bug: a tenant with 18 overdue tasks saw Tasks plotted on
 * the radar's OUTER ring — reading as level 5, "perfect" — while the list
 * directly beneath it said L4 and the narrative said 18 overdue. Three
 * surfaces, three answers.
 *
 * Root cause: the dial plotted the raw percentage (97%) against rings
 * spaced evenly across 0-100 (20/40/60/80/100), while the ladder's floors
 * are 50/75/90/100. "Ring N = level N" was never true — only the ring
 * COUNT matched. The fix plots the level itself, so the two surfaces
 * cannot drift apart again.
 *
 * This test renders the real hero with the reported numbers and asserts
 * the dial and the list agree, geometrically and textually.
 */
import * as React from 'react';
import { render, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

// jsdom does no layout, so the chart's auto-sizer always measures 0×0 —
// feed it a real box or the ready branch never renders its SVG.
jest.mock('@visx/responsive', () => ({
    ParentSize: ({
        children,
    }: {
        children: (size: { width: number; height: number }) => React.ReactNode;
    }) => <>{children({ width: 340, height: 288 })}</>,
}));

import { PostureHeroCard } from '@/app/t/[tenantSlug]/(app)/dashboard/PostureHeroCard';
import { ratePostureAxes, toRadarAxes, POSTURE_LADDER } from '@/lib/charts/posture-radar';
import type { ExecutiveDashboardPayload } from '@/app-layer/repositories/DashboardRepository';
import messages from '@/../messages/en.json';

/** The reported tenant: 600 tasks, 18 of them overdue. */
function reportedPayload(): ExecutiveDashboardPayload {
    return {
        stats: {} as ExecutiveDashboardPayload['stats'],
        controlCoverage: {
            total: 40,
            applicable: 40,
            implemented: 20,
            inProgress: 10,
            notStarted: 10,
            planned: 0,
            needsReview: 0,
            coveragePercent: 50,
        },
        riskBySeverity: { low: 8, medium: 2, high: 1, critical: 1 },
        riskByStatus: { open: 12, mitigating: 0, accepted: 0, closed: 0 },
        evidenceExpiry: { overdue: 1, dueSoon7d: 0, dueSoon30d: 3, noReviewDate: 0, current: 19 },
        policySummary: {
            total: 10,
            draft: 0,
            inReview: 0,
            approved: 0,
            published: 10,
            archived: 0,
            overdueReview: 0,
        },
        taskSummary: { total: 600, open: 100, inProgress: 0, blocked: 0, resolved: 500, overdue: 18 },
        vendorSummary: { total: 5, overdueReview: 0 },
        computedAt: '2026-08-04T00:00:00.000Z',
    };
}

const summary = {
    postureLabel: 'DEVELOPING' as const,
    maturityScore: 46,
    summaryText: 'Half the applicable controls are implemented and 18 tasks are overdue.',
    advice: [{ title: 'Clear the overdue tasks', detail: '18 are past due.', priority: 'high' as const }],
    provider: 'stub',
    model: null,
    generatedAt: '2026-08-04T00:00:00.000Z',
};

function renderHero() {
    const ratings = ratePostureAxes(reportedPayload(), (axis) => messages.dashboard.hero.radarAxes[axis]);
    const view = render(
        <NextIntlClientProvider locale="en" messages={messages}>
            <PostureHeroCard summary={summary} ratings={ratings} />
        </NextIntlClientProvider>,
    );
    return { ...view, ratings };
}

describe('posture hero — the dial and the list agree', () => {
    it('rates Tasks below the top rung while 18 are overdue', () => {
        const { ratings } = renderHero();
        const tasks = ratings.find((r) => r.key === 'tasks')!;
        // 582 of 600 healthy = 97%, which ROUNDS TO 100 — the exact trap.
        expect(tasks.value).toBe(97);
        expect(tasks.level).toBe(4);
    });

    it('plots Tasks on ring 4, not the outer ring', () => {
        const { ratings } = renderHero();
        const plotted = toRadarAxes(ratings).find((a) => a.key === 'tasks')!;
        expect(plotted.value).toBe(4);
        expect(plotted.value).toBeLessThan(POSTURE_LADDER.length);
    });

    it('shows the same level in the list as it plots on the dial', () => {
        const { ratings } = renderHero();
        const plotted = new Map(toRadarAxes(ratings).map((a) => [a.key, a.value]));
        for (const r of ratings) {
            if (r.level === null) continue;
            const row = document.querySelector(`[data-posture-axis="${r.key}"]`)!;
            expect(row).not.toBeNull();
            // The row's own level attribute, the level the chart plots, and
            // the "L<n>" the reader sees are all the same number.
            expect(row.getAttribute('data-posture-axis-level')).toBe(String(r.level));
            expect(plotted.get(r.key)).toBe(r.level);
            expect(within(row as HTMLElement).getByText(`L${r.level}`)).toBeInTheDocument();
        }
    });

    it('names the limiting component in the headline line', () => {
        renderHero();
        // Controls is 20/40 = 50% → level 2, the weakest rated axis here.
        const limited = document.querySelector('[data-posture-limited-by]')!;
        expect(limited.getAttribute('data-posture-limited-by')).toBe('controls');
        expect(limited.textContent).toMatch(/20 of 40/);
    });

    it('carries a runner-up bullet naming the next component to lift', () => {
        renderHero();
        const next = document.querySelector('[data-posture-next-axis]')!;
        expect(next).not.toBeNull();
        // Risk: 10 of 12 not high/critical = 83% → level 3, the runner-up
        // behind Controls.
        expect(next.getAttribute('data-posture-next-axis')).toBe('risk');
        expect(next.textContent).toMatch(/10 of 12/);
    });

    it('does not plot an unrated axis at all', () => {
        // Every axis here has an estate, so all six plot; the guard for the
        // unrated case lives in the unit suite. This asserts the count the
        // dial actually draws matches the rated rows in the list.
        const { ratings } = renderHero();
        const ratedRows = document.querySelectorAll('[data-posture-axis-level]');
        expect(toRadarAxes(ratings)).toHaveLength(ratedRows.length);
    });
});
