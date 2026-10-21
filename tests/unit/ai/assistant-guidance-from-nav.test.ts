/**
 * Guidance may only name routes the product actually has (#3845, #3853).
 *
 * ═══ WHY THE EXPECTATION IS DERIVED, NOT WRITTEN DOWN ═══
 *
 * The roadmap's requirement is that "a nav change cannot silently invalidate"
 * this. A hand-written list of expected routes would do exactly that: someone
 * renames `/vendors` in the sidebar, this file still lists `/vendors`, both
 * sides agree with each other and nothing agrees with the product. So the
 * expected set is extracted from `SidebarNav.tsx` — the nav definition stays
 * the authority and `ASSISTANT_NAV_ROUTES` is checked against it.
 *
 * ═══ WHY IT IS EXTRACTED FROM SOURCE RATHER THAN RENDERED ═══
 *
 * `useNavSections()` is a React hook reading tenant context, permissions,
 * modules and the translation catalogue. This file matches `**\/*.test.ts`,
 * which is the jest `node` project (`testEnvironment: 'node'`) — there is no
 * DOM here to render it in, and moving the file to `tests/rendered/` to get
 * one would put a route-table assertion in with the component tests.
 *
 * A source scan has its own failure mode: an extractor that quietly matches
 * nothing makes every assertion below pass against an empty set. Three things
 * stop that, and they are tests, not comments — the denominator is asserted,
 * every `href:` in the definition must be one the extractor could parse, and
 * the comparison is proven to fail in both directions.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    ASSISTANT_NAV_ROUTES,
    isKnownAssistantRoute,
    normaliseRoute,
} from '@/app-layer/ai/assistant/nav-routes';
import {
    checkGuidanceRoutes,
    pathTokensIn,
    unknownRoutesIn,
} from '@/app-layer/ai/assistant/guidance';

const NAV_FILE = path.join(process.cwd(), 'src/components/layout/SidebarNav.tsx');

/**
 * The nav definition with comments removed.
 *
 * A commented-out `tenantHref('/old-thing')` is a SCAR — the route was taken
 * out and the line left behind. Reading it as live would have the assistant
 * vouching for a page that was deliberately removed.
 */
function navSource(): string {
    return readFileSync(NAV_FILE, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

/** Routes the sidebar actually builds, as tenant-relative paths. */
function routesFromNav(): string[] {
    const out = new Set<string>();
    for (const m of navSource().matchAll(/tenantHref\('([^']+)'\)/g)) {
        const n = normaliseRoute(m[1]);
        if (n !== null) out.add(n);
    }
    return [...out].sort();
}

describe('the assistant route table is a projection of the real nav', () => {
    it('the scan can see the definition it is reading', () => {
        // The denominator. Without it, a moved file or a changed call shape
        // yields an empty set and every comparison below passes by seeing
        // nothing at all.
        const src = navSource();
        expect(src.length).toBeGreaterThan(2000);
        expect(src).toContain('export function useNavSections');
        expect(routesFromNav().length).toBeGreaterThanOrEqual(10);
    });

    it('every href in the definition is one the extractor can parse', () => {
        // This is what keeps the extractor honest as the nav evolves. If
        // someone introduces a computed href -- `href: buildHref(x)` or a
        // template literal -- the extractor would skip it silently and the
        // assistant would lose a real route with no test failing. Here that
        // becomes a loud failure that names the line.
        // Matched on the `href` ASSIGNMENT rather than on whole lines: items
        // are written as inline objects (`{ href: tenantHref('/risks'),
        // label: ... }`) and the admin link is a JSX attribute
        // (`href={tenantHref('/admin')}`), so a line-anchored pattern sees
        // four of the fifteen and the denominator silently collapses.
        const assignments = [...navSource().matchAll(/href\s*[:=]\s*[^,\n}]+/g)].map(
            (m) => m[0].trim(),
        );

        expect(assignments.length).toBeGreaterThanOrEqual(15);

        // Two shapes in this file are not route DEFINITIONS and must not be
        // read as ones. They are pinned by exact text rather than skipped by
        // a loose pattern, so a THIRD shape -- which is how a computed href
        // would arrive -- lands in `unparseable` and fails loudly.
        const notDefinitions = [
            'href: string;', // the `NavItemDef` field declaration
            'href={item.href', // the render site, forwarding an already-built href
        ];

        const unparseable = assignments.filter(
            (a) =>
                !notDefinitions.includes(a) &&
                !/^href\s*[:=]\s*\{?tenantHref\('[^']+'\)\}?$/.test(a),
        );
        expect(unparseable).toEqual([]);

        // ...and the pins themselves must still be present: if the field
        // declaration or the render site is renamed, this list is stale and
        // would start hiding a real shape.
        for (const pin of notDefinitions) {
            expect(assignments).toContain(pin);
        }
    });

    it('the table equals the nav, in both directions', () => {
        const nav = routesFromNav();
        const table = [...ASSISTANT_NAV_ROUTES].sort();

        // Stated as two set differences rather than one equality, so a failure
        // says WHICH way it drifted: a route the nav gained (the assistant
        // cannot link to it) reads differently from one the nav lost (the
        // assistant vouches for a page that is gone).
        expect(nav.filter((r) => !table.includes(r))).toEqual([]);
        expect(table.filter((r) => !nav.includes(r))).toEqual([]);
        expect(table).toEqual(nav);
    });

    it('the comparison can fail, in both directions', () => {
        // A positive control for the assertion above. Without it, a bug that
        // made both sides the same object -- or both empty -- would be
        // indistinguishable from agreement.
        const nav = routesFromNav();

        const navGainedOne = [...nav, '/brand-new-section'].sort();
        expect(navGainedOne.filter((r) => !ASSISTANT_NAV_ROUTES.includes(r))).toEqual([
            '/brand-new-section',
        ]);

        const navLostOne = nav.slice(1);
        expect([...ASSISTANT_NAV_ROUTES].sort().filter((r) => !navLostOne.includes(r))).toEqual([
            nav[0],
        ]);
    });
});

describe('a fabricated route is refused', () => {
    it('accepts every real nav route, with and without the tenant prefix', () => {
        for (const route of ASSISTANT_NAV_ROUTES) {
            expect(isKnownAssistantRoute(route)).toBe(true);
            expect(isKnownAssistantRoute(`/t/acme${route}`)).toBe(true);
            // A deep link carries filter state; the filters are not part of
            // whether the page exists.
            expect(isKnownAssistantRoute(`${route}?status=open`)).toBe(true);
            expect(isKnownAssistantRoute(`${route}/`)).toBe(true);
        }
    });

    it('rejects a route that does not exist, including a plausible one', () => {
        // `/compliance-score` is the shape of thing a model invents: it sounds
        // like this product and is not in it.
        expect(isKnownAssistantRoute('/compliance-score')).toBe(false);
        expect(isKnownAssistantRoute('/settings/integrations')).toBe(false);
        expect(isKnownAssistantRoute('/t/acme/compliance-score')).toBe(false);
    });

    it('rejects a SUB-path of a real route', () => {
        // The table can vouch for the list page. It cannot vouch for an id
        // resolving, and `/controls/soc2-cc6-1` is a 404 with the user's
        // trust attached if that control does not exist.
        expect(isKnownAssistantRoute('/controls')).toBe(true);
        expect(isKnownAssistantRoute('/controls/soc2-cc6-1')).toBe(false);
    });

    it('never accepts an absolute URL whose path happens to match', () => {
        // Treating the pathname as ours would authorise an off-product link.
        expect(isKnownAssistantRoute('https://evil.example/controls')).toBe(false);
        expect(isKnownAssistantRoute('//evil.example/controls')).toBe(false);
        expect(normaliseRoute('https://evil.example/controls')).toBeNull();
    });

    it('finds the fabricated path inside prose, and leaves real ones alone', () => {
        const invented =
            'Open /compliance-score and read the panel on the right.';
        expect(unknownRoutesIn(invented)).toEqual(['/compliance-score']);
        expect(checkGuidanceRoutes(invented).ok).toBe(false);

        const real = 'Three controls are missing evidence — see /controls?evidence=missing.';
        expect(unknownRoutesIn(real)).toEqual([]);
        expect(checkGuidanceRoutes(real).ok).toBe(true);
    });

    it('the extractor actually sees paths, so a clean verdict means something', () => {
        // Without this, `unknownRoutesIn` returning [] above would be
        // consistent with an extractor that matches nothing ever.
        expect(pathTokensIn('go to /controls and then /risks')).toEqual([
            '/controls',
            '/risks',
        ]);
        expect(pathTokensIn('no paths here, and/or 24/7 support').length).toBe(0);
    });

    it('the refusal names the unknown route to the caller, not to the user', () => {
        const verdict = checkGuidanceRoutes('try /made-up-page');
        // The caller gets the path so the refusal can be investigated...
        expect(verdict.unknownRoutes).toEqual(['/made-up-page']);
        // ...and the user-facing string does not repeat it back, because
        // quoting it is how a wrong path reaches the user anyway.
        const { GUIDANCE_ROUTE_REFUSAL } = jest.requireActual<
            typeof import('@/app-layer/ai/assistant/guidance')
        >('@/app-layer/ai/assistant/guidance');
        expect(GUIDANCE_ROUTE_REFUSAL).not.toContain('/made-up-page');
        expect(GUIDANCE_ROUTE_REFUSAL.length).toBeGreaterThan(40);
    });
});
