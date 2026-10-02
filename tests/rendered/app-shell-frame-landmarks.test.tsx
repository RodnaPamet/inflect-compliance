/**
 * `AppShellFrame` landmark nesting (#3104).
 *
 * The frame composes four slots into one page, and three of them paint
 * landmarks: the rail is an `<aside>`, `topChrome` renders `NavBar`'s
 * `<header role="banner">`, and the content column is `<main>`. Landmarks are
 * a flat navigation surface for a screen-reader user — "jump to banner",
 * "jump to main" — so one containing another is a defect even when it looks
 * right on screen.
 *
 * It WAS wrong: `<main>` wrapped the whole main region, top bar included, so
 * the banner sat inside it. axe `landmark-banner-is-top-level`, measured
 * moderate by projectZ T19 against a byte-identical vendored copy, which had
 * to suppress that rule to keep its own suite green.
 *
 * ── WHY THIS TEST IS SHAPED THE WAY IT IS ───────────────────────────────────
 *
 * "The banner is not inside main" passes trivially in two worlds that are not
 * the fixed one: a frame that renders no banner at all, and a frame with no
 * `<main>`. Both are worse than the bug. So every nesting assertion here is
 * paired with an existence assertion, and the content is checked to be INSIDE
 * `<main>` — otherwise moving the landmark to wrap nothing would pass.
 */

import { render, screen } from '@testing-library/react';
import * as React from 'react';

jest.mock('next/navigation', () => ({
    usePathname: () => '/t/acme/controls',
}));

import { AppShellFrame } from '@/components/layout/AppShellFrame';

function renderFrame(opts: { fullBleed?: boolean } = {}) {
    return render(
        <AppShellFrame
            sidebar={({ collapsed }) => (
                <div data-testid="rail">{collapsed ? 'collapsed' : 'expanded'}</div>
            )}
            mobileNav={({ open }) => (open ? <div data-testid="drawer" /> : null)}
            // Stands in for `NavBar`, which is what carries the banner role in
            // production (`nav-bar.tsx`, and `nav-bar-import-discipline` forbids
            // a parallel one elsewhere). The frame never sees NavBar itself —
            // it only ever receives whatever the host puts in this slot.
            topChrome={() => (
                <header role="banner" data-testid="chrome">
                    <nav aria-label="Breadcrumb">crumbs</nav>
                </header>
            )}
            fullBleed={opts.fullBleed}
        >
            <h1 data-testid="page-content">Controls</h1>
        </AppShellFrame>,
    );
}

describe('AppShellFrame landmarks (#3104)', () => {
    it('renders exactly one main landmark', () => {
        renderFrame();
        expect(screen.getAllByRole('main')).toHaveLength(1);
    });

    it('paints a banner at all — the control the nesting check needs', () => {
        // Without this, "the banner is not inside main" would also hold for a
        // frame that dropped the top bar entirely.
        renderFrame();
        expect(screen.getByRole('banner')).toBeInTheDocument();
    });

    it('does NOT nest the banner inside main', () => {
        renderFrame();
        const main = screen.getByRole('main');
        const banner = screen.getByRole('banner');
        expect(main.contains(banner)).toBe(false);
        // And the other direction, since a banner wrapping main would be the
        // same class of defect with the operands swapped.
        expect(banner.contains(main)).toBe(false);
    });

    it('keeps the page content INSIDE main', () => {
        // The assertion that stops the landmark being moved onto an empty
        // element: narrowing `<main>` is only correct while it still holds the
        // content it names.
        renderFrame();
        const main = screen.getByRole('main');
        expect(main.contains(screen.getByTestId('page-content'))).toBe(true);
    });

    it('keeps the top bar and the rail inside the frame but outside main', () => {
        renderFrame();
        const main = screen.getByRole('main');
        expect(main.contains(screen.getByTestId('chrome'))).toBe(false);
        expect(main.contains(screen.getByTestId('rail'))).toBe(false);
        // Still rendered, just not under the main landmark.
        expect(screen.getByTestId('chrome')).toBeInTheDocument();
        expect(screen.getByTestId('rail')).toBeInTheDocument();
    });

    it('holds for fullBleed too, which changes the content container classes', () => {
        // `fullBleed` drops the width cap and centering on the very element that
        // now carries the landmark, so it is the one prop that could plausibly
        // move it.
        renderFrame({ fullBleed: true });
        const main = screen.getByRole('main');
        expect(main.contains(screen.getByRole('banner'))).toBe(false);
        expect(main.contains(screen.getByTestId('page-content'))).toBe(true);
    });

    it('leaves the layout chain on the element that always carried it', () => {
        // The fix swapped element NAMES, not classes. The main-region column is
        // the flex/overflow container and must keep being one; `<main>` keeps
        // the padding + scroll classes it already had. If a later edit "tidies"
        // these onto one element the chain documented in the source breaks, and
        // that is invisible in jsdom without pinning it here.
        renderFrame();
        const main = screen.getByRole('main');
        expect(main.className).toContain('md:overflow-y-auto');
        expect(main.className).toContain('md:flex-1');

        // Found by what it CONTAINS rather than by depth: the frame wraps the
        // top bar and the content in a fragment, which emits no DOM node, so
        // counting `parentElement` hops encodes a detail that is not the point.
        const column = main.parentElement;
        expect(column?.tagName).toBe('DIV');
        expect(column?.contains(screen.getByTestId('chrome'))).toBe(true);
        expect(column?.className).toContain('md:overflow-hidden');
        expect(column?.className).toContain('flex-1');
    });
});
