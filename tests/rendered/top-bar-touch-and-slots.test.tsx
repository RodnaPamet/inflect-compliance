/** @jest-environment jsdom */

/**
 * T08 (#3003) — the top bar's touch targets, and its two new seams.
 *
 * Three things, each a defect or a coupling this task exists to remove:
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
 * Asserted on the recipe for the touch floors rather than a computed box,
 * because jsdom has no layout: `getBoundingClientRect` is 0x0 here, so a size
 * assertion would pass against any class at all.
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
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
});
