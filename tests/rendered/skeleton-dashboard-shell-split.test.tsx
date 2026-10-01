/**
 * The compliance dashboard's loading shell is route-local, and the
 * generic one stayed in the primitives module.
 *
 * `DashboardSkeleton` used to live in `src/components/ui/skeleton.tsx`,
 * beside `Skeleton`, `SkeletonTable` and the rest. Those are primitives
 * — shapes with no opinion about what they stand in for. That one is
 * not: it is a tracing of ONE page's sections, in that page's order,
 * and the only thing that can tell you it has gone stale is the page it
 * sits next to. Keeping it there meant the module defining "what a
 * loading bar looks like" also hard-coded this product's dashboard IA,
 * so every consumer of a plain `<Skeleton>` imported a file that knew
 * about posture heroes and expiry calendars.
 *
 * Two components with confusable names are in play, and the move is
 * only correct if BOTH facts hold — hence both are rendered here:
 *
 *   `DashboardSkeleton`  the compliance dashboard's shell → moved to
 *                        the route
 *   `SkeletonDashboard`  the generic list-dashboard shell the
 *                        risks/controls/vendors pages share → stays a
 *                        primitive
 *
 * Asserting only the first would pass if the second had been deleted
 * along with it; asserting only the second would pass if the first had
 * never been moved. The companion static checks are in
 * `tests/guards/state-coverage.test.ts` (it exists at the new path,
 * `skeleton.tsx` no longer exports it) and
 * `tests/guards/dashboard-compute-render-gap.test.ts` (the route's
 * `loading.tsx` imports it locally).
 */
import * as React from 'react';
import { render } from '@testing-library/react';

import { DashboardSkeleton } from '@/app/t/[tenantSlug]/(app)/dashboard/DashboardSkeleton';
import { SkeletonDashboard } from '@/components/ui/skeleton';

/** Every bar the shimmer primitive paints carries this surface token. */
const BAR = '.bg-bg-subtle';

describe('<DashboardSkeleton> — the route-local compliance shell', () => {
    test('renders a banded shell, not a single block', () => {
        const { container } = render(<DashboardSkeleton />);
        const root = container.firstElementChild as HTMLElement;
        // The IA is mirrored as bands, which is the whole reason a
        // bespoke shell exists instead of one grey rectangle.
        expect(root).toHaveClass('space-y-section');
        // A real count rather than "more than zero": the shipped layout
        // is nine bands (header, hero, KPI grid, four two-up rows, the
        // heatmap/calendar row, trend, next-best-action) and a shell
        // that silently lost most of them would still pass a
        // `>= 1` check.
        expect(root.children.length).toBeGreaterThanOrEqual(9);
        expect(container.querySelectorAll(BAR).length).toBeGreaterThan(20);
    });

    test('is decorative — the page it precedes owns the announcement', () => {
        const { container } = render(<DashboardSkeleton />);
        expect(container.firstElementChild).toHaveAttribute(
            'aria-hidden',
            'true',
        );
    });

    test('composes the shared primitives rather than re-deriving them', () => {
        // The split moved the LAYOUT out of the primitives module; it
        // did not fork the bars. If this shell had grown its own bar
        // recipe, the shimmer fix in `skeleton.tsx` would stop reaching
        // the dashboard — so the shared surface token is the tell.
        const { container } = render(<DashboardSkeleton />);
        const bars = container.querySelectorAll(BAR);
        expect(bars.length).toBeGreaterThan(0);
        for (const bar of Array.from(bars)) {
            // The shimmer sweep — the primitive's defining feature, and
            // the thing a forked local bar recipe would lack.
            expect(bar).toHaveClass('after:animate-shimmer-sweep');
            expect(bar).toHaveClass('motion-reduce:after:animate-none');
        }
    });
});

describe('<SkeletonDashboard> — the generic shell stays a primitive', () => {
    test('still renders from the primitives module', () => {
        const { container } = render(<SkeletonDashboard />);
        const root = container.firstElementChild as HTMLElement;
        expect(root).toHaveClass('space-y-section');
        expect(container.querySelectorAll(BAR).length).toBeGreaterThan(0);
    });

    test('announces itself as busy — it is the one with a label', () => {
        // The two shells differ here on purpose and it is the clearest
        // way to tell them apart in a diff: the generic one carries
        // `aria-busy` + a translated label, the route-local one is
        // purely decorative.
        const { container } = render(<SkeletonDashboard />);
        expect(container.firstElementChild).toHaveAttribute(
            'aria-busy',
            'true',
        );
    });

    test('the two are genuinely different components', () => {
        // The names are one transposition apart. If a future tidy-up
        // ever points one at the other, this is what notices.
        expect(SkeletonDashboard).not.toBe(DashboardSkeleton);
    });
});
