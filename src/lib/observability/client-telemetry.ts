/**
 * The browser → server telemetry beacon, and the metric names it may carry.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * The send logic lived inside `<WebVitalsReporter>` — `sendBeacon` with a
 * `keepalive` fetch fallback, a `NEXT_PUBLIC_TEST_MODE` gate, and a swallowing
 * `try/catch`. That is the whole client half of this app's RUM pipeline, and it
 * was reachable only by rendering a component that calls a Next hook. #3099
 * needed a second producer (a counter for a dropped row-click navigation), and
 * the choice was between a second copy of the send logic and lifting the one we
 * have. This is the lift: one URL, one payload shape, one gate, one catch.
 *
 * NOT A NEW SINK. The server side is unchanged — `/api/telemetry/vitals` →
 * `recordWebVital()` → a `web_vital` log line plus an OTel histogram. #3099's
 * own mechanism report asked for exactly this ("beaconed through the existing
 * `/api/telemetry/vitals` sink, which already normalises route labels and needs
 * no new infrastructure"), so adding an endpoint would have been inventing a
 * seam next to the one that works.
 *
 * ── NO `'use client'` DIRECTIVE, DELIBERATELY ────────────────────────────
 *
 * This module is SHARED, not client-only. `src/lib/observability/web-vitals.ts`
 * runs on the server and imports `NAV_PUSH_RETRY_METRIC` from here so the
 * allowlist and the producer cannot drift apart — one name, one definition,
 * asserted in `tests/unit/observability/web-vitals.test.ts`. A `'use client'`
 * directive would make that import cross a client boundary, which is the wrong
 * thing to do to a string constant. Nothing here touches `window` or
 * `navigator` outside a function body, and `beaconClientMetric` feature-detects
 * both, so importing it from a server module is inert rather than a crash.
 *
 * ── WHAT MAY BE CARRIED ──────────────────────────────────────────────────
 *
 * Shape, never content. `route` is a PATHNAME, collapsed server-side by
 * `normalizeVitalRoute` to `/t/[tenant]/<segments>`; callers must not put a row
 * id in it (see `NAV_PUSH_RETRY_METRIC` below for how that is arranged rather
 * than hoped for). There is no field for a payload, a label or a free-text
 * note, and that absence is the design: a span or a log line that leaves this
 * system carries operation shape only — the same rule
 * `tests/guards/flue-telemetry-carries-no-content.test.ts` enforces for the
 * agentic path's spans. That guard reads one module
 * (`src/lib/agentic/flue/telemetry.ts`) and so does not cover this file; the
 * rule it encodes still applies, and the way this type is shaped is how it is
 * honoured here.
 */

/** The one sink. Public, unauthenticated, always 204 — see its route handler. */
export const TELEMETRY_BEACON_URL = '/api/telemetry/vitals';

/**
 * `/api/telemetry/vitals`' allowlisted name for "a row-click `router.push` was
 * dropped during hydration and this client re-issued it" (#3099).
 *
 * The prefix matters: `LCP` / `INP` / … are the web-vitals library's names and
 * `Next.js-*` are the framework's, so a metric this app emits itself is marked
 * as such rather than squatting in either namespace.
 *
 * ONE SAMPLE PER RETRY. The value is the measured click→retry elapsed in ms, so
 * the histogram's COUNT is the number of dropped pushes and its distribution is
 * a sanity check on the grace window rather than a constant that could not move
 * if the timer broke. The route label is the LIST page the click started on,
 * never the destination — a detail pathname ends in the row id and this metric
 * must carry none.
 */
export const NAV_PUSH_RETRY_METRIC = 'Inflect-nav-push-retry';

export interface ClientMetricSample {
    /** Must be allowlisted by `isKnownVital()`, or the sink drops it silently. */
    name: string;
    /** Milliseconds, except CLS which is unitless. Non-finite values are dropped. */
    value: number;
    /** The 3-value CWV band, when the producer has one. */
    rating?: string;
    /** `navigate` / `reload` / `back-forward`, when the producer has one. */
    navigationType?: string;
    /** Raw pathname — collapsed to a bounded route label server-side. */
    route: string;
}

/**
 * Post one sample, best-effort.
 *
 * `sendBeacon` rather than `fetch`, because a navigation metric fires at the
 * moment the page is most likely to be torn down; `keepalive` is the fallback
 * for the browsers that lack it. Every failure is swallowed: telemetry that can
 * throw into a click handler is worse than telemetry that is missing.
 *
 * Inert under `NEXT_PUBLIC_TEST_MODE=1` (inlined at build time) so a Playwright
 * run does not log one `web_vital` line per test. That gate sits here, in the
 * one send path, rather than at each producer — a producer that forgets it is
 * indistinguishable from one that meant to opt out.
 */
export function beaconClientMetric(sample: ClientMetricSample): void {
    if (process.env.NEXT_PUBLIC_TEST_MODE === '1') return;
    try {
        const body = JSON.stringify(sample);
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
            navigator.sendBeacon(
                TELEMETRY_BEACON_URL,
                new Blob([body], { type: 'application/json' }),
            );
        } else if (typeof fetch !== 'undefined') {
            void fetch(TELEMETRY_BEACON_URL, {
                method: 'POST',
                body,
                keepalive: true,
                headers: { 'content-type': 'application/json' },
            });
        }
    } catch {
        // Best-effort — never let telemetry break the page.
    }
}
