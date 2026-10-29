/**
 * THE OPEN ACCOUNT MENU, CHECKED BY AXE (#3254).
 *
 * Two violations lived here because nothing exercised the menu in its OPEN
 * state. A closed popover renders no content, so every existing axe check over
 * this chrome passed over an empty subtree — the rules were never suppressed,
 * they simply had nothing to see.
 *
 *   aria-required-children  CRITICAL, wcag2a / WCAG 1.3.1
 *     `Popover.Menu` is `role="menu"`, which may own only menuitem,
 *     menuitemcheckbox, menuitemradio, group and separator. The theme row put
 *     a plain `button` inside it and the language row a `[role=radiogroup]`.
 *     The theme row alone was enough, so EVERY UserMenu had this.
 *
 *   aria-dialog-name  SERIOUS, best-practice — reproduces on the DESKTOP path
 *     #3254 reports it from projectZ, which vendors these files byte-identical.
 *     This suite first recorded it as "did not reproduce", on two measurements
 *     that were taken on the wrong element. Both are corrected below and the
 *     last test now covers it.
 *
 * ── WHY THE ROLE STAYS AND THE ROWS MOVE ───────────────────────────────────
 *
 * The tempting fix is to drop `role="menu"` on the grounds that a settings
 * panel is not a menu. That would be wrong here: `moveMenuFocus` in
 * `popover.tsx` implements the real ARIA menu pattern — ArrowDown/ArrowUp/
 * Home/End with wrapping, skipping disabled items — so the role is a promise
 * the component KEEPS. Dropping it would discard working keyboard navigation
 * to satisfy a linter.
 *
 * So the menu keeps its role and the two settings rows move out of it, which
 * is also the honest description: a theme toggle and a language radiogroup are
 * controls, not commands.
 */
import * as React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { axe } from 'jest-axe';

let mockParams: Record<string, string> = { tenantSlug: 'acme' };
jest.mock('next/navigation', () => ({
    useParams: () => mockParams,
    usePathname: () => '/t/acme/controls',
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));
jest.mock('@/components/layout/notifications-bell', () => ({ NotificationsBell: () => null }));

// Mutable so the tests measured on the MOBILE sheet keep that environment and
// only the desktop test flips it. `popover.tsx` swaps its whole implementation
// on `isMobile` — Vaul drawer vs Radix popover — so this is the switch between
// two different elements, which is the whole point of the last test.
let mockDevice: 'mobile' | 'tablet' | 'desktop' = 'mobile';
jest.mock('@inflect/ui/components/ui/hooks/use-media-query', () => ({
    useMediaQuery: () => ({
        device: mockDevice,
        width: mockDevice === 'mobile' ? 375 : 1440,
        height: 800,
        isMobile: mockDevice === 'mobile',
        isTablet: mockDevice === 'tablet',
        isDesktop: mockDevice === 'desktop',
    }),
}));

import { TopChrome } from '@/components/layout/TopChrome';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPermissionsForRole } from '@/lib/permissions';

const user = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    image: null,
    memberships: [{ slug: 'acme', role: 'EDITOR', tenantId: 'tenant-1' }],
    orgMemberships: [],
};

function renderOpenMenu() {
    const view = render(
        <TooltipProvider>
            <TenantProvider
                value={{
                    userId: 'u-ada',
                    tenantId: 'tenant-1',
                    tenantSlug: 'acme',
                    tenantName: 'Acme',
                    role: 'EDITOR',
                    permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: false },
                    appPermissions: getPermissionsForRole('EDITOR'),
                    modules: { processCanvas: false },
                }}
            >
                <TopChrome variant="tenant" user={user} onMobileMenuClick={jest.fn()} onLogout={jest.fn()} />
            </TenantProvider>
        </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
    return view;
}

describe('the OPEN account menu is accessible (#3254)', () => {
    afterEach(() => {
        mockParams = { tenantSlug: 'acme' };
        mockDevice = 'mobile';
    });

    it('renders its content, so the axe check below is not over an empty subtree', () => {
        // The denominator. A popover that failed to open would make every
        // assertion here vacuous, and that is the way this check would rot.
        renderOpenMenu();
        expect(screen.getByRole('menu', { name: 'Account menu' })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: 'Account security' })).toBeInTheDocument();
    });

    it('has no axe violations with the menu open', async () => {
        renderOpenMenu();
        // Radix PORTALS the content, so `container` would miss the popover and
        // pass over nothing. But `document.body` is not the answer either:
        // axe-core over the whole chrome exhausted a 4 GB worker heap here.
        // The subject is the popover itself — cheaper AND the precise thing
        // #3254 is about.
        const dialog = document.querySelector('[role=dialog]');
        expect(dialog).not.toBeNull();
        const results = await axe(dialog as HTMLElement);
        expect(results).toHaveNoViolations();
    });

    it('keeps role=menu owning only menu children', async () => {
        renderOpenMenu();
        const menu = screen.getByRole('menu', { name: 'Account menu' });

        // The settings controls are OUT of the menu — this is the structural
        // half, asserted directly so a future edit that moves them back fails
        // here with a sentence rather than only as an axe rule id.
        expect(menu.querySelector('#user-menu-theme-toggle')).toBeNull();
        expect(menu.querySelector('[role=radiogroup]')).toBeNull();

        // ...but still present in the popover, which is the point: moving them
        // out must not mean dropping them.
        expect(document.querySelector('#user-menu-theme-toggle')).not.toBeNull();

        // THE DIALOG'S NAME IS COVERED BY THE NEXT TEST, not here, because
        // `popover.tsx` renders a different element on each path and this one
        // runs on the mobile sheet. The two measurements that used to justify
        // skipping it were both taken on that sheet:
        //
        //   1. "removing `contentLabel` leaves axe green, because Radix
        //      already names its content" — true, and about the SHEET, which
        //      Vaul names with a generated `aria-labelledby`. `contentLabel`
        //      never reaches that element, so the mutation could not have
        //      changed anything and the green was not evidence about it.
        //   2. "jsdom has no `matchMedia`" — it does: `tests/rendered/setup.ts`
        //      polyfills it answering `matches: false` to every query, and
        //      `useMediaQuery` falls back to `mobile` when neither its
        //      `min-width` query matches. So the sheet mounts by DEFAULT rather
        //      than by impossibility, and overriding the hook reaches the
        //      desktop path — which 17 sibling suites in this directory already
        //      do.
        //
        // Measured on the two paths, which is what makes them distinguishable:
        //   mobile  `data-vaul-drawer`, `aria-labelledby=radix-_r_4_`
        //   desktop `[data-radix-popper-content-wrapper]`, `aria-label=Account menu`
    });

    it('names the desktop popover content, where `contentLabel` actually lands', async () => {
        mockDevice = 'desktop';
        renderOpenMenu();

        // POSITIVE CONTROL first: without it this test would silently assert
        // against the mobile sheet if the device mock ever stopped taking
        // effect, and the sheet is named too — so it would pass for the wrong
        // reason, which is exactly how this rule got recorded as "did not
        // reproduce".
        expect(document.querySelector('[data-radix-popper-content-wrapper]')).not.toBeNull();
        expect(document.querySelector('[data-vaul-drawer]')).toBeNull();

        const dialog = document.querySelector('[role=dialog]');
        expect(dialog).not.toBeNull();

        // The SPECIFIC translated name, not merely "has a name". An earlier
        // draft of this file accepted `aria-label ?? aria-labelledby` and
        // could not fail: Radix always supplies one of the two.
        expect(dialog).toHaveAttribute('aria-label', 'Account menu');

        const results = await axe(dialog as HTMLElement);
        expect(results).toHaveNoViolations();
    });
});
