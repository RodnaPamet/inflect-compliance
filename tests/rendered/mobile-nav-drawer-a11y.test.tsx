/** @jest-environment jsdom */

/**
 * The mobile navigation drawer must leave the accessibility tree AND the tab
 * order while it is closed, and must return focus when it closes.
 *
 * Succeeds `nav-drawer-closed-inert.test.tsx` (issue #2386), retargeted by T07
 * (#3076) when the drawer moved from the hand-rolled `MobileDrawer` onto the
 * shared left `Sheet`. The PROPERTIES are #2386's; what changed is the
 * mechanism that delivers them, and one of them no longer needs asserting.
 *
 * WHAT #2386 WAS GUARDING. `MobileDrawer` stayed mounted in both states — the
 * animation was a `translate-x` transform, so "closed" was a visual fact and
 * nothing more. A transform hides an element from nobody: the closed drawer
 * announced itself as an open modal dialog and every nav link was reachable by
 * Tab from every page in the product. The fix was an `inert` subtree, and that
 * file asserted it.
 *
 * WHY `inert` IS GONE RATHER THAN BROKEN. `Sheet` portals its panel and
 * unmounts it when closed, so there is no closed subtree to make inert. The
 * property survives — nothing reachable while closed — by a stronger route.
 *
 * THE TRAP THAT CHANGE WALKS INTO, named in #2386's own header: "every
 * negative here would pass trivially against a drawer that rendered nothing at
 * all". Under the old drawer the guard against that was asserting the node was
 * still IN the DOM. That is now false by design, so the OPEN case carries the
 * load instead: every closed-state absence below is paired with the same query
 * finding the thing once the drawer opens. Without that pairing this file would
 * pass against a `MobileNavDrawer` that returned `null`.
 *
 * The transform classes #2386 pinned are also gone, deliberately: the slide is
 * Sheet's now, and asserting inflect-side transform classes on a primitive's
 * animation would pin something this component does not own.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import * as React from 'react';
import { MobileNavDrawer } from '@/components/layout/MobileNavDrawer';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

function Harness({ open }: { open: boolean }) {
    return (
        <MobileNavDrawer open={open} onClose={jest.fn()}>
            <a href="/dashboard">Board</a>
        </MobileNavDrawer>
    );
}

describe('MobileNavDrawer — closed leaves the a11y tree and the tab order', () => {
    it('closed: no dialog and no nav link anywhere in the tree', () => {
        render(<Harness open={false} />);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
    });

    it('open: the SAME queries find a named dialog and the link', () => {
        // THE CONTROL for the test above. Both negatives there would hold
        // against a component that rendered nothing at all; these two
        // positives are what make them mean something.
        render(<Harness open />);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument();
    });

    it('open: the dialog carries an accessible name', () => {
        // Sheet renders a visually-hidden title, so the panel is announced as
        // something rather than as an unnamed dialog. There is no visible
        // header: the content IS the navigation, and a heading above it would
        // be chrome the desktop rail does not have.
        render(<Harness open />);
        expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBeTruthy();
    });
});

describe('MobileNavDrawer — focus returns to the opener', () => {
    // Close is driven by RE-RENDERING with `open={false}`, not by dispatching
    // Escape — the same way #2386's file drove it. Focus restore and the
    // Escape binding are separate properties, and coupling them would mean a
    // regression in either reddened both while naming only one.
    function FocusHarness({ open }: { open: boolean }) {
        return (
            <div>
                <button type="button" data-testid="hamburger">
                    menu
                </button>
                <button type="button" data-testid="elsewhere">
                    elsewhere
                </button>
                <MobileNavDrawer open={open} onClose={jest.fn()}>
                    <a href="/dashboard">Board</a>
                </MobileNavDrawer>
            </div>
        );
    }

    it('restores focus to the element that had it when the drawer opened', () => {
        const view = render(<FocusHarness open={false} />);
        const hamburger = screen.getByTestId('hamburger');
        hamburger.focus();
        expect(document.activeElement).toBe(hamburger);

        view.rerender(<FocusHarness open />);
        // The panel takes focus on open, so the opener is no longer holding it.
        expect(document.activeElement).not.toBe(hamburger);

        // Park focus on <body>, which is where a closing portal leaves it —
        // and the state the restore is guarded on.
        act(() => {
            (document.activeElement as HTMLElement)?.blur();
        });
        view.rerender(<FocusHarness open={false} />);

        expect(document.activeElement).toBe(hamburger);
    });

    it('does NOT steal focus on a mount that never opened', () => {
        // #2386's file asserted this with "focus moved somewhere legitimate
        // WHILE the drawer was open". That scenario is unreachable now and the
        // change is a correctness improvement, not a gap: `Sheet` is a modal
        // with a focus trap, so an attempt to focus an element outside the
        // panel is pulled straight back — measured, not assumed (a probe that
        // focused a sibling button mid-open found focus still on the panel).
        //
        // The guard in the component is still load-bearing for the case that
        // CAN happen: a drawer that was never opened holds no opener, so a
        // close-shaped render must not reach for one. Without the guard the
        // effect would call `.focus()` on whatever it last saw.
        const elsewhere = document.createElement('button');
        elsewhere.setAttribute('data-testid', 'outside');
        document.body.appendChild(elsewhere);
        elsewhere.focus();
        expect(document.activeElement).toBe(elsewhere);

        render(
            <MobileNavDrawer open={false} onClose={jest.fn()}>
                <a href="/dashboard">Board</a>
            </MobileNavDrawer>,
        );

        // Mounted closed, never opened — focus is somewhere legitimate and
        // stealing it would be its own bug.
        expect(document.activeElement).toBe(elsewhere);
        elsewhere.remove();
    });
});

describe('MobileNavDrawer — Escape goes through the shared shortcut system', () => {
    it('closes on Escape, routed through the provider rather than vaul', () => {
        // Wrapped in the provider because that is where the single
        // `window.keydown` listener lives, and dispatched on `window` for the
        // same reason — this is how the app arbitrates the key, so the test
        // exercises the real path. Vaul's own Escape is suppressed in the
        // component via `onEscapeKeyDown`, so the close seen here is the
        // shared binding firing, not the primitive's.
        const onClose = jest.fn();
        render(
            <KeyboardShortcutProvider>
                <MobileNavDrawer open onClose={onClose}>
                    <a href="/dashboard">Board</a>
                </MobileNavDrawer>
            </KeyboardShortcutProvider>,
        );
        // The `overlay` scope reads a `data-sheet-overlay` marker; Sheet's own
        // backdrop carries it, which is why the scope transferred unchanged.
        expect(document.querySelector('[data-sheet-overlay]')).not.toBeNull();

        act(() => {
            fireEvent.keyDown(window, { key: 'Escape' });
        });
        expect(onClose).toHaveBeenCalled();
    });
});

describe('MobileNavDrawer — a visible way out', () => {
    it('renders a close button with a focus-visible ring', () => {
        // Escape, a backdrop tap and a swipe all close the panel, but none is
        // an affordance a user can SEE. The drawer this replaced had a close
        // button and `tests/guards/sidebar-state-language.test.ts` asserts its
        // focus ring; body-only rendering would have dropped both silently.
        render(
            <MobileNavDrawer open onClose={jest.fn()}>
                <a href="/dashboard">Board</a>
            </MobileNavDrawer>,
        );
        const close = document.querySelector('[data-sheet-close]');
        expect(close).not.toBeNull();
        expect(close?.className).toContain('focus-visible:ring-2');
    });
});

describe('MobileNavDrawer — the testid contract the E2E suite scopes through', () => {
    it('exposes `nav-drawer` when open, and nothing when closed', () => {
        // THIS IS THE TEST THAT WAS MISSING. The drawer this replaced carried
        // `data-testid="nav-drawer"` on its panel, and
        // `tests/e2e/responsive.spec.ts` scopes its nav-item queries through
        // it. T07 dropped the attribute — vaul's `ContentProps` does not admit
        // a `data-*` on `Drawer.Content` — and the only thing that noticed was
        // E2E, on all three attempts, after the whole jest population had gone
        // green. A Playwright spec cannot be run by jest, so "population
        // green" never covered it.
        const { rerender } = render(
            <MobileNavDrawer open={false} onClose={jest.fn()}>
                <a href="/dashboard">Board</a>
            </MobileNavDrawer>,
        );
        expect(document.querySelectorAll('[data-testid="nav-drawer"]')).toHaveLength(0);

        rerender(
            <MobileNavDrawer open onClose={jest.fn()}>
                <a href="/dashboard">Board</a>
            </MobileNavDrawer>,
        );
        const handle = document.querySelector('[data-testid="nav-drawer"]');
        expect(handle).not.toBeNull();
        // The E2E scopes THROUGH it — `drawer.locator('[data-testid=...]')` —
        // so the children have to be inside it, not siblings of it.
        expect(handle?.querySelector('a[href="/dashboard"]')).not.toBeNull();
    });
});
