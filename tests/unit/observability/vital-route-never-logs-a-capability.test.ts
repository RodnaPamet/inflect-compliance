/**
 * A route label must never contain a bearer capability (#5130).
 *
 * `src/middleware.ts` writes one `document_load` line per page load and one
 * `soft_navigation` line per client-side navigation, each carrying the route
 * label from `normalizeVitalRoute`. The middleware also runs on PUBLIC paths:
 * `src/lib/auth/guard.ts` lists `/invite/` and `/audit/shared` as pass-through,
 * so `isPassThrough` is true and both lines are written for them.
 *
 * Those paths carry the raw capability in the PATH:
 *
 *   /audit/shared/<64 hex>   randomBytes(32).toString('hex')     — audit-readiness/sharing.ts
 *   /invite/<43 base64url>   randomBytes(32).toString('base64url') — tenant-invites.ts
 *   /invite/org/<43 base64url>                                     — org-invites.ts
 *
 * and the database deliberately stores only a SHA-256 hash of each. `ID_SEGMENT`
 * collapsed neither: a hex token matches `c[a-z0-9]{20,}` only when it happens
 * to begin with `c`, and a base64url token almost always contains `-` or `_` so
 * never matches. Roughly 94% of share tokens and nearly every invite token were
 * written to the container's stdout in plaintext, usable for the token's whole
 * validity window by anyone who can read `docker logs`.
 *
 * Two paths are NOT affected and both tests below say why: `/reset-password`
 * and `/vendor-assessment/<id>` pass their token in the QUERY (`?token=`,
 * `?t=`), which `normalizeVitalRoute` strips before it splits segments. That
 * stripping is therefore load-bearing and is asserted here too — remove it and
 * those two start leaking.
 */
import * as path from 'path';
import { repoRelativeFiles } from '../../helpers/repo-files';
import {
    normalizeVitalRoute,
    documentLoadRoute,
    softNavigationRoute,
} from '@/lib/observability/vital-route';

/** A 64-char hex share token that does NOT begin with `c`. */
const HEX = '9f3a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8';
/** The 1-in-16 hex token that DID match the old id rule — see the order test. */
const HEX_C = 'cf3a2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8';
/** A base64url invite token, carrying both `-` and `_`. */
const B64 = 'Ab3-x9_Qz1LmNoPqRsTuVwXyZ0123456789abcdEFG';

describe('a route label never contains a bearer capability', () => {
    it.each([
        [`/audit/shared/${HEX}`, '/audit/shared/[token]'],
        [`/audit/shared/${HEX_C}`, '/audit/shared/[token]'],
        [`/invite/${B64}`, '/invite/[token]'],
        [`/invite/org/${B64}`, '/invite/org/[token]'],
    ])('collapses %s', (pathname, expected) => {
        const label = normalizeVitalRoute(pathname);
        expect(label).toBe(expected);
        // Said twice on purpose: the equality above would also pass if the
        // expectation itself were wrong, and this is the property that matters.
        expect(label).not.toContain(HEX);
        expect(label).not.toContain(HEX_C);
        expect(label).not.toContain(B64);
    });

    it('labels ONE route with ONE value, whatever the token happens to start with', () => {
        // The id rule used to win here, so a share token beginning with `c`
        // produced `/audit/shared/[id]` and everything else `[token]` — one
        // route split across two series on a 1-in-16 coin flip.
        expect(normalizeVitalRoute(`/audit/shared/${HEX}`))
            .toBe(normalizeVitalRoute(`/audit/shared/${HEX_C}`));
    });

    it('reaches the log line through both counters, not just the normalizer', () => {
        // The leak needed the middleware to CALL this for a public path. Both
        // counters pass a pass-through page through, so both are asserted.
        expect(documentLoadRoute({
            fetchDest: 'document', pathname: `/invite/${B64}`, passedThrough: true,
        })).toBe('/invite/[token]');
        expect(softNavigationRoute({
            rsc: '1', routerPrefetch: null, pathname: `/audit/shared/${HEX}`, passedThrough: true,
        })).toBe('/audit/shared/[token]');
    });

    it('strips the QUERY, which is the whole reason two other token paths are safe', () => {
        // `/reset-password?token=` and `/vendor-assessment/<id>?t=` both carry a
        // capability. They are safe ONLY because of this strip.
        expect(normalizeVitalRoute(`/reset-password?token=${B64}`)).toBe('/reset-password');
        expect(normalizeVitalRoute(`/vendor-assessment/ckxyz01234567890123456789?t=${B64}`))
            .not.toContain(B64);
        expect(normalizeVitalRoute(`/invite/${B64}#frag`)).toBe('/invite/[token]');
    });

    it('catches a token-bearing path nobody registered — the general backstop', () => {
        // The explicit prefix list cannot cover a public path added later. A
        // long segment carrying a digit is a credential, not a word.
        expect(normalizeVitalRoute(`/some-future-public-page/${HEX}`))
            .toBe('/some-future-public-page/[token]');
        expect(normalizeVitalRoute(`/another/${B64}`)).toBe('/another/[token]');
    });
});

/**
 * THE SECOND SINK, which #5130 does not mention: the web-vitals BEACON.
 *
 * `recordWebVital` puts the same label into `http.route` — a METRIC ATTRIBUTE
 * on the histogram, not a log field. So a browser sitting on `/invite/<token>`
 * firing any web-vital sent the raw capability to the metrics backend, where
 * label values are indexed and retained. It is also the cardinality explosion
 * this normalizer exists to prevent: one new time series per share link.
 *
 * Both sinks share the one normalizer, so the fix covers both — asserted here
 * rather than assumed, because "it goes through the same function" is exactly
 * the kind of claim that stops being true after a refactor.
 */
describe('the web-vitals beacon label carries no capability either', () => {
    const loadWithCapturedMetrics = () => {
        const recorded: Array<Record<string, unknown>> = [];
        jest.resetModules();
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
        return { mod, recorded };
    };

    afterEach(() => { jest.resetModules(); jest.dontMock('@opentelemetry/api'); });

    it.each([
        [`/audit/shared/${HEX}`, '/audit/shared/[token]', HEX],
        [`/invite/${B64}`, '/invite/[token]', B64],
    ])('records %s as a bounded label', (route, expected, secret) => {
        const { mod, recorded } = loadWithCapturedMetrics();
        mod.recordWebVital({ name: 'LCP', value: 741.7, rating: 'good', route });
        expect(recorded).toHaveLength(1);
        expect(recorded[0]['http.route']).toBe(expected);
        // The property, said independently of the expectation above.
        expect(JSON.stringify(recorded[0])).not.toContain(secret);
    });
});

describe('and it still labels the real routes', () => {
    /**
     * DERIVED, not listed: every literal path segment of every route on disk.
     * A bare "collapse any segment of 20+ characters" rule — the obvious
     * spelling — eats 24 of these, silently destroying their metric series.
     * This is the denominator that makes the token rules above safe to have.
     */
    const ROUTE_SEGMENTS: readonly string[] = (() => {
        const segs = new Set<string>();
        for (const f of repoRelativeFiles()) {
            if (!f.startsWith('src/app/')) continue;
            const dir = path.posix.dirname(f).slice('src/app/'.length);
            if (dir === '' || dir === '.') continue;
            for (const seg of dir.split('/')) {
                // Dynamic `[x]`, route groups `(x)`, and private `_x` folders
                // are not path segments a URL carries.
                if (!seg || seg.startsWith('[') || seg.startsWith('(') || seg.startsWith('_')) continue;
                segs.add(seg);
            }
        }
        return [...segs].sort();
    })();

    it('reads a real population', () => {
        // Every assertion below passes over an empty set.
        expect(ROUTE_SEGMENTS.length).toBeGreaterThan(300);
        // The long ones are the whole point of the measurement — if these
        // vanish from the population the next test stops proving anything.
        expect(ROUTE_SEGMENTS.filter((s) => s.length >= 20).length).toBeGreaterThanOrEqual(20);
        expect(ROUTE_SEGMENTS).toContain('vendor-assessment-templates');
        expect(ROUTE_SEGMENTS).toContain('http-message-signatures-directory');
    });

    it('leaves every literal route segment on disk untouched', () => {
        const mangled = ROUTE_SEGMENTS
            .filter((seg) => normalizeVitalRoute(`/x/${seg}`) !== `/x/${seg}`)
            .map((seg) => `${seg} (${seg.length} chars) -> ${normalizeVitalRoute(`/x/${seg}`)}`);
        expect(mangled).toEqual([]);
    });

    it('keeps the literal pages that sit beside a token route', () => {
        // `/invite/[token]` has real siblings. A blanket "segment after /invite
        // is a token" would relabel both of these.
        expect(normalizeVitalRoute('/invite/result')).toBe('/invite/result');
        expect(normalizeVitalRoute('/invite/org')).toBe('/invite/org');
    });

    it('still collapses ids and tenant slugs as it always did', () => {
        expect(normalizeVitalRoute('/t/acme/controls/ckxyz01234567890123456789'))
            .toBe('/t/[tenant]/controls/[id]');
        expect(normalizeVitalRoute('/t/acme/dashboard')).toBe('/t/[tenant]/dashboard');
        expect(normalizeVitalRoute('/t/acme/risks/42')).toBe('/t/[tenant]/risks/[id]');
        expect(normalizeVitalRoute('/t/acme/x/3f2504e0-4f89-11d3-9a0c-0305e82c3301'))
            .toBe('/t/[tenant]/x/[id]');
    });
});
