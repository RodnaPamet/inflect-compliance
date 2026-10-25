/**
 * Core Web Vitals reporter.
 *
 * `useReportWebVitals` (next/web-vitals, no extra dependency) fires a callback
 * as each metric finalizes: the Core Web Vitals (LCP / INP / CLS / FCP / TTFB).
 *
 * THE CALLBACK MUST BE STABLE, AND THAT IS NOT A TIDINESS POINT.
 * `useReportWebVitals` is `useEffect(…, [reportWebVitalsFn])` — the function
 * IS the dependency. An inline arrow is a new identity on every render, so the
 * effect re-runs and re-subscribes each time, and `web-vitals` REPLAYS an
 * already-finalised metric to a late subscriber. For the per-document metrics
 * that means one real measurement is emitted again and again.
 *
 * It was measured in production before this was fixed: five TTFB beacons
 * carrying the identical value `1955.1` ms, three hours apart, on four
 * different routes — five distinct log entries, one document's TTFB. Of the
 * eleven TTFB samples in thirty days, five were that one replayed value, so a
 * metric with n=11 really had six distinct measurements, and nine of the
 * eleven read `poor`. Conclusions were being drawn from it (see #3547).
 *
 * Why only TTFB showed it: Next passes `reportSoftNavs: true` to onCLS, onLCP,
 * onINP and onFCP but NOT to onTTFB, so those four legitimately emit per soft
 * navigation and a duplicate is invisible among hundreds. TTFB is once per
 * document, so every extra one is a duplicate. The bug was never TTFB-specific.
 *
 * THE ROUTE IS READ AT EMISSION, which is right for a metric that finalises
 * while you are on the page and wrong for a replayed one — a replay is labelled
 * with wherever the user has since navigated. Stabilising the callback is what
 * removes the replay, and therefore the misattribution; the `route` read is
 * unchanged.
 *
 * On Next 16.4.2 `useReportWebVitals` subscribes to those six callbacks only.
 * It never registers a listener for custom performance measures, so the three
 * `Next.js-*` navigation metrics CANNOT arrive in this App-Router app — see the
 * KNOWN_VITALS note in `lib/observability/web-vitals.ts`, which is load-bearing
 * for anyone sizing a navigation change.
 */

'use client';

import { useCallback } from 'react';
import { useReportWebVitals } from 'next/web-vitals';

import { beaconClientMetric } from '@/lib/observability/client-telemetry';

export function WebVitalsReporter() {
    // Empty dependency list: nothing in the body closes over a value that can
    // change, so one identity for the component's lifetime is correct — and it
    // is what keeps `useReportWebVitals`'s effect from re-subscribing.
    const report = useCallback((metric: { name: string; value: number }) => {
        beaconClientMetric({
            name: metric.name,
            value: metric.value,
            rating: (metric as { rating?: string }).rating,
            navigationType: (metric as { navigationType?: string }).navigationType,
            // Present at runtime in web-vitals 6.2.3 (and in Next's bundled copy,
            // which is the one that runs) but absent from this install's .d.ts, so
            // it is read through a cast exactly as `rating` and `navigationType` are.
            navigationId: (metric as { navigationId?: string | number }).navigationId,
            route: typeof window !== 'undefined' ? window.location.pathname : '/',
        });
    }, []);

    useReportWebVitals(report);
    return null;
}
