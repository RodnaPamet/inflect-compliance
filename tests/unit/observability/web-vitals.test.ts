/**
 * Web-vitals RUM sink — recorder contract.
 *
 * Locks the cardinality + validation guarantees that keep the public
 * `/api/telemetry/vitals` endpoint safe and its metrics bounded:
 *   - only allowlisted metric names are accepted;
 *   - page pathnames normalize to a finite route label (tenant slug + ids
 *     collapsed) so per-tenant / per-row labels never explode cardinality;
 *   - junk (unknown names, non-finite values) is dropped without throwing;
 *   - the per-IP beacon limiter caps a flood but passes normal volume.
 */

import {
    isKnownVital,
    normalizeVitalRoute,
    recordWebVital,
    acceptVitalBeacon,
} from '@/lib/observability/web-vitals';
import { NAV_PUSH_RETRY_METRIC } from '@/lib/observability/client-telemetry';

describe('web-vitals recorder', () => {
    describe('isKnownVital — allowlist', () => {
        it('accepts the Core Web Vitals', () => {
            for (const n of ['LCP', 'INP', 'CLS', 'FCP', 'TTFB']) {
                expect(isKnownVital(n)).toBe(true);
            }
        });
        it('accepts the Next.js navigation metrics', () => {
            expect(isKnownVital('Next.js-hydration')).toBe(true);
            expect(isKnownVital('Next.js-route-change-to-render')).toBe(true);
            expect(isKnownVital('Next.js-render')).toBe(true);
        });
        it("accepts this app's own dropped-navigation counter, by its real name", () => {
            // The CLIENT↔SERVER seam for #3099's counter. The name is imported
            // from the producer's module, so a rename on either side reddens
            // here — whereas a hard-coded string would let the producer beacon
            // a name this allowlist silently drops, and a silently-dropped
            // metric is indistinguishable from a defect that never happens.
            expect(isKnownVital(NAV_PUSH_RETRY_METRIC)).toBe(true);
            // …and it is not a web-vitals or framework name squatting in either
            // namespace.
            expect(NAV_PUSH_RETRY_METRIC.startsWith('Next.js-')).toBe(false);
        });
        it('rejects unknown / junk names', () => {
            expect(isKnownVital('lcp')).toBe(false);
            expect(isKnownVital('__proto__')).toBe(false);
            expect(isKnownVital('')).toBe(false);
            expect(isKnownVital('DROP TABLE')).toBe(false);
        });
    });

    describe('normalizeVitalRoute — bounded cardinality', () => {
        it('collapses the tenant slug', () => {
            expect(normalizeVitalRoute('/t/acme/dashboard')).toBe(
                '/t/[tenant]/dashboard',
            );
        });
        it('collapses cuid row ids', () => {
            expect(
                normalizeVitalRoute('/t/acme/controls/ckl1a2b3c4d5e6f7g8h9i0j1k'),
            ).toBe('/t/[tenant]/controls/[id]');
        });
        it('collapses uuid + numeric ids', () => {
            expect(
                normalizeVitalRoute(
                    '/t/acme/audits/cycles/3fa85f64-5717-4562-b3fc-2c963f66afa6',
                ),
            ).toBe('/t/[tenant]/audits/cycles/[id]');
            expect(normalizeVitalRoute('/t/acme/foo/12345')).toBe(
                '/t/[tenant]/foo/[id]',
            );
        });
        it('strips query/hash and trailing slash', () => {
            expect(normalizeVitalRoute('/t/acme/risks/?x=1#h')).toBe(
                '/t/[tenant]/risks',
            );
        });
        it('handles root + empty', () => {
            expect(normalizeVitalRoute('/')).toBe('/');
            expect(normalizeVitalRoute('')).toBe('/');
        });
    });

    describe('recordWebVital — validation (no throw)', () => {
        it('ignores unknown metric names', () => {
            expect(() =>
                recordWebVital({ name: 'NOPE', value: 1, route: '/' }),
            ).not.toThrow();
        });
        it('ignores non-finite values', () => {
            expect(() =>
                recordWebVital({ name: 'LCP', value: NaN, route: '/' }),
            ).not.toThrow();
            expect(() =>
                recordWebVital({ name: 'LCP', value: Infinity, route: '/' }),
            ).not.toThrow();
        });
        it('records a valid sample without throwing (OTel no-op when disabled)', () => {
            expect(() =>
                recordWebVital({
                    name: 'LCP',
                    value: 1234.5,
                    rating: 'good',
                    route: '/t/acme/controls/ckl1a2b3c4d5e6f7g8h9i0j1k',
                    navigationType: 'navigate',
                }),
            ).not.toThrow();
        });
    });

    describe('navigationId reaches the LOG and never a metric label (#4194)', () => {
        // It is the only field that separates a replayed metric from a
        // legitimate soft-navigation re-report, and those mean opposite things
        // for a baseline. Measured before it was carried: one LCP value emitted
        // six times with every beacon `navigate` — which cannot be a soft-nav
        // re-report — so the replay was real but only provable for the handful
        // of rows where no soft navigation was involved.
        //
        // Asserted on the LOG rather than on "it does not throw", which the
        // sibling navigationType case settles for and which would pass if the
        // field were dropped entirely.
        const load = () => {
            const logged: Array<Record<string, unknown>> = [];
            const recorded: Array<Record<string, unknown>> = [];
            jest.resetModules();
            jest.doMock('@/lib/observability/logger', () => ({
                log: (_l: string, _m: string, fields: Record<string, unknown>) => {
                    logged.push(fields);
                },
            }));
            jest.doMock('@opentelemetry/api', () => ({
                metrics: {
                    getMeter: () => ({
                        createHistogram: () => ({
                            record: (_v: number, attrs: Record<string, unknown>) => {
                                recorded.push(attrs);
                            },
                        }),
                    }),
                },
            }));
             
            const mod = require('@/lib/observability/web-vitals');
            return { mod, logged, recorded };
        };

        it('logs the navigationId it was given', () => {
            const { mod, logged } = load();
            mod.recordWebVital({
                name: 'LCP', value: 741.7, rating: 'good',
                route: '/t/acme/dashboard', navigationType: 'soft-navigation',
                navigationId: 'nav-7',
            });
            expect(logged).toHaveLength(1);
            expect(logged[0]).toMatchObject({ vital: 'LCP', navigationId: 'nav-7' });
        });

        it('logs null when it is absent, so a missing id is not a missing field', () => {
            // A beacon from a client that does not send it must be
            // distinguishable from one where the field was dropped in transit.
            const { mod, logged } = load();
            mod.recordWebVital({ name: 'LCP', value: 1, route: '/x' });
            expect(logged[0]).toHaveProperty('navigationId', null);
        });

        it('keeps it OUT of the histogram attributes, which are bounded', () => {
            // The cardinality guarantee this module exists to hold. A
            // navigationId is per-navigation, so one label would make the
            // series unbounded — the exact failure the three fixed attributes
            // are chosen to avoid.
            const { mod, recorded } = load();
            mod.recordWebVital({
                name: 'LCP', value: 741.7, rating: 'good',
                route: '/t/acme/dashboard', navigationId: 'nav-7',
            });
            expect(recorded).toHaveLength(1);
            expect(Object.keys(recorded[0]!).sort()).toEqual([
                'http.route', 'web.vital', 'web.vital.rating',
            ]);
        });
    });

    describe('acceptVitalBeacon — per-IP limiter', () => {
        it('passes normal volume and caps a flood', () => {
            const ip = `1.2.3.${Math.floor(Math.random() * 1000)}`;
            let accepted = 0;
            for (let i = 0; i < 300; i++) if (acceptVitalBeacon(ip)) accepted++;
            // Generous cap (240/min) — passes a normal page's ~8 vitals many
            // times over, but a 300-burst from one IP is partially shed.
            expect(accepted).toBeGreaterThanOrEqual(200);
            expect(accepted).toBeLessThan(300);
        });
    });
});
