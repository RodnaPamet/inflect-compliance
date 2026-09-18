/**
 * #2610 — OrgSidebarNav off lucide, with a BEHAVIOURAL anchor.
 *
 * Seven tests referenced `OrgSidebarNav` before this file and every one of them
 * was a guard or a structural check: they `readFileSync` the source and match
 * text. That is the right tool for "this import is gone", and it is worthless
 * for "the component still renders" — a source-text guard passes just as
 * happily against a file whose icon import resolves to `undefined`.
 *
 * React is what makes this an executing test rather than another spelling of
 * the same grep: rendering `<undefined />` throws "Element type is invalid".
 * So mounting the sidebar with every nav entry visible, in BOTH collapse
 * states, is what actually proves all nine Nucleo glyphs resolve.
 *
 * `NavItem` is deliberately NOT mocked — it is the component that renders the
 * glyph (`<Icon className={NAV_ITEM_ICON_CLASS} />`), so mocking it would mock
 * away the only thing under test. Only non-icon scenery is stubbed.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

let mockCollapsed = false;

jest.mock('next/navigation', () => ({ usePathname: () => '/org/globex/' }));
jest.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
jest.mock('@/lib/org-context-provider', () => ({
    useOrgContext: () => ({
        orgName: 'Globex Org',
        orgSlug: 'globex',
        role: 'ORG_ADMIN',
        permissions: { canDrillDown: true, canManageMembers: true },
    }),
    useOrgHref: () => (p: string) => `/org/globex${p}`,
    // Every entry visible, so every glyph is exercised rather than filtered out.
    useOrgPermissions: () => ({ canDrillDown: true, canManageMembers: true }),
}));
jest.mock('@/components/layout/sidebar-collapse-context', () => ({
    useSidebarCollapsed: () => mockCollapsed,
}));
// Scenery, not icons: stubbed so a provider requirement cannot mask an icon fault.
jest.mock('@/components/org-switcher', () => ({ OrgSwitcher: () => <div data-testid="org-switcher" /> }));
jest.mock('@/components/ui/tooltip', () => ({
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { OrgSidebarContent } from '@/components/layout/OrgSidebarNav';

function mount(collapsed: boolean) {
    mockCollapsed = collapsed;
    return render(
        <OrgSidebarContent
            user={{ name: 'Ada' }}
            onLogout={() => {}}
            onToggleCollapse={() => {}}
        />,
    );
}

afterEach(() => { mockCollapsed = false; });

describe('OrgSidebarNav renders every Nucleo glyph it imports', () => {
    it('mounts EXPANDED with all seven nav entries, so seven glyphs really render', () => {
        const { container } = mount(false);

        // Seven nav rows + the collapse toggle + sign-out. If any icon import
        // were undefined, render() above would already have thrown.
        const links = container.querySelectorAll('a[href^="/org/globex"]');
        expect(links.length).toBe(7);

        // An <svg> per nav row is what proves the glyph COMPONENT ran, not just
        // that a row exists — a row whose icon failed would render without one.
        links.forEach((a) => expect(a.querySelector('svg')).not.toBeNull());

        // The denominator, stated: 7 nav + 1 toggle + 1 sign-out = 9 render
        // sites across 9 distinct imported symbols.
        expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(9);
    });

    it('mounts COLLAPSED — the branch a phone-default suite would otherwise never execute', () => {
        const { container } = mount(true);

        expect(screen.queryByTestId('org-switcher')).toBeNull();
        expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(9);
    });

    it('carries the toggle DIRECTION in aria, not in the glyph', () => {
        // This is the contract that let one Menu3 replace lucide's matched
        // PanelLeftClose/PanelLeftOpen pair. If a future change moved the
        // meaning back into the icon and dropped the per-state label, a blind
        // user would lose the direction entirely — so it is asserted, not assumed.
        const expanded = mount(false);
        const btnExpanded = expanded.getByTestId('sidebar-collapse-toggle');
        expect(btnExpanded.getAttribute('aria-label')).toBe('nav.collapseSidebar');
        expect(btnExpanded.getAttribute('aria-pressed')).toBe('false');
        // The glyph itself must stay out of the accessibility tree.
        expect(btnExpanded.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
        expanded.unmount();

        const collapsed = mount(true);
        const btnCollapsed = collapsed.getByTestId('sidebar-collapse-toggle');
        expect(btnCollapsed.getAttribute('aria-label')).toBe('nav.expandSidebar');
        expect(btnCollapsed.getAttribute('aria-pressed')).toBe('true');
    });
});
