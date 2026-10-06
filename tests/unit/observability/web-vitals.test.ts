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
