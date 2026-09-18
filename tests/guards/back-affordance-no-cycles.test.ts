/**
 * "Back" must never return you to where you just were.
 *
 * WHY THIS TEST IS BEHAVIOURAL AND THE OLD ONE WAS NOT. The sibling guard was
 * covered by `tests/guards/rq4-back-link-fixes.test.ts:58-65`, which reads:
 *
 *     const source = fs.readFileSync(BACK_AFFORDANCE_PATH, 'utf-8');
 *     expect(source).toMatch(/referrerIsSibling/);
 *
 * That asserts an IDENTIFIER APPEARS IN A FILE. It passes whatever the guard
 * actually does, so it could not fail when a whole class of circular back
 * links shipped underneath it. The resolution has been extracted into the pure
 * `resolveBackDestination` precisely so this test can drive the behaviour over
 * every route pair instead of reading the source.
 *
 * THE CYCLE, mechanically. `NavigationTracker` stores the OUTGOING path, so
 * navigating P -> D leaves the referrer at D equal to P. A pair oscillates when
 * neither direction is rejected:
 *
 *     at P, referrer R  ->  back sends you to D
 *     at D, referrer P  ->  back sends you to P      <- bounce
 *
 * Measured on the pre-fix tree: 90 IA-structural oscillations over 45 distinct
 * route pairs. This test pins that at zero.
 */
import {
    MAIN_PAGES,
    SUBPAGES,
    REFERRER_ONLY_BACK_MAIN_PAGES,
    BACK_AFFORDANCE_EXEMPT_SUBPAGES,
} from '@/lib/nav/page-segregation';
import { resolveBackDestination } from '@/lib/nav/back-destination';
import { resolveCanonicalParent } from '@/lib/nav/canonical-parents';

const SLUG = 'acme';
const T = `/t/${SLUG}`;

/** Concrete path for a route pattern — dynamic segments get a stable token. */
function concrete(pattern: string): string {
    return (
        T +
        pattern
            .split('/')
            .map((seg) =>
                seg.startsWith('[') && seg.endsWith(']')
                    ? `x-${seg.slice(1, -1).toLowerCase()}`
                    : seg,
            )
            .join('/')
    );
}

const exempt = new Set<string>(BACK_AFFORDANCE_EXEMPT_SUBPAGES);
const referrerOnly = new Set<string>(REFERRER_ONLY_BACK_MAIN_PAGES);

/** Every route that renders a back link, with the flags it renders under. */
const BACK_ROUTES = [
    ...SUBPAGES.filter((p) => !exempt.has(p)).map((p) => ({
        pattern: p,
        noFallback: false,
    })),
    ...MAIN_PAGES.filter((p) => referrerOnly.has(p)).map((p) => ({
        pattern: p,
        noFallback: true,
    })),
];

const ALL_ROUTES = [...new Set([...MAIN_PAGES, ...SUBPAGES])];

const labelFor = (p: string) => p;

function backHref(
    pathname: string,
    referrer: string | null,
    noFallback: boolean,
): string | null {
    return (
        resolveBackDestination({
            pathname,
            referrer,
            tenantSlug: SLUG,
            noFallback,
            labelFor,
        })?.href ?? null
    );
}

/** IA-related: one contains the other by URL, or by a canonical-parent walk. */
function iaRelated(a: string, b: string): boolean {
    if (a === b) return false;
    if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
    const pa = resolveCanonicalParent(a, SLUG)?.href;
    const pb = resolveCanonicalParent(b, SLUG)?.href;
    return pa === b || pb === a || (pa != null && pa === pb);
}

interface Bounce {
    page: string;
    referrer: string;
    via: string;
}

function findOscillations(): { pairs: number; bounces: Bounce[]; simulated: number } {
    const bounces: Bounce[] = [];
    let simulated = 0;
    const byPattern = new Map(BACK_ROUTES.map((r) => [concrete(r.pattern), r]));
    for (const route of BACK_ROUTES) {
        const page = concrete(route.pattern);
        for (const other of ALL_ROUTES) {
            const referrer = concrete(other);
            if (referrer === page || !iaRelated(referrer, page)) continue;
            simulated += 1;
            const dest = backHref(page, referrer, route.noFallback);
            if (!dest) continue;
            // At `dest`, the referrer is now `page` — the tracker stored the
            // outgoing path when the back link was followed.
            const destRoute = byPattern.get(dest);
            if (!destRoute) continue;
            const second = backHref(dest, page, destRoute.noFallback);
            if (second === page) {
                bounces.push({ page, referrer, via: dest });
            }
        }
    }
    const pairs = new Set(
        bounces.map((b) => [b.page, b.via].sort().join(' <-> ')),
    ).size;
    return { pairs, bounces, simulated };
}

describe('back affordance — no navigation cycles', () => {
    const result = findOscillations();

    it('simulated a real population', () => {
        // Denominators before any zero claim: an empty selection is a PASS.
        expect(BACK_ROUTES.length).toBeGreaterThan(50);
        expect(ALL_ROUTES.length).toBeGreaterThan(100);
        expect(result.simulated).toBeGreaterThan(100);
    });

    it('never sends you back to the page you just came from', () => {
        if (result.bounces.length > 0) {
            const shown = [
                ...new Set(
                    result.bounces.map(
                        (b) => `  ${b.page}  <->  ${b.via}`,
                    ),
                ),
            ].slice(0, 20);
            throw new Error(
                [
                    `Back oscillates on ${result.pairs} route pair(s) — following it`,
                    'and pressing back again returns you to where you started.',
                    '',
                    ...shown,
                    '',
                    `  ${result.bounces.length} directed bounces over ${result.simulated} IA-related pairs simulated`,
                ].join('\n'),
            );
        }
        expect(result.bounces).toEqual([]);
    });

    it('still prefers a genuine ancestor referrer', () => {
        // The fix must not blunt the feature: coming from a real parent, back
        // returns there rather than jumping to the canonical grandparent.
        const child = `${T}/frameworks/x-frameworkkey/install`;
        const parent = `${T}/frameworks/x-frameworkkey`;
        expect(backHref(child, parent, false)).toBe(parent);
    });

    it('refuses a descendant referrer and ascends instead', () => {
        const page = `${T}/frameworks/x-frameworkkey`;
        const descendant = `${T}/frameworks/x-frameworkkey/install`;
        const dest = backHref(page, descendant, false);
        expect(dest).not.toBe(descendant);
        expect(dest).toBe(`${T}/frameworks`);
    });
});
