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
 * Renders nothing. Uses `navigator.sendBeacon` so reports survive the page
 * unload that often coincides with navigation (falls back to a keepalive
 * fetch). Best-effort — every failure is swallowed. Inert in E2E test mode.
 */

import { useReportWebVitals } from 'next/web-vitals';

export function WebVitalsReporter() {
    useReportWebVitals((metric) => {
        // Don't beacon during Playwright runs (noise + the sink would log
        // per-test). NEXT_PUBLIC_TEST_MODE is inlined at build time.
        if (process.env.NEXT_PUBLIC_TEST_MODE === '1') return;
        try {
            const body = JSON.stringify({
                name: metric.name,
                value: metric.value,
                rating: (metric as { rating?: string }).rating,
                navigationType: (metric as { navigationType?: string }).navigationType,
                route:
                    typeof window !== 'undefined' ? window.location.pathname : '/',
            });
            const url = '/api/telemetry/vitals';
            if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
                navigator.sendBeacon(
                    url,
                    new Blob([body], { type: 'application/json' }),
                );
            } else {
                void fetch(url, {
                    method: 'POST',
                    body,
                    keepalive: true,
                    headers: { 'content-type': 'application/json' },
                });
            }
        } catch {
            // Best-effort — never let telemetry break the page.
        }
    });
    return null;
}
