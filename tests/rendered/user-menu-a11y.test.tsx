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
 *   aria-dialog-name  SERIOUS, best-practice — DID NOT REPRODUCE HERE
 *     #3254 reports it from projectZ, which vendors these files byte-identical.
 *     Measured here: removing `contentLabel` leaves axe green, because Radix
 *     already names its content — and jsdom (no `matchMedia`) mounts the MOBILE
 *     SHEET, not the desktop popover. See the third test for both figures.
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

        // NO ASSERTION ABOUT THE DIALOG'S NAME HERE, and that is a finding
        // rather than an omission. Two measurements, both of which this suite
        // can make and neither of which supports #3254's second violation:
        //
        //   1. axe `aria-dialog-name` does NOT reproduce. Removing
        //      `contentLabel` from UserMenu leaves the axe check above green,
        //      because Radix already names what it renders.
        //   2. jsdom has no `matchMedia`, so this harness renders the MOBILE
        //      SHEET, not the desktop popover content. The sheet carries its
        //      own `aria-labelledby`; `contentLabel` lands on the desktop
        //      `PopoverPrimitive.Content`, which never mounts here.
        //
        // So an assertion about it would either pass for the wrong reason (the
        // first draft accepted `aria-label ?? aria-labelledby` and could not
        // fail) or fail for the wrong one. `contentLabel` is kept as a
        // deliberate improvement on the desktop path — an explicit translated
        // name beats a generated id — and is explicitly NOT covered here.
    });
});
