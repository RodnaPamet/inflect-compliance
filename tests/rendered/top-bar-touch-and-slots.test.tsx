/** @jest-environment jsdom */

/**
 * T08 (#3003) + #3114 — the top bar's touch targets, and the seams that open
 * this chrome to a second consumer.
 *
 * Four things, each a defect or a coupling the task that added it removed:
 *
 *   TOUCH TARGETS. The hamburger was 22x22 and the avatar trigger 22x22,
 *     against WCAG 2.5.5's 44x44 — the two interactive controls in the bar, at
 *     a quarter of the required area, one of them the only way to open
 *     navigation on a phone. `HIT_AREA_CLASS` was already on the avatar and did
 *     not help: it cures the DEAD ZONE inside a rounded box, not the size of
 *     the box. The floor is `pointer-coarse:` so the painted size is unchanged
 *     on a mouse.
 *
 *   `NavBarBrand.initials` IS REQUIRED. It defaulted to one product's
 *     initials, which cannot be right for a second consumer and meant a caller
 *     who forgot it rendered the WRONG brand instead of failing. The type now
 *     asks. Four call sites in this suite were caught by that change, which is
 *     the point.
 *
 *   `UserMenu` TAKES ROWS AND CAN BE CONTROLLED. Its security row named a
 *     route only this product has and its sign-out imported next-auth; both
 *     left for the host's `items` slot.
 *
 *   `UserMenu` TAKES ITS TRIGGER TOO (#3114). A phone tab bar opens the menu
 *     from an "Account" tab, not from the avatar, so the vendoring consumer
 *     was keeping the avatar as an inert invisible anchor and returning focus
 *     to its tab by hand. The `trigger` slot retires both halves of that —
 *     and the second half is why the slot takes an ELEMENT and routes it
 *     through `<Popover>`'s `asChild` Trigger: focus restore is then the
 *     primitive's, not the caller's.
 *
 * Asserted on the recipe for the touch floors rather than a computed box,
 * because jsdom has no layout: `getBoundingClientRect` is 0x0 here, so a size
 * assertion would pass against any class at all.
 */
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import * as React from 'react';
import { NavBarBrand, NavBarMobileMenu, NAV_BAR_SHELL, NAV_BAR_PADDING } from '@/components/layout/nav-bar';
import { UserMenu } from '@/components/layout/user-menu';
import { TooltipProvider } from '@/components/ui/tooltip';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/dashboard',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ tenantSlug: 'acme' }),
}));
jest.mock('@/components/layout/LocaleSwitcher', () => ({ LocaleSwitcher: () => null }));

describe('top bar — WCAG 2.5.5 touch targets', () => {
    it('the hamburger reaches 44px on a coarse pointer', () => {
        render(<NavBarMobileMenu onClick={jest.fn()} />);
        const cls = screen.getByTestId('nav-toggle').className;
        expect(cls).toContain('pointer-coarse:min-h-11');
        expect(cls).toContain('pointer-coarse:min-w-11');
        // POSITIVE CONTROL: the painted size is deliberately unchanged, so a
        // "fix" that simply enlarged the button for everyone would fail here.
        expect(cls).toContain('h-[22px]');
    });

    it('the bar clears the status bar and the landscape notch', () => {
        // `env(safe-area-inset-*)` is 0 wherever there is no inset, so this is
        // inert rather than conditional on a user-agent sniff.
        expect(NAV_BAR_SHELL).toContain('pt-[env(safe-area-inset-top)]');
        expect(NAV_BAR_PADDING).toContain('env(safe-area-inset-left)');
        expect(NAV_BAR_PADDING).toContain('env(safe-area-inset-right)');
        // `max()`, not a sum: adding the inset to the padding would double the
        // gap on a device whose inset already exceeds it.
        expect(NAV_BAR_PADDING).toContain('max(1rem,env(safe-area-inset-left))');
        // The height had to become a MINIMUM — a fixed `h-16` plus a top inset
        // eats the inset out of the content box and crushes the slots.
        expect(NAV_BAR_SHELL).toContain('min-h-16');
        expect(NAV_BAR_SHELL).not.toContain(' h-16');
    });
});

describe('NavBarBrand — the wordmark is the caller\'s', () => {
    it('renders the initials it is given, with no product default', () => {
        render(<NavBarBrand href="/x" initials="ZZ" />);
        expect(screen.getByTestId('nav-bar-brand').textContent).toBe('ZZ');
    });
});

describe('UserMenu — rows arrive from the host', () => {
    const base = { displayName: 'Ada', displayEmail: 'ada@x.test', displayImage: null };

    it('renders no product rows of its own', () => {
        render(
            <TooltipProvider>
                <UserMenu {...base} />
            </TooltipProvider>,
        );
        fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
        // The two that left. Their absence is the decoupling; the case below
        // proves the slot can put them back, so this is not vacuous.
        expect(screen.queryByTestId('user-menu-account-security')).toBeNull();
        expect(screen.queryByTestId('user-menu-sign-out')).toBeNull();
        // Still its own: the identity header, built from the props above.
        expect(screen.getByTestId('user-menu-display-name').textContent).toBe('Ada');
    });

    it('renders rows from `items`, and hands them a working `close`', () => {
        render(
            <TooltipProvider>
                <UserMenu
                    {...base}
                    items={({ close }) => (
                        <button type="button" data-testid="host-row" onClick={close}>
                            host row
                        </button>
                    )}
                />
            </TooltipProvider>,
        );
        fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
        const row = screen.getByTestId('host-row');
        expect(row).toBeInTheDocument();
        act(() => {
            fireEvent.click(row);
        });
        // `close` is the menu's own state; a row cannot reach it any other way,
        // which is why the slot is a render prop rather than a node.
        expect(screen.queryByTestId('host-row')).toBeNull();
    });

    it('is controllable, and ignores a half-supplied controlled pair', () => {
        const onOpenChange = jest.fn();
        const { rerender } = render(
            <TooltipProvider>
                <UserMenu {...base} open={false} onOpenChange={onOpenChange} />
            </TooltipProvider>,
        );
        expect(screen.queryByRole('menu')).toBeNull();
        rerender(
            <TooltipProvider>
                <UserMenu {...base} open onOpenChange={onOpenChange} />
            </TooltipProvider>,
        );
        expect(screen.getByRole('menu')).toBeInTheDocument();

        // `open` WITHOUT `onOpenChange` must stay uncontrolled. Honouring it
        // would give a menu that opens and can never be shut: the component
        // would read the caller's value with nowhere to report a close.
        rerender(
            <TooltipProvider>
                <UserMenu {...base} open />
            </TooltipProvider>,
        );
        fireEvent.click(screen.getByTestId('top-chrome-user-menu'));
        expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('hides the language row on request, with its separators', () => {
        const hostRow = () => (
            <button type="button" data-testid="host-row">
                host row
            </button>
        );
        const { unmount } = render(
            <TooltipProvider>
                <UserMenu {...base} open onOpenChange={jest.fn()} items={hostRow} />
            </TooltipProvider>,
        );
        // POSITIVE CONTROL: the default is unchanged — the row is there, and
        // so are the four hairlines it has always drawn with host rows.
        expect(screen.getByTestId('user-menu-language-row')).toBeInTheDocument();
        expect(screen.getAllByRole('separator')).toHaveLength(4);
        unmount();

        render(
            <TooltipProvider>
                <UserMenu {...base} open onOpenChange={jest.fn()} items={hostRow} showLanguage={false} />
            </TooltipProvider>,
        );
        expect(screen.queryByTestId('user-menu-language-row')).toBeNull();
        expect(screen.getByTestId('user-menu-theme-row')).toBeInTheDocument();
        // Header, theme, host rows: two hairlines, not two stacked together.
        expect(screen.getAllByRole('separator')).toHaveLength(2);
    });
});

describe('UserMenu — the trigger can arrive from the host (#3114)', () => {
    const base = { displayName: 'Ada', displayEmail: 'ada@x.test', displayImage: null };

    /**
     * The host's element: a tab button with its OWN class, which is the thing
     * playerz could not keep while the avatar had to stay as an invisible
     * anchor. `data-testid` so the absence of the avatar is assertable in the
     * same breath as the presence of this.
     */
    const accountTab = (
        <button type="button" data-testid="account-tab" className="phone-tab-account">
            Account
        </button>
    );

    it('the DEFAULT is still exactly the avatar, touch floor and all', () => {
        // POSITIVE CONTROL for every case below: the slot is additive, so the
        // no-`trigger` render must be the pre-#3114 one. Asserted on the
        // recipe, not a measured box — jsdom has no layout (see this file's
        // header), and `AVATAR_BUTTON_CLASS` is the only place the floor lives.
        render(
            <TooltipProvider>
                <UserMenu {...base} />
            </TooltipProvider>,
        );
        const cls = screen.getByTestId('top-chrome-user-menu').className;
        expect(cls).toContain('pointer-coarse:min-h-11');
        expect(cls).toContain('pointer-coarse:min-w-11');
        expect(cls).toContain('h-[22px]');
        expect(cls).toContain("before:content-['']");
    });

    it('renders the host trigger INSTEAD of the avatar, keeping its own class', () => {
        render(
            <TooltipProvider>
                <UserMenu {...base} trigger={accountTab} />
            </TooltipProvider>,
        );
        // The avatar is GONE rather than hidden. That is the whole point: the
        // inert invisible anchor playerz kept is what this retires.
        expect(screen.queryByTestId('top-chrome-user-menu')).toBeNull();
        const tab = screen.getByTestId('account-tab');
        // Radix's Slot concatenates, so the host's class survives alongside
        // the Trigger's own display utility.
        expect(tab.className).toContain('phone-tab-account');
    });

    it('the host trigger opens the menu, and the menu is the real one', () => {
        render(
            <TooltipProvider>
                <UserMenu
                    {...base}
                    trigger={accountTab}
                    items={() => (
                        <button type="button" data-testid="host-row">
                            host row
                        </button>
                    )}
                />
            </TooltipProvider>,
        );
        expect(screen.queryByRole('menu')).toBeNull();
        fireEvent.click(screen.getByTestId('account-tab'));
        // Not merely "something opened": the identity header and the `items`
        // slot both render, so the host trigger drives the same menu the
        // avatar drives rather than an empty surface.
        expect(screen.getByRole('menu')).toBeInTheDocument();
        expect(screen.getByTestId('user-menu-display-name').textContent).toBe('Ada');
        expect(screen.getByTestId('host-row')).toBeInTheDocument();
    });

    it('the host trigger carries the open state, so no `open` callback is owed', () => {
        // Why this slot is an element and not a render prop. The consumer's
        // tab needs to look active while the menu is open; it reads that off
        // the attributes the Trigger merges in, so the component has no state
        // left to hand out.
        render(
            <TooltipProvider>
                <UserMenu {...base} trigger={accountTab} />
            </TooltipProvider>,
        );
        const tab = screen.getByTestId('account-tab');
        expect(tab).toHaveAttribute('aria-expanded', 'false');
        expect(tab).toHaveAttribute('data-state', 'closed');
        fireEvent.click(tab);
        expect(screen.getByTestId('account-tab')).toHaveAttribute('data-state', 'open');
    });

    it('focus returns to the host trigger when the menu closes', async () => {
        // The reason the slot routes the element THROUGH the Trigger instead
        // of taking an `onOpen` callback. T07 had to capture an `openerRef` by
        // hand in `MobileNavDrawer` precisely because its opener was not its
        // Trigger; here it is, so the restore comes from the primitive.
        //
        // Measured on the DROPDOWN path, and the breakpoint is stubbed to get
        // there. jsdom reports no media query as matching, so `useMediaQuery`
        // resolves to `mobile` — every other case in this file runs through
        // `<Popover>`'s Vaul-drawer arm. That arm's exit is driven by a
        // transition jsdom never fires, so the panel stays mounted and the
        // close itself is unobservable there, let alone the focus that follows
        // it. Both arms hand the trigger to an `asChild` Trigger and both
        // restore focus to it; this is the one a test can watch.
        const realMatchMedia = window.matchMedia;
        window.matchMedia = ((query: string) => ({
            matches: true,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
        try {
            render(
                <TooltipProvider>
                    <UserMenu {...base} trigger={accountTab} />
                </TooltipProvider>,
            );
            const tab = screen.getByTestId('account-tab');
            act(() => {
                tab.focus();
            });
            // POSITIVE CONTROL for the restore below: focus starts on the tab,
            // so the final assertion would also pass if the menu had never
            // taken focus at all. It does take it — asserted in between.
            expect(document.activeElement).toBe(tab);
            act(() => {
                fireEvent.click(tab);
            });
            expect(screen.getByRole('menu')).toBeInTheDocument();
            // The stub actually landed: on the drawer arm `<Popover>` marks its
            // panel `data-popover-drawer`, and that arm cannot close here. A
            // silent fall-back to it would make the restore below untestable
            // while still reading as a pass, so it fails here instead.
            expect(document.querySelector('[data-popover-drawer]')).toBeNull();
            // Focus LEFT the tab for something real, which is what gives the
            // restore below its teeth: `toBe(tab)` at the end cannot be the
            // state the test started in.
            expect(document.activeElement).not.toBe(tab);
            expect(document.activeElement).not.toBe(document.body);
            // Closed from the trigger, which `fireEvent.click` does NOT focus
            // — so the tab regaining focus is the primitive restoring it to
            // its Trigger, not a side effect of the click. Radix defers that
            // restore by a macrotask, hence `waitFor` rather than a bare read.
            act(() => {
                fireEvent.click(screen.getByTestId('account-tab'));
            });
            expect(screen.queryByRole('menu')).toBeNull();
            await waitFor(() => {
                expect(document.activeElement).toBe(screen.getByTestId('account-tab'));
            });
        } finally {
            window.matchMedia = realMatchMedia;
        }
    });
});
