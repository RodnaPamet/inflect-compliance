/**
 * The web-vitals callback must keep ONE identity across renders.
 *
 * `useReportWebVitals` is `useEffect(…, [reportWebVitalsFn])` — the callback IS
 * the dependency. An inline arrow is a new identity every render, so the effect
 * re-runs, re-subscribes, and `web-vitals` REPLAYS an already-finalised metric
 * to the late subscriber. One real measurement then arrives repeatedly.
 *
 * This is not hypothetical. Measured in production: five TTFB beacons carrying
 * the identical value `1955.1` ms, three hours apart, on four different routes
 * — five distinct log entries, one document's TTFB. Of eleven TTFB samples in
 * thirty days, five were that one replayed value.
 *
 * TTFB is where it showed because Next passes `reportSoftNavs: true` to onCLS,
 * onLCP, onINP and onFCP but NOT to onTTFB: those four legitimately emit per
 * soft navigation, so a duplicate hides among hundreds. The defect was never
 * TTFB-specific.
 *
 * WHAT THIS ASSERTS IS THE IDENTITY, NOT A BEACON COUNT. Counting beacons would
 * pass trivially — the real `web-vitals` replay happens inside a library this
 * test does not run, and a stub that does not replay cannot express the failure.
 * The identity is the thing the hook's dependency array reads, so it is the
 * thing that decides whether a re-subscribe happens at all.
 */

import { render } from '@testing-library/react';

const seen: unknown[] = [];

jest.mock('next/web-vitals', () => ({
    useReportWebVitals: (fn: unknown) => {
        seen.push(fn);
    },
}));

jest.mock('@/lib/observability/client-telemetry', () => ({
    beaconClientMetric: jest.fn(),
}));

import { WebVitalsReporter } from '@/components/observability/WebVitalsReporter';

describe('WebVitalsReporter', () => {
    beforeEach(() => {
        seen.length = 0;
    });

    it('hands useReportWebVitals the SAME function across re-renders', () => {
        const { rerender } = render(<WebVitalsReporter />);
        rerender(<WebVitalsReporter />);
        rerender(<WebVitalsReporter />);

        // The denominator, so a component that stopped calling the hook at all
        // cannot pass this by producing an empty set.
        expect(seen.length).toBe(3);
        expect(new Set(seen).size).toBe(1);
    });

    it('still reports a metric through the beacon', () => {
        // The stable identity must not come at the cost of the callback working:
        // a `useCallback` whose body was dropped would pass the test above.
        render(<WebVitalsReporter />);
        const report = seen[0] as (m: { name: string; value: number }) => void;
        report({ name: 'TTFB', value: 1955.1 });

        const { beaconClientMetric } = jest.requireMock(
            '@/lib/observability/client-telemetry',
        ) as { beaconClientMetric: jest.Mock };
        expect(beaconClientMetric).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'TTFB', value: 1955.1 }),
        );
    });
});
