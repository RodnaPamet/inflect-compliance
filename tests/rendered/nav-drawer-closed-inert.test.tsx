/**
 * Issue #2386 — the mobile navigation drawer must leave the accessibility tree
 * AND the tab order while it is closed.
 *
 * `MobileDrawer` stays mounted in both states because the open/close animation
 * is a `translate-x` transform, so "closed" is a visual fact and nothing more:
 * a transform hides an element from nobody. Before the fix the closed drawer
 * still announced itself as an open modal dialog (`role="dialog"` +
 * `aria-modal="true"`, the second of which additionally claims the rest of the
 * page is inert), and its close button plus every nav link `AppShell` passes in
 * as `children` were reachable by Tab from every page in the product — focus
 * landing on something the user cannot see. Playwright found it the same way
 * this file does: `getByRole('dialog')` resolved to the drawer.
 *
 * Both directions are asserted from the same component, because every negative
 * here would pass trivially against a drawer that rendered nothing at all:
 *
 *   • CLOSED — no dialog, no close button and no nav link in the accessibility
 *     tree; the subtree is `inert`; and the drawer node plus its focusable
 *     controls are demonstrably still IN the DOM, which is what makes the three
 *     absences mean something.
 *   • OPEN — the dialog is back with its accessible name, `aria-modal` is
 *     asserted again, the close button really takes focus, and the nav link is
 *     queryable by role.
 *
 * Each case also pins the transform class for its state. The animation is
 * deliberate; a "fix" that swapped it for `hidden` would satisfy every a11y
 * assertion above while changing what the user sees.
 *
 * One limitation, stated rather than papered over: jsdom 26 does not implement
 * `inert` — it neither reflects the IDL property nor refuses focus — so
 * `closeButton.focus()` inside a closed drawer would SUCCEED here against
 * markup a real browser refuses. The tab-order assertion therefore applies the
 * browser's own rule (an element inside an `[inert]` subtree is not focusable)
 * to every focusable control the drawer actually contains, and `tests/e2e`
 * exercises the real engine.
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

// next-intl is ESM (jest cannot parse it); mock it resolving real en.json
// values. `make` is MEMOISED per namespace — a fresh `t` identity on every
// render invalidates the `useMemo([t])` that builds the columns, which turns a
// render into a loop rather than a failure.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key
            .split('.')
            .reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en[ns],
            );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/dashboard',
    useSearchParams: () => new URLSearchParams(),
}));

import { MobileDrawer } from '@/components/layout/SidebarNav';

// The close button the drawer renders itself, plus anything a caller passes as
// `children` — `AppShell` passes the whole sidebar, i.e. a dozen nav links.
const FOCUSABLE =
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Labels come from the real `nav` catalog via the next-intl mock above. */
const CLOSE_LABEL = 'Close navigation';
const DIALOG_LABEL = 'Navigation menu';

function renderDrawer(open: boolean) {
    render(
        <MobileDrawer open={open} onClose={jest.fn()}>
            {/* Stands in for the sidebar `AppShell` supplies — the descendants
                a per-element `tabIndex={-1}` sweep would have to reach. */}
            <a href="#dashboard">Dashboard</a>
        </MobileDrawer>,
    );
    const drawer = screen.getByTestId('nav-drawer');
    const controls = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE));
    return { drawer, controls };
}

describe('MobileDrawer — closed drawer leaves the a11y tree and the tab order', () => {
    describe('closed', () => {
        it('still renders the drawer and its controls into the DOM', () => {
            // The positive companion for every absence below. If this render
            // produced nothing, the three `queryByRole` nulls and the
            // "no control is focusable" loop would all pass while proving
            // nothing whatsoever.
            const { drawer, controls } = renderDrawer(false);
            expect(drawer).toBeInTheDocument();
            // The drawer's own close button + the caller-supplied nav link.
            expect(controls.length).toBeGreaterThanOrEqual(2);
            expect(drawer.querySelector('[data-testid="nav-drawer-close"]')).not.toBeNull();
            expect(drawer.textContent).toContain('Dashboard');
        });

        it('is absent from the accessibility tree', () => {
            renderDrawer(false);
            // Role queries exclude an `aria-hidden` subtree, which is exactly
            // the question a screen reader (and Playwright's role engine) asks.
            expect(screen.queryByRole('dialog')).toBeNull();
            expect(screen.queryByRole('button', { name: CLOSE_LABEL })).toBeNull();
            expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
        });

        it('does not claim `aria-modal` while the page behind it is live', () => {
            // `aria-modal="true"` asserts everything OUTSIDE the drawer is
            // inert. Closed, that is simply untrue, and a screen reader acting
            // on it hides the whole page from the user.
            const { drawer } = renderDrawer(false);
            expect(drawer).not.toHaveAttribute('aria-modal');
        });

        it('takes every focusable control out of the tab order via `inert`', () => {
            const { drawer, controls } = renderDrawer(false);
            expect(drawer).toHaveAttribute('inert');
            // jsdom does not implement `inert`, so apply the browser rule the
            // attribute buys: no control may sit outside an inert subtree.
            for (const el of controls) {
                expect(el.closest('[inert]')).toBe(drawer);
            }
        });

        it('keeps the off-screen transform — the animation is unchanged', () => {
            const { drawer } = renderDrawer(false);
            expect(drawer.className).toMatch(/-translate-x-full/);
            expect(drawer.className).toMatch(/transition-transform/);
        });
    });

    describe('open', () => {
        it('is a named dialog in the accessibility tree, with its controls reachable', () => {
            const { drawer } = renderDrawer(true);
            expect(screen.getByRole('dialog', { name: DIALOG_LABEL })).toBe(drawer);
            expect(drawer).toHaveAttribute('aria-modal', 'true');
            expect(drawer).not.toHaveAttribute('aria-hidden');
            expect(drawer).not.toHaveAttribute('inert');

            const close = screen.getByRole('button', { name: CLOSE_LABEL });
            close.focus();
            expect(document.activeElement).toBe(close);

            expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
        });

        it('keeps the on-screen transform — the animation is unchanged', () => {
            const { drawer } = renderDrawer(true);
            expect(drawer.className).toMatch(/translate-x-0/);
            expect(drawer.className).toMatch(/transition-transform/);
        });
    });

    describe('focus returns to the opener when it closes', () => {
        // The other half of `inert`, not a separate nicety. Focus does not
        // survive its own container becoming inert — the browser drops it to
        // `<body>` — so without this a keyboard user who opened the drawer and
        // closed it lands at the top of the document. It was invisible before
        // because focus simply stayed on an off-screen element instead: one
        // broken behaviour hiding another.
        function renderWithOpener(open: boolean) {
            const view = render(
                <>
                    <button type="button" data-testid="opener">
                        Menu
                    </button>
                    <MobileDrawer open={open} onClose={jest.fn()}>
                        <a href="#dashboard">Dashboard</a>
                    </MobileDrawer>
                </>,
            );
            return { view, opener: screen.getByTestId('opener') };
        }

        it('restores focus to the element that had it when the drawer opened', () => {
            const { view, opener } = renderWithOpener(false);
            opener.focus();
            expect(document.activeElement).toBe(opener);

            view.rerender(
                <>
                    <button type="button" data-testid="opener">
                        Menu
                    </button>
                    <MobileDrawer open onClose={jest.fn()}>
                        <a href="#dashboard">Dashboard</a>
                    </MobileDrawer>
                </>,
            );
            // What the browser does when the subtree it holds goes inert.
            (document.activeElement as HTMLElement | null)?.blur();
            expect(document.activeElement).toBe(document.body);

            view.rerender(
                <>
                    <button type="button" data-testid="opener">
                        Menu
                    </button>
                    <MobileDrawer open={false} onClose={jest.fn()}>
                        <a href="#dashboard">Dashboard</a>
                    </MobileDrawer>
                </>,
            );
            expect(document.activeElement).toBe(opener);
        });

        it('does NOT steal focus that moved somewhere legitimate', () => {
            // Companion to the assertion above, and the reason the effect is
            // conditional. A close the user did not trigger from inside the
            // drawer — a route change, say — leaves focus somewhere real, and
            // yanking it back to the hamburger would be its own bug.
            const { view, opener } = renderWithOpener(false);
            opener.focus();

            view.rerender(
                <>
                    <button type="button" data-testid="opener">
                        Menu
                    </button>
                    <MobileDrawer open onClose={jest.fn()}>
                        <a href="#dashboard">Dashboard</a>
                    </MobileDrawer>
                </>,
            );

            const elsewhere = document.createElement('button');
            elsewhere.setAttribute('data-testid', 'elsewhere');
            document.body.appendChild(elsewhere);
            elsewhere.focus();
            expect(document.activeElement).toBe(elsewhere);

            view.rerender(
                <>
                    <button type="button" data-testid="opener">
                        Menu
                    </button>
                    <MobileDrawer open={false} onClose={jest.fn()}>
                        <a href="#dashboard">Dashboard</a>
                    </MobileDrawer>
                </>,
            );
            expect(document.activeElement).toBe(elsewhere);
        });
    });
});
