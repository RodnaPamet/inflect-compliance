/**
 * One way back on a phone (#5822).
 *
 * Below md the top chrome hides its breadcrumbs, so pages rendered an inline
 * trail AND a back link to the same parent — two lines of a small screen for
 * one destination, in an order that changed from page to page. On a subpage a
 * phone now shows the back link and nothing else; desktop is untouched (its
 * breadcrumbs live in the chrome, which still receives them).
 *
 * The rule is the product's, mounted in the tenant app's `ClientProviders`;
 * each render below mounts it the same way.
 *
 * jsdom has no viewport. The inline trail is a phone-only element (`md:hidden`;
 * desktop reads the chrome's copy), so whether a phone sees it is whether it
 * renders at all — which is what these tests assert.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

let mockPathname = '/t/acme/controls/c1';
jest.mock('next/navigation', () => ({
    usePathname: () => mockPathname,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => new URLSearchParams(),
}));

// ClientProviders mounts a vitals reporter jsdom cannot run; it is not under test.
jest.mock('@/components/observability/WebVitalsReporter', () => ({ WebVitalsReporter: () => null }));

import { PageHeader } from '@/components/layout/PageHeader';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { SUBPAGES, BACK_AFFORDANCE_EXEMPT_SUBPAGES } from '@/lib/nav/page-segregation';
import { phoneShowsBackLinkOnly } from '@/lib/nav/mobile-wayfinding';
import { PhoneWayfindingPolicy } from '@/components/nav/PhoneWayfindingPolicy';
import { ClientProviders } from '@/components/layout/ClientProviders';

const CRUMBS = [
    { label: 'Dashboard', href: '/t/acme/dashboard' },
    { label: 'Controls', href: '/t/acme/controls' },
    { label: 'AC-1' },
];

/** The two shapes subpages use: PageHeader's own slot, and a page-level pair. */
function HeaderSlotPage() {
    return (
        <PhoneWayfindingPolicy>
            <PageHeader breadcrumbs={CRUMBS} back={{ smart: true }} title="AC-1" />
        </PhoneWayfindingPolicy>
    );
}
function PageLevelPair() {
    return (
        <PhoneWayfindingPolicy>
            <div>
                <BackAffordance />
                <PageBreadcrumbs items={CRUMBS} data-testid="inline-crumbs" />
                <h1>AC-1</h1>
            </div>
        </PhoneWayfindingPolicy>
    );
}
function InlineTrail({ items }: { items: typeof CRUMBS }) {
    return (
        <PhoneWayfindingPolicy>
            <PageBreadcrumbs items={items} data-testid="inline-crumbs" />
        </PhoneWayfindingPolicy>
    );
}

const backLinks = () => screen.queryAllByTestId('page-header-back');
const inlineCrumbs = () => [
    ...screen.queryAllByTestId('page-header-breadcrumbs'),
    ...screen.queryAllByTestId('inline-crumbs'),
];

describe('a subpage on a phone shows exactly one way back', () => {
    beforeEach(() => {
        mockPathname = '/t/acme/controls/c1';
    });

    it('PageHeader: the back link, and no inline breadcrumbs', () => {
        render(<HeaderSlotPage />);
        expect(backLinks()).toHaveLength(1);
        expect(inlineCrumbs()).toHaveLength(0);
    });

    it('a page-level back link + PageBreadcrumbs: the back link only', () => {
        render(<PageLevelPair />);
        expect(backLinks()).toHaveLength(1);
        expect(inlineCrumbs()).toHaveLength(0);
    });

    it('the back link is the first thing above the title, every time', () => {
        const { container } = render(<HeaderSlotPage />);
        const back = backLinks()[0];
        const title = screen.getByTestId('page-header-title');
        expect(back.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // Nothing interactive precedes it.
        const first = container.querySelector('a, button');
        expect(first).toBe(back);
    });

    it('the back link is a 44 px target on touch', () => {
        render(<HeaderSlotPage />);
        expect(backLinks()[0].className).toContain('pointer-coarse:min-h-11');
    });
});

describe('pages without a back link keep their breadcrumbs', () => {
    it('a MAIN page keeps its inline trail on a phone', () => {
        mockPathname = '/t/acme/controls';
        render(<InlineTrail items={CRUMBS.slice(0, 2)} />);
        expect(inlineCrumbs()).toHaveLength(1);
    });

    it('an exempt subpage (its trail IS its way back) keeps it too', () => {
        mockPathname = '/t/acme/tests/due';
        render(<InlineTrail items={CRUMBS} />);
        expect(inlineCrumbs()).toHaveLength(1);
    });
});

describe('the tenant app mounts the rule', () => {
    it('ClientProviders (which wraps every tenant page) applies it', () => {
        mockPathname = '/t/acme/controls/c1';
        render(
            <ClientProviders userId={null}>
                <PageBreadcrumbs items={CRUMBS} data-testid="inline-crumbs" />
            </ClientProviders>,
        );
        expect(inlineCrumbs()).toHaveLength(0);
    });
});

describe('outside the tenant app (no policy mounted)', () => {
    it('the shared header shows its trail: the default knows no routes', () => {
        mockPathname = '/t/acme/controls/c1';
        render(<PageHeader breadcrumbs={CRUMBS} title="AC-1" />);
        expect(inlineCrumbs()).toHaveLength(1);
    });
});

describe('phoneShowsBackLinkOnly covers the whole subpage population', () => {
    it('is true for every subpage that owes a back link, and only those', () => {
        const exempt = new Set<string>(BACK_AFFORDANCE_EXEMPT_SUBPAGES);
        // Substitute a value for each dynamic segment to get a runtime path.
        const runtime = (pattern: string) =>
            `/t/acme${pattern.replace(/\[[^\]]+\]/g, 'x1')}`;
        const wrong = SUBPAGES.filter(
            (p) => phoneShowsBackLinkOnly(runtime(p)) !== !exempt.has(p),
        );
        expect(wrong).toEqual([]);
        // Non-empty, or the check above proves nothing.
        expect(SUBPAGES.length).toBeGreaterThan(0);
    });
});
