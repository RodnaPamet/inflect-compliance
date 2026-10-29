/**
 * E2E — A SYNTHETIC CORE WEB VITALS BASELINE FOR THE THREE REAL ROUTES (#3547).
 *
 * READ-ONLY: it navigates and measures, and creates nothing. So it uses the
 * SHARED seeded tenant via `loginAndGetTenant` / `DEFAULT_USER` — it needs a
 * tenant with data in it, which is the whole point of measuring.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A GATE ────────────────────────────
 *
 * #3547 asked whether the app is slow, and production RUM cannot answer it.
 * Measured over 30 days: 2,597 `web_vital` rows, of which 2,440 — 93% — came
 * from ONE 4.5-hour window on one container. The row count rose; the number of
 * independent observations did not. Beacons are demonstrably not being lost
 * (2,440 arrived in an afternoon), so the shortfall is real sessions, and no
 * engineering produces those.
 *
 * So the baseline is taken here instead, where a session can be created on
 * demand. Owner decision, 2026-10-29: a synthetic baseline rather than waiting
 * for traffic.
 *
 * It REPORTS and does not gate. There is no agreed budget for these routes, and
 * inventing one in the same change that first measures them would be a ceiling
 * fitted to a single sample — the error #3547 spent three comments unwinding.
 * What it DOES fail on is a route that did not render, because a page that
 * never painted reports no LCP at all, and "no LCP" is indistinguishable from
 * "fast" in a file of numbers.
 *
 * ── WHY NOT LIGHTHOUSE ───────────────────────────────────────────────────
 *
 * The owner's choice was a synthetic baseline; Lighthouse was the mechanism I
 * suggested, and I did not use it. Three reasons, in order of weight:
 *
 *   1. COMPARABILITY. The figures on #3547 are field LCP / FCP / TTFB / CLS
 *      from `web-vitals` via `useReportWebVitals`. This spec reads the SAME
 *      definitions out of the same browser APIs, so a number here sits beside
 *      a number there. A Lighthouse performance score answers a related but
 *      different question and cannot be compared with either.
 *   2. No new dependency. This repo gates `npm audit` on MODERATE+ for
 *      production deps and runs Trivy on the image; adding a tool with
 *      Lighthouse's dependency tree to measure three pages is a poor trade.
 *   3. The harness already exists. `playwright.config.ts` boots the app with
 *      `next start` — a PRODUCTION build — and logs in against a seeded
 *      tenant. A dev-mode measurement would have been worthless, and this is
 *      not one.
 *
 * If a Lighthouse score is wanted later, it is additive rather than a
 * replacement: it would answer "what does the audit say", not "what did the
 * user's browser record".
 *
 * ── READING THE OUTPUT ───────────────────────────────────────────────────
 *
 * One `[cwv]` line per route on stdout, and a JSON artifact at
 * `test-results/cwv-baseline.json`. One run of one browser on one machine is a
 * sample of one: it bounds nothing and it is not a distribution. Its use is the
 * same as the field data's — the observation that no sample is fast, or that
 * every sample is.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { loginAndGetTenant } from './e2e-utils';

/** The three routes #3547 observed in production, and nothing else. */
const ROUTES = [
    { name: 'dashboard', path: (t: string) => `/t/${t}/dashboard` },
    { name: 'processes', path: (t: string) => `/t/${t}/processes` },
    { name: 'admin/integrations', path: (t: string) => `/t/${t}/admin/integrations` },
] as const;

interface Vitals {
    /** Largest Contentful Paint, ms from navigation start. */
    lcp: number | null;
    /** First Contentful Paint, ms. */
    fcp: number | null;
    /** Time to First Byte — `responseStart`, ms. */
    ttfb: number | null;
    /** Cumulative Layout Shift, unitless. */
    cls: number | null;
    /** `loadEventEnd`, ms — the coarse "page finished" number. */
    load: number | null;
    /** How many LCP candidates the observer saw. 0 means nothing painted. */
    lcpCandidates: number;
}

/**
 * Buffered observers, installed BEFORE any navigation.
 *
 * `buffered: true` matters: LCP and FCP entries are emitted before any script
 * of ours could have run, so an observer registered after load sees an empty
 * list and reports `null` for a page that painted perfectly well.
 */
const OBSERVER_INIT = `
(() => {
  const w = window;
  if (w.__cwv) return;
  w.__cwv = { lcp: null, lcpCandidates: 0, cls: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__cwv.lcpCandidates += 1;
        // LCP is the LAST candidate, not the first — a late hero image
        // legitimately replaces an early text block.
        w.__cwv.lcp = e.startTime;
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { /* unsupported: stays null, reported as null */ }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // Shifts with recent input are excluded, as the metric defines.
        if (!e.hadRecentInput) w.__cwv.cls += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch (e) { /* unsupported: CLS stays 0 */ }
})();
`;

const results: Array<{ route: string; vitals: Vitals }> = [];

test.describe('synthetic Core Web Vitals baseline (#3547)', () => {
    test('measures the three routes production RUM could not', async ({ page }) => {
        await page.addInitScript(OBSERVER_INIT);
        const tenant = await loginAndGetTenant(page);

        for (const route of ROUTES) {
            const url = route.path(tenant);

            // A full navigation, not a client-side transition: the field
            // beacons that #3547 reports are overwhelmingly soft navigations,
            // and a soft nav has no TTFB of its own to compare.
            await page.goto(url, { waitUntil: 'load' });

            // Let late candidates land. LCP is only final at the first
            // interaction or when the page is hidden, so a lab reading is
            // "the largest so far" — settling first is what makes it stable
            // rather than whichever paint happened to be last at `load`.
            await page.waitForLoadState('networkidle').catch(() => {
                // A page that polls never reaches networkidle. That is not a
                // failure of the measurement — fall through to the settle.
            });
            await page.waitForTimeout(1500);

            const vitals = await page.evaluate<Vitals>(() => {
                const w = window as unknown as {
                    __cwv?: { lcp: number | null; lcpCandidates: number; cls: number };
                };
                const nav = performance.getEntriesByType('navigation')[0] as
                    | PerformanceNavigationTiming
                    | undefined;
                const fcpEntry = performance
                    .getEntriesByName('first-contentful-paint')
                    .at(0) as PerformanceEntry | undefined;
                const c = w.__cwv;
                return {
                    lcp: c?.lcp ?? null,
                    fcp: fcpEntry ? fcpEntry.startTime : null,
                    ttfb: nav ? nav.responseStart : null,
                    cls: c ? c.cls : null,
                    load: nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : null,
                    lcpCandidates: c?.lcpCandidates ?? 0,
                };
            });

            results.push({ route: route.name, vitals });

            const n = (v: number | null) => (v === null ? 'n/a' : Math.round(v).toString());
            console.log(
                `[cwv] ${route.name.padEnd(20)} ` +
                    `LCP=${n(vitals.lcp).padStart(6)}ms  ` +
                    `FCP=${n(vitals.fcp).padStart(6)}ms  ` +
                    `TTFB=${n(vitals.ttfb).padStart(6)}ms  ` +
                    `CLS=${vitals.cls === null ? 'n/a' : vitals.cls.toFixed(3)}  ` +
                    `load=${n(vitals.load).padStart(6)}ms  ` +
                    `(${vitals.lcpCandidates} LCP candidates)`,
            );

            // THE VACUITY GUARD, and the only thing this spec fails on.
            //
            // A route that errored or rendered nothing reports `lcp: null` and
            // `lcpCandidates: 0`, which in a file of numbers reads exactly like
            // a page too fast to measure. So the measurement asserts it
            // measured something: a paint happened, and the document answered.
            //
            // This is the same rule as the recertification subsystem's "zero is
            // never complete" — a baseline over nothing evidences nothing.
            expect(
                vitals.lcpCandidates,
                `${route.name} painted no LCP candidate — the page did not render, ` +
                    `so its vitals are absent rather than fast`,
            ).toBeGreaterThan(0);
            expect(vitals.ttfb, `${route.name} reported no TTFB`).not.toBeNull();
            expect(vitals.ttfb as number).toBeGreaterThan(0);
        }

        // Every route measured, or the artifact would describe a subset while
        // looking complete.
        expect(results).toHaveLength(ROUTES.length);

        const dir = path.join(process.cwd(), 'test-results');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'cwv-baseline.json'),
            JSON.stringify(
                {
                    issue: 3547,
                    kind: 'synthetic-lab-sample',
                    // Named so nobody reads the file as a distribution.
                    caveat:
                        'One run, one browser, one machine. A sample of one: ' +
                        'comparable in DEFINITION to the production web_vital ' +
                        'beacons, not in population.',
                    measuredAt: new Date().toISOString(),
                    routes: results,
                },
                null,
                2,
            ),
        );
    });
});
