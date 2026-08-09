/** @jest-environment jsdom */

/**
 * `<NavItem>` prefetches its route on INTENT, never on mount.
 *
 * THE REGRESSION THIS EXISTS FOR
 * ------------------------------
 * The sidebar used a bare `prefetch` (Next's "always, fully" setting) on every
 * nav item. The sidebar is always in the viewport, so each page load kicked off
 * a full-RSC prefetch of all fourteen routes at once — fourteen RSC payloads
 * and their whole chunk graphs, to serve the one route the user might click.
 *
 * Production reported the bill directly. Chrome logged roughly 1,400 of
 * "The resource … was preloaded using link preload but not used within a few
 * seconds from the window's load event" per page load, which is what sent us
 * looking in the first place.
 *
 * Hovering (or tab-focusing) a nav item is the real signal a click is coming,
 * and it precedes the click by far more than a prefetch needs. So the
 * instant-nav lever survives for the route being navigated to, and the other
 * thirteen are never fetched.
 *
 * The mount assertion is the load-bearing one: the old implementation would
 * pass every hover test here and still flood the console.
 */

const prefetch = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        prefetch,
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
    }),
}));

import { render, screen, fireEvent } from '@testing-library/react';
import { Settings } from 'lucide-react';
import * as React from 'react';

import { NavItem } from '@/components/layout/nav-item';

const HREF = '/t/acme/controls';

function renderNav() {
    return render(
        <NavItem href={HREF} icon={Settings} label="Controls" active={false} />,
    );
}

function link() {
    return screen.getByRole('link', { name: /controls/i });
}

beforeEach(() => prefetch.mockClear());

describe('<NavItem> prefetches on intent', () => {
    it('does NOT prefetch on mount — the fourteen-routes-per-page-load regression', () => {
        renderNav();
        expect(prefetch).not.toHaveBeenCalled();
    });

    it('opts out of Next\'s automatic viewport prefetch', () => {
        // `prefetch={false}` is what stops Next prefetching the route just
        // because the sidebar is on screen. Without it the mount assertion
        // above passes while Next still fetches behind our back.
        const src = require('node:fs').readFileSync(
            require('node:path').resolve(
                __dirname,
                '../../src/components/layout/nav-item.tsx',
            ),
            'utf8',
        );
        expect(src).toMatch(/prefetch=\{false\}/);
    });

    it('prefetches the route when the pointer arrives', () => {
        renderNav();
        fireEvent.mouseEnter(link());
        expect(prefetch).toHaveBeenCalledTimes(1);
        expect(prefetch).toHaveBeenCalledWith(HREF);
    });

    it('prefetches on keyboard focus too — tabbing is intent as much as hovering', () => {
        renderNav();
        fireEvent.focus(link());
        expect(prefetch).toHaveBeenCalledTimes(1);
        expect(prefetch).toHaveBeenCalledWith(HREF);
    });

    it('prefetches at most once, however many times intent is signalled', () => {
        // Badges tick on a poll, so NavItem re-renders regularly; a hover that
        // re-fired on every render would put the waste straight back.
        renderNav();
        const el = link();
        fireEvent.mouseEnter(el);
        fireEvent.focus(el);
        fireEvent.mouseEnter(el);
        expect(prefetch).toHaveBeenCalledTimes(1);
    });
});
