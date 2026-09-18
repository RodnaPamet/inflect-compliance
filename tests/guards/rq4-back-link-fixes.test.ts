/**
 * RQ4 back-link fixes — locks the three concrete behaviour changes:
 *
 *   1. `labelFromPathname` resolves `/audits` to "Internal Audit" (the
 *      product display name), not the raw "Audits". The lookup is a
 *      static map in `BackAffordance.tsx` so the regex check is
 *      stable against future renames.
 *   2. `<BackAffordance noFallback />` is a real prop on the
 *      primitive AND its branch logic skips the canonical-parent
 *      fallback. Source-scan confirms both.
 *   3. The canonical parent for `/controls/[controlId]/tests/[planId]`
 *      points at `/tests` (label "Tests"), not the URL parent
 *      `/controls/[controlId]`. The user-mental-model parent of a
 *      test plan is the Tests list — the smart referrer still wins
 *      when drilling in from a control detail.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveBackDestination } from '@/lib/nav/back-destination';
import { resolveCanonicalParent } from '@/lib/nav/canonical-parents';
import {
    REFERRER_ONLY_BACK_MAIN_PAGES,
} from '@/lib/nav/page-segregation';

const BACK_AFFORDANCE_PATH = path.resolve(
    __dirname,
    '../../src/components/nav/BackAffordance.tsx',
);

describe('rq4 back-link fixes', () => {
    it('BackAffordance carries a SECTION_LABELS map mapping /audits to "Internal Audit"', () => {
        // Post-i18n: SECTION_LABELS maps `/audits` to the
        // `common.sections.audits` message KEY, and the English catalog
        // resolves that key to the product display name "Internal Audit"
        // (not the raw "Audits"). Both halves are asserted so a rename
        // still fails CI.
        const source = fs.readFileSync(BACK_AFFORDANCE_PATH, 'utf-8');
        expect(source).toMatch(/SECTION_LABELS/);
        expect(source).toMatch(/'\/audits':\s*'audits'/);
        const en = JSON.parse(
            fs.readFileSync(
                path.resolve(__dirname, '../../messages/en.json'),
                'utf-8',
            ),
        );
        expect(en.common.sections.audits).toBe('Internal Audit');
    });

    it('noFallback yields NO link rather than a canonical parent', () => {
        // Was a source grep for /noFallback\s*\?\s*null/, which asserts that a
        // STRING APPEARS IN A FILE and passes whatever the code does. Driven
        // through the real resolver instead.
        expect(
            resolveBackDestination({
                pathname: '/t/acme/clauses',
                referrer: null,
                tenantSlug: 'acme',
                noFallback: true,
                labelFor: (x) => x,
            }),
        ).toBeNull();
        // …while the same page WITH a referrer still offers it.
        expect(
            resolveBackDestination({
                pathname: '/t/acme/clauses',
                referrer: '/t/acme/audits',
                tenantSlug: 'acme',
                noFallback: true,
                labelFor: (x) => x,
            })?.href,
        ).toBe('/t/acme/audits');
    });

    it('a sibling referrer routes to the shared parent, not back to the sibling', () => {
        // Was `expect(source).toMatch(/referrerIsSibling/)` — an identifier
        // check that could not fail when the behaviour was wrong, and did not
        // fail while a whole class of circular back links shipped. Now driven.
        const dest = resolveBackDestination({
            pathname: '/t/acme/assets/a2',
            referrer: '/t/acme/assets/a1',
            tenantSlug: 'acme',
            labelFor: (x) => x,
        });
        expect(dest?.href).not.toBe('/t/acme/assets/a1');
        expect(dest?.href).toBe('/t/acme/assets');
    });

    it('a DESCENDANT referrer routes up, never down (the reported cycle)', () => {
        const dest = resolveBackDestination({
            pathname: '/t/acme/frameworks/nis2',
            referrer: '/t/acme/frameworks/nis2/install',
            tenantSlug: 'acme',
            labelFor: (x) => x,
        });
        expect(dest?.href).not.toBe('/t/acme/frameworks/nis2/install');
        expect(dest?.href).toBe('/t/acme/frameworks');
        // Exhaustive coverage of this class lives in
        // tests/guards/back-affordance-no-cycles.test.ts.
    });

    it('canonical parent for /controls/[controlId]/tests/[planId] is /tests with label "Tests"', () => {
        const parent = resolveCanonicalParent(
            '/t/acme/controls/c1/tests/p1',
            'acme',
        );
        expect(parent).toEqual({
            href: '/t/acme/tests',
            label: 'Tests',
        });
    });

    it('REFERRER_ONLY_BACK_MAIN_PAGES lists /clauses and /findings (the deep-linked-from-audits set)', () => {
        expect(REFERRER_ONLY_BACK_MAIN_PAGES).toContain('/clauses');
        expect(REFERRER_ONLY_BACK_MAIN_PAGES).toContain('/findings');
    });
});
