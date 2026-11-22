/**
 * `<FreshnessBadge>` rendered tests — Epic 43.2.
 *
 * Locks the badge's UX contract:
 *   - level + age label render correctly for each band
 *   - data-freshness attribute exposes the level for E2E hooks
 *   - the unknown branch renders cleanly when timestamp is missing
 *   - compact mode drops the trailing label
 *   - role="status" + aria-label give screen readers the level + age
 */

import { render, screen } from '@testing-library/react';
import * as React from 'react';

import { FreshnessBadge } from '@/components/ui/FreshnessBadge';

const NOW = new Date('2026-04-30T12:00:00Z');
const daysAgo = (n: number) =>
    new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe('<FreshnessBadge>', () => {
    it('renders Fresh state for recent timestamps', () => {
        render(
            <FreshnessBadge
                lastRefreshedAt={daysAgo(5)}
                now={NOW}
                data-testid="fb"
            />,
        );
        const badge = screen.getByTestId('fb');
        expect(badge.getAttribute('data-freshness')).toBe('fresh');
        expect(badge.textContent).toMatch(/Fresh/);
        expect(badge.textContent).toMatch(/5d ago/);
    });

    it('renders Stale state in the 30–90d band', () => {
        render(
            <FreshnessBadge
                lastRefreshedAt={daysAgo(45)}
                now={NOW}
                data-testid="fb"
            />,
        );
        const badge = screen.getByTestId('fb');
        expect(badge.getAttribute('data-freshness')).toBe('stale');
        expect(badge.textContent).toMatch(/Stale/);
    });

    it('renders Outdated for 90+ days', () => {
        render(
            <FreshnessBadge
                lastRefreshedAt={daysAgo(180)}
                now={NOW}
                data-testid="fb"
            />,
        );
        const badge = screen.getByTestId('fb');
        expect(badge.getAttribute('data-freshness')).toBe('outdated');
        expect(badge.textContent).toMatch(/Outdated/);
    });

    it('renders the unknown state when timestamp is missing', () => {
        render(<FreshnessBadge lastRefreshedAt={null} data-testid="fb" />);
        const badge = screen.getByTestId('fb');
        expect(badge.getAttribute('data-freshness')).toBe('unknown');
        expect(badge.textContent).toMatch(/No refresh recorded/);
    });

    it('compact mode drops the trailing label', () => {
        render(
            <FreshnessBadge
                lastRefreshedAt={daysAgo(3)}
                now={NOW}
                compact
                data-testid="fb"
            />,
        );
        const badge = screen.getByTestId('fb');
        expect(badge.textContent).not.toMatch(/Fresh/);
        expect(badge.textContent).toMatch(/3d ago/);
    });

    it('exposes role=status with the level + age in the aria-label', () => {
        render(
            <FreshnessBadge
                lastRefreshedAt={daysAgo(10)}
                now={NOW}
                data-testid="fb"
            />,
        );
        const badge = screen.getByTestId('fb');
        expect(badge.getAttribute('role')).toBe('status');
        expect(badge.getAttribute('aria-label')).toMatch(
            /Freshness: Fresh, 10d ago/,
        );
    });

    it('switches band when custom thresholds are passed', () => {
        // 8d ago is fresh under defaults but stale under {7,30}.
        render(
            <FreshnessBadge
                lastRefreshedAt={daysAgo(8)}
                warnAfterDays={7}
                staleAfterDays={30}
                now={NOW}
                data-testid="fb"
            />,
        );
        expect(screen.getByTestId('fb').getAttribute('data-freshness')).toBe(
            'stale',
        );
    });
});

/**
 * The tint and border are colour utilities Tailwind actually generates
 * (#5309). `bg-success` / `border-success` name no colour in the config — the
 * status colours live under `bg.*` and `border.*` — so the pill rendered
 * transparent with a currentColor border, and the contrast its comment claims
 * was measured against a tint that never painted.
 */
describe('<FreshnessBadge> colour utilities resolve', () => {
    const colors = require('../../tailwind.config.js').theme.extend.colors as Record<string, unknown>;
    /** `bg-bg-success` → colors.bg.success; `border-border-error` → colors.border.error. */
    function resolves(utility: string, prefix: 'bg-' | 'border-'): boolean {
        const [group, ...rest] = utility.slice(prefix.length).split('-');
        const scale = colors[group];
        return typeof scale === 'object' && scale !== null && rest.join('-') in scale;
    }

    it.each([
        ['fresh', 5],
        ['stale', 45],
        ['outdated', 120],
    ])('%s paints a tint and a border from the theme', (level, age) => {
        render(<FreshnessBadge lastRefreshedAt={daysAgo(age)} now={NOW} data-testid="fb" />);
        const badge = screen.getByTestId('fb');
        expect(badge.getAttribute('data-freshness')).toBe(level);
        const classes = badge.className.split(/\s+/);
        const tint = classes.filter((c) => c.startsWith('bg-'));
        const edge = classes.filter((c) => c.startsWith('border-') && c !== 'border');
        expect(tint).toHaveLength(1);
        expect(edge).toHaveLength(1);
        expect(resolves(tint[0], 'bg-')).toBe(true);
        expect(resolves(edge[0], 'border-')).toBe(true);
    });
});

