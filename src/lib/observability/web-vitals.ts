/**
 * Web-vitals RUM sink (server side).
 *
 * The app had server-side request metrics (OTel `http.request.duration`) but
 * NO client-perceived page-load timing — so "the pages feel slow" couldn't be
 * measured per route or per phase. This records browser-reported Core Web
 * Vitals (LCP / INP / CLS / FCP / TTFB) so we can see WHICH page is slow
 * before optimizing. The three Next.js custom navigation metrics are also
 * allowlisted but CANNOT ARRIVE in this App-Router app — see the note on
 * KNOWN_VITALS, which is load-bearing for anyone sizing a navigation change.
 *
 * Two sinks, both best-effort:
 *   - a structured `web_vital` log line (always — visible without a collector);
 *   - an OTel histogram per metric (`web.vitals.<name>`), recorded only when
 *     an OTel SDK is registered (`metrics.getMeter` returns a no-op meter
 *     otherwise, so `.record()` is a zero-cost no-op when OTel is off).
 *
 * Cardinality is bounded deliberately: metric name is allowlisted, route is
 * normalized (tenant slug + ids collapsed), rating is the 3-value CWV band.
 * No per-tenant / per-user labels.
 */

import { metrics } from '@opentelemetry/api';
import { NAV_PUSH_RETRY_METRIC } from './client-telemetry';
import { log } from './logger';
import { normalizeVitalRoute } from './vital-route';

const METER_NAME = 'inflect-web-vitals';

/**
 * Allowlist — bounds metric-name label cardinality AND rejects junk posted to
 * the public `/api/telemetry/vitals` endpoint.
 *
 * THE THREE `Next.js-*` NAMES BELOW CANNOT ARRIVE IN THIS APP, and the
 * sentence they replace ("the Next.js custom navigation metrics that
 * `useReportWebVitals` emits") was wrong. Established on Next 16.3.6 by
 * reading the installed package, not its docs:
 *
 *   - `next/web-vitals`'s `useReportWebVitals` subscribes to SIX callbacks and
 *     only six — CLS, FID, LCP, INP, FCP, TTFB. It never registers a listener
 *     for custom performance measures.
 *   - The three `Next.js-*` measures are produced by the PAGES router client
 *     bootstrap (`next/dist/client/index.js`), which marks a route change and
 *     measures against that mark. Nothing under the app-router entry does.
 *   - Nothing in the installed `next/dist` reads `webVitalsCallbacks` at all.
 *   - This app has no `pages/` directory. It is App Router only.
 *
 * They are KEPT in the allowlist deliberately: an unmatched entry costs
 * nothing, removing them would redden the unit test that asserts them, and a
 * Pages route or a Next upgrade could make them live again. What is NOT safe
 * is reading their presence as evidence that in-app navigation latency is
 * being measured — it is not. #3099 needed exactly that number to size the
 * sidebar prefetch trade (see the comment next to `prefetch` in
 * src/components/layout/nav-item.tsx) and found no instrument producing it.
 *
 * So the in-app navigation signal here is currently INP alone, which finalises
 * on the next paint after the interaction — for a route with a `loading.tsx`
 * that paint is the skeleton, not the destination's content — and which is
 * attributed to whichever pathname is current when it finalises. It cannot
 * separate a prefetch hit from a miss. Measuring navigation latency needs a
 * new metric; it is not already here.
 */
const KNOWN_VITALS: ReadonlySet<string> = new Set([
    // Core Web Vitals (web-vitals lib, bundled by Next)
    'LCP', // Largest Contentful Paint  — load
    'INP', // Interaction to Next Paint — responsiveness
    'CLS', // Cumulative Layout Shift   — visual stability (unitless)
    'FCP', // First Contentful Paint    — load
    'TTFB', // Time to First Byte       — server/network
    // Next.js custom metrics. INERT under App Router on Next 16.3.6 — see the
    // docblock above. Kept so a Pages route or a Next upgrade is not a 400.
    'Next.js-hydration',
    'Next.js-route-change-to-render',
    'Next.js-render',
    // THIS APP'S OWN metric, and the first one here that is not a browser or
    // framework measurement: one sample per row-click `router.push` that the
    // client router dropped during hydration and `useGuardedPush` re-issued
    // (#3099). Not a navigation-latency metric and not the measurement the
    // docblock above says is missing — it is a FAILURE COUNT, which is the
    // number nobody had: #3099's defect was only ever visible as an E2E flake.
    // The name is imported, not retyped, so the producer and this allowlist
    // cannot drift into silent 400s.
    NAV_PUSH_RETRY_METRIC,
]);

export function isKnownVital(name: string): boolean {
    return KNOWN_VITALS.has(name);
}

/**
 * MOVED to `./vital-route` (#3547) and re-exported here, so every existing
 * importer and the Edge middleware share ONE normaliser.
 *
 * The denominator for these beacons is counted in middleware, which runs on
 * the Edge runtime and can import neither `@opentelemetry/api` nor the Node
 * logger this module uses. Two copies of the regex was the alternative: the
 * entire value of the denominator is that it carries the SAME label as the
 * numerator, and two copies are two things that drift apart.
 */
export { normalizeVitalRoute } from './vital-route';

// One histogram per metric name, lazily created. CLS is a unitless score;
// every other vital is milliseconds — so they must NOT share a histogram
// (bucket boundaries would be meaningless across mixed units).
const _histograms = new Map<string, ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']>>();

function vitalHistogram(name: string) {
    let h = _histograms.get(name);
    if (!h) {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        h = metrics.getMeter(METER_NAME).createHistogram(`web.vitals.${slug}`, {
            description: `Browser-reported web vital: ${name}`,
            unit: name === 'CLS' ? '1' : 'ms',
        });
        _histograms.set(name, h);
    }
    return h;
}

export interface WebVitalSample {
    name: string;
    value: number;
    rating?: string;
    /** Raw page pathname; normalized here. */
    route: string;
    navigationType?: string;
    /**
     * The navigation a metric HAPPENED FOR — `Metric.navigationId`, which
     * web-vitals documents as "particularly relevant for soft navigations where
     * the metric may be reported for a previous URL".
     *
     * Carried because it is the only field that separates a replayed metric from
     * a legitimate soft-navigation re-report, and those have opposite meanings
     * for a baseline. Same navigationId with more than one beacon at the same
     * value is a re-subscription replaying a buffered entry (see #4194 and
     * `bindReporter`'s per-subscription `prevValue`); a different navigationId is
     * the library doing its job.
     *
     * Without it, value equality is the only available proxy — and that proxy is
     * nearly exact for a continuous metric and catastrophically wrong for a
     * quantised one. De-duplicating INP by value collapses a frequency
     * distribution rather than removing duplicates, moving its p75 from 72 ms to
     * 176 ms, because the browser rounds interaction latency to 8 ms and
     * repeated values are the instrument working.
     *
     * LOG ONLY, never a metric label — it is unbounded, and the histogram's
     * three attributes are bounded deliberately.
     */
    navigationId?: number;
}

/**
 * Record one web-vital sample. Silently ignores unknown metric names and
 * non-finite values (the endpoint is public + best-effort).
 */
export function recordWebVital(sample: WebVitalSample): void {
    if (!isKnownVital(sample.name) || !Number.isFinite(sample.value)) return;
    const route = normalizeVitalRoute(sample.route);
    const rating =
        sample.rating === 'good' ||
        sample.rating === 'needs-improvement' ||
        sample.rating === 'poor'
            ? sample.rating
            : 'unknown';

    vitalHistogram(sample.name).record(sample.value, {
        'web.vital': sample.name,
        'http.route': route,
        'web.vital.rating': rating,
    });

    log('info', 'web_vital', {
        vital: sample.name,
        value: Math.round(sample.value * 1000) / 1000,
        rating,
        route,
        navigationType: sample.navigationType ?? null,
        navigationId: sample.navigationId ?? null,
    });
}

// ─── Lightweight per-IP beacon limiter ───────────────────────────────
// The sink is public + unauthenticated (beacons fire without credentials),
// so a generous fixed-window cap keeps a flood from spamming logs/metrics
// without throttling normal use (~8 vitals/page over a few navigations).
const BEACON_WINDOW_MS = 60_000;
const BEACON_MAX_PER_WINDOW = 240;
const _beaconHits = new Map<string, { count: number; resetAt: number }>();

export function acceptVitalBeacon(ip: string): boolean {
    const now = Date.now();
    const slot = _beaconHits.get(ip);
    if (!slot || now >= slot.resetAt) {
        _beaconHits.set(ip, { count: 1, resetAt: now + BEACON_WINDOW_MS });
        // Opportunistic sweep so the map can't grow unbounded.
        if (_beaconHits.size > 5000) {
            for (const [k, v] of _beaconHits) if (now >= v.resetAt) _beaconHits.delete(k);
        }
        return true;
    }
    if (slot.count >= BEACON_MAX_PER_WINDOW) return false;
    slot.count += 1;
    return true;
}
