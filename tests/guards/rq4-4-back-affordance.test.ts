/**
 * RQ4-4 — BackAffordance primitive ratchet.
 *
 * Locks the structural shape of the smart-back system:
 *
 *   - `<BackAffordance>` resolves in two tiers (referrer → canonical
 *     parent) — both branches exist in the source.
 *   - `PageHeader.back` accepts the `{ smart: true }` form and routes
 *     through `<BackAffordance>`.
 *   - The legacy `{ href, label }` static-link form continues to work.
 *   - Every entry in `SUBPAGES` has a canonical parent.
 *   - No entry in `MAIN_PAGES` has a canonical parent (negative — OB-H).
 */
import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from '../helpers/source-blocks';
import {
    MAIN_PAGES,
    SUBPAGES,
} from '@/lib/nav/page-segregation';
import {
    CANONICAL_PARENT_MAP_INTERNAL,
    resolveCanonicalParent,
} from '@/lib/nav/canonical-parents';

const BACK_AFFORDANCE_PATH = path.resolve(
    __dirname,
    '../../src/components/nav/BackAffordance.tsx',
);
const PAGE_HEADER_PATH = path.resolve(
    __dirname,
    '../../src/components/layout/PageHeader.tsx',
);

// #2246 Class A — comments blanked at the read, string literals kept, so
// `<BackAffordance`, `smart: true` and `print:hidden` must be CODE in the
// component rather than a line of the docblock describing it. `messages/
// en.json` is read separately below and stays raw (JSON, and it is parsed).
const readSource = (abs: string) => codeOf(fs.readFileSync(abs, 'utf-8'));

describe('rq4-4 back affordance', () => {
    it('every SUBPAGE has a canonical parent', () => {
        const missing = SUBPAGES.filter(
            (p) => !CANONICAL_PARENT_MAP_INTERNAL[p],
        );
        expect(missing).toEqual([]);
    });

    it('no MAIN_PAGE has a canonical parent (OB-H negative guard)', () => {
        const leaked = MAIN_PAGES.filter(
            (p) => CANONICAL_PARENT_MAP_INTERNAL[p],
        );
        expect(leaked).toEqual([]);
    });

    it('every canonical parent href points at a known route', () => {
        const known = new Set([...MAIN_PAGES, ...SUBPAGES]);
        for (const [child, parent] of Object.entries(
            CANONICAL_PARENT_MAP_INTERNAL,
        )) {
            expect({
                child,
                parentHref: parent.href,
                known: known.has(parent.href),
            }).toEqual({
                child,
                parentHref: parent.href,
                known: true,
            });
        }
    });

    it('resolveCanonicalParent expands dynamic segments shared with the child', () => {
        const parent = resolveCanonicalParent(
            '/t/acme/frameworks/nis2/readiness',
            'acme',
        );
        expect(parent).toEqual({
            href: '/t/acme/frameworks/nis2',
            label: 'NIS2',
        });
    });

    it('resolveCanonicalParent returns null for main pages', () => {
        expect(resolveCanonicalParent('/t/acme/risks', 'acme')).toBeNull();
        expect(resolveCanonicalParent('/t/acme/dashboard', 'acme')).toBeNull();
    });

    it('BackAffordance is a client component', () => {
        const source = readSource(BACK_AFFORDANCE_PATH);
        expect(source.startsWith("'use client';")).toBe(true);
    });

    it('BackAffordance has BOTH referrer + canonical-parent branches', () => {
        const source = readSource(BACK_AFFORDANCE_PATH);
        expect(source).toMatch(/usePreviousPath/);
        expect(source).toMatch(/resolveCanonicalParent/);
    });

    it('BackAffordance renders the ArrowLeft icon, not the unicode glyph in JSX', () => {
        const source = readSource(BACK_AFFORDANCE_PATH);
        expect(source).toMatch(/<ArrowLeft\b/);
        expect(source).not.toMatch(/>\s*← /);
        expect(source).not.toMatch(/\{['"]← /);
    });

    it('BackAffordance carries an aria-label naming the destination', () => {
        // Post-i18n: the aria-label is resolved through next-intl via the
        // `common.ui.backTo` message ("Back to {label}") rather than an
        // inline template literal. Assert the component references that
        // key AND the English catalog still starts with "Back to ".
        const source = readSource(BACK_AFFORDANCE_PATH);
        expect(source).toMatch(/aria-label=\{t\(['"]ui\.backTo['"]/);
        const en = JSON.parse(
            fs.readFileSync(
                path.resolve(__dirname, '../../messages/en.json'),
                'utf-8',
            ),
        );
        expect(en.common.ui.backTo).toMatch(/^Back to /);
    });

    it('BackAffordance hides under @media print (OB-I)', () => {
        const source = readSource(BACK_AFFORDANCE_PATH);
        expect(source).toMatch(/print:hidden/);
    });

    it('BackAffordance respects prefers-reduced-motion (OB-G)', () => {
        const source = readSource(BACK_AFFORDANCE_PATH);
        expect(source).toMatch(/motion-safe:/);
    });

    it('PageHeader.back accepts the { smart: true } form', () => {
        const source = readSource(PAGE_HEADER_PATH);
        expect(source).toMatch(/smart:\s*true/);
        expect(source).toMatch(/<BackAffordance\b/);
    });

    it('PageHeader preserves the legacy { href, label } static form', () => {
        const source = readSource(PAGE_HEADER_PATH);
        expect(source).toMatch(/PageHeaderBackLink/);
        expect(source).toMatch(/href:\s*string/);
        expect(source).toMatch(/label:\s*string/);
    });
});
