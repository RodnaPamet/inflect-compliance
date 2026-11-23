/**
 * One way back on a phone (#5822).
 *
 * Below md the top chrome hides its breadcrumbs, so pages rendered an inline
 * trail AND a back link to the same parent — two lines of a small screen for
 * one destination, in an order that changed from page to page. Now a phone
 * shows the back link and nothing else wherever a back link is showing;
 * desktop is untouched (its trail is the chrome's).
 *
 * The rule is CSS: every back link carries `data-back-link`, and every inline
 * trail carries `PHONE_TRAIL_CLASS`, whose variant hides it inside a `<main>`
 * that holds one. jsdom applies no stylesheet, so this file holds both halves
 * of that contract on the rendered DOM, and then compiles the real stylesheet
 * to prove the class becomes the rule.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as React from 'react';
import { render, screen } from '@testing-library/react';

let mockPathname = '/t/acme/controls/c1';
jest.mock('next/navigation', () => ({
    usePathname: () => mockPathname,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => new URLSearchParams(),
}));

import { PageHeader } from '@/components/layout/PageHeader';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { BACK_LINK_ATTR, PHONE_TRAIL_CLASS } from '@/components/layout/breadcrumbs-store';

const CRUMBS = [
    { label: 'Dashboard', href: '/t/acme/dashboard' },
    { label: 'Controls', href: '/t/acme/controls' },
    { label: 'AC-1' },
];

const backLinks = () => screen.queryAllByTestId('page-header-back');
/** The wrapper div around each inline (phone-only) trail. */
const trailWrappers = () =>
    [...screen.queryAllByTestId('page-header-breadcrumbs'), ...screen.queryAllByTestId('inline-crumbs')].map(
        (nav) => nav.parentElement!,
    );

describe('every back link marks itself, and every inline trail yields to it', () => {
    beforeEach(() => {
        mockPathname = '/t/acme/controls/c1';
    });

    it("PageHeader's smart back link and its trail", () => {
        render(<PageHeader breadcrumbs={CRUMBS} back={{ smart: true }} title="AC-1" />);
        expect(backLinks()).toHaveLength(1);
        expect(backLinks()[0]).toHaveAttribute(BACK_LINK_ATTR);
        expect(trailWrappers()).toHaveLength(1);
        expect(trailWrappers()[0].className).toContain(PHONE_TRAIL_CLASS);
    });

    it("PageHeader's static back link", () => {
        render(<PageHeader breadcrumbs={CRUMBS} back={{ href: '/t/acme/controls', label: 'Controls' }} title="AC-1" />);
        expect(backLinks()[0]).toHaveAttribute(BACK_LINK_ATTR);
    });

    it('a page-level back link + PageBreadcrumbs', () => {
        render(
            <div>
                <BackAffordance />
                <PageBreadcrumbs items={CRUMBS} data-testid="inline-crumbs" />
                <h1>AC-1</h1>
            </div>,
        );
        expect(backLinks()[0]).toHaveAttribute(BACK_LINK_ATTR);
        expect(trailWrappers()[0].className).toContain(PHONE_TRAIL_CLASS);
    });

    it('the back link is the first thing above the title a phone shows', () => {
        const { container } = render(<PageHeader breadcrumbs={CRUMBS} back={{ smart: true }} title="AC-1" />);
        const back = backLinks()[0];
        const title = screen.getByTestId('page-header-title');
        expect(back.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // Every link before it sits in the trail, which a phone hides here.
        const before = [...container.querySelectorAll('a, button')].filter(
            (el) => el.compareDocumentPosition(back) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
        expect(before.length).toBeGreaterThan(0);
        expect(before.every((el) => trailWrappers()[0].contains(el))).toBe(true);
    });

    it('the back link is a 44 px target on touch', () => {
        render(<PageHeader breadcrumbs={CRUMBS} back={{ smart: true }} title="AC-1" />);
        // The shared touch hit area (a pseudo-element, layout untouched).
        expect(backLinks()[0].className).toContain('pointer-coarse:after:min-h-11');
        expect(backLinks()[0].className).toContain('relative');
    });

    it('a page with no back link keeps its trail (nothing to yield to)', () => {
        mockPathname = '/t/acme/controls';
        render(<PageHeader breadcrumbs={CRUMBS.slice(0, 2)} title="Controls" />);
        expect(backLinks()).toHaveLength(0);
        expect(trailWrappers()).toHaveLength(1);
    });
});

describe('the class becomes the rule', () => {
    let css = '';
    beforeAll(() => {
        css = execFileSync(
            process.execPath,
            [path.join(__dirname, '../helpers/compile-globals-css.mjs')],
            { cwd: path.join(__dirname, '../..'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        );
    }, 180_000);

    it('compiles to something substantial (floor on the collector)', () => {
        expect(css.length).toBeGreaterThan(50_000);
    });

    it('hides a trail inside a <main> that holds a back link', () => {
        // The arbitrary variant in PHONE_TRAIL_CLASS, as Tailwind emits it.
        const rule = css.match(/main:has\(\[data-back-link\]\)\s+[^{]*\{[^}]*\}/);
        expect(rule).not.toBeNull();
        expect(rule![0]).toMatch(/display:\s*none/);
    });
});
