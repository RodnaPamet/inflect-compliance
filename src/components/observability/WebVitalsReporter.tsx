'use client';

/**
 * WebVitalsReporter — beacons browser web-vitals to `/api/telemetry/vitals`.
 *
 * `useReportWebVitals` (next/web-vitals, no extra dependency) fires a callback
 * as each metric finalizes: the Core Web Vitals (LCP / INP / CLS / FCP / TTFB).
 * Each sample carries the current pathname so the server can attribute timing
 * per route.
 *
 * IT DOES NOT DELIVER AN IN-APP-NAVIGATION SIGNAL, which an earlier version of
 * this comment claimed it did by naming `Next.js-hydration`,
 * `Next.js-route-change-to-render` and `Next.js-render` as "the
 * in-app-navigation 'feels slow' signal". On Next 16.3.6 `useReportWebVitals`
 * subscribes to the six Core Web Vitals and nothing else, and those three
 * measures come from the Pages router bootstrap, which this App-Router-only app
 * never loads. The sink still allowlists the names; see the note on
 * `KNOWN_VITALS` in src/lib/observability/web-vitals.ts for the full
 * derivation and for why they are kept.
 *
 * This mattered: #3099 needed a navigation-latency number to size the sidebar
 * prefetch trade, and this component reads as though it had been collecting one
 * all along.
 *
 * Renders nothing. The send itself — `navigator.sendBeacon` so reports survive
 * the page unload that often coincides with navigation, a keepalive fetch
 * fallback, the `NEXT_PUBLIC_TEST_MODE` gate and the swallowing catch — moved
 * to `@/lib/observability/client-telemetry` when #3099 added a second producer
 * (`useGuardedPush`'s dropped-navigation counter). It was the app's entire
 * client-side telemetry path and it was reachable only by rendering this
 * component; two copies of it would have been two gates to forget.
 */

import { useReportWebVitals } from 'next/web-vitals';

import { beaconClientMetric } from '@/lib/observability/client-telemetry';

export function WebVitalsReporter() {
    useReportWebVitals((metric) => {
        beaconClientMetric({
            name: metric.name,
            value: metric.value,
            rating: (metric as { rating?: string }).rating,
            navigationType: (metric as { navigationType?: string }).navigationType,
            route: typeof window !== 'undefined' ? window.location.pathname : '/',
        });
    });
    return null;
}
