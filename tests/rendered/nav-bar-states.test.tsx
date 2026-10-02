/**
 * Roadmap-14 PR-13 — rendered tests for `<NavBar>` + slots.
 *
 * The capstone bundle ratchet at `r14-living-topbar-bundle.test.ts`
 * walks every R14 invariant at the source level. THIS test is the
 * runtime consumer: it mounts `<NavBar>` with realistic slot
 * children and asserts the recipe values flow into the rendered DOM.
 *
 * Three states covered:
 *
 *   1. **Bare shell** — empty slots. Asserts the three slot divs
 *      render regardless of content; the shell carries the
 *      load-bearing geometry + surface classes.
 *
 *   2. **Brand mark in left slot** — `<NavBarBrand>` with a
 *      tenant href. Asserts the Link element, aria-label, and
 *      brand recipe (gradient + glow + pulse).
 *
 *   3. **Mobile menu button in left slot** — `<NavBarMobileMenu>`
 *      with onClick handler. Asserts the hamburger button is
 *      `md:hidden`, carries the press-feedback recipe, and fires
 *      its onClick.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';

import {
    NavBar,
    NavBarBrand,
    NavBarMobileMenu,
    NAV_BAR_HEIGHT,
    NAV_BAR_SLOT_PRESS,
} from '@/components/layout/nav-bar';

describe('<NavBar>', () => {
    describe('bare shell', () => {
        it('renders three slot divs regardless of slot content', () => {
            const { container } = render(<NavBar />);
            // The shell MUST emit all three slots so the layout
            // is stable across empty / filled state transitions.
            const leftSlot = container.querySelector('[data-slot="left"]');
            const centerSlot = container.querySelector('[data-slot="center"]');
            const rightSlot = container.querySelector('[data-slot="right"]');
            expect(leftSlot).not.toBeNull();
            expect(centerSlot).not.toBeNull();
            expect(rightSlot).not.toBeNull();
        });

        it('renders a `<header role="banner">` landmark', () => {
            render(<NavBar />);
            const header = screen.getByRole('banner');
            expect(header).not.toBeNull();
            expect(header.tagName).toBe('HEADER');
        });

        it('carries the load-bearing geometry on the shell', () => {
            render(<NavBar />);
            const header = screen.getByRole('banner');
            // R14-PR2 height token.
            expect(header.className).toContain(NAV_BAR_HEIGHT);
            // R14-PR2 position + R14-PR10 glass surface.
            expect(header.className).toMatch(/sticky\s+top-0\s+z-30/);
            expect(header.className).toContain('bg-bg-page/80');
            expect(header.className).toContain('backdrop-blur-sm');
        });

        it('the shell is `relative` so the absolute pseudos anchor', () => {
            render(<NavBar />);
            const header = screen.getByRole('banner');
            expect(header.className).toContain('relative');
        });
    });

    describe('NavBarBrand', () => {
        it('renders a `<Link>` with the 3-stop brand gradient + glow + pulse', () => {
            render(
                <NavBar
                    left={<NavBarBrand href="/t/foo/dashboard" initials="IC" />}
                />,
            );
            // next/link renders an <a> element with the className
            // passed through.
            const link = screen.getByRole('link', {
                name: /Inflect Compliance/i,
            });
            expect(link).not.toBeNull();
            const cls = link.className;
            // Brand gradient (3 stops).
            expect(cls).toContain('from-[var(--brand-default)]');
            expect(cls).toContain('via-[var(--brand-muted)]');
            expect(cls).toContain('to-[var(--brand-emphasis)]');
            // Outer glow.
            expect(cls).toContain('shadow-[var(--nav-band-glow)]');
            // 6s pulse via background-position pan.
            expect(cls).toContain('animate-nav-brand-pulse');
            // Press-feedback recipe (R14-PR11).
            expect(cls).toContain('active:translate-y-px');
        });

        it('the brand mark uses `href` to navigate to the variant root', () => {
            render(
                <NavBar
                    left={<NavBarBrand href="/t/foo/dashboard" initials="IC" />}
                />,
            );
            const link = screen.getByRole('link', {
                name: /Inflect Compliance/i,
            });
            expect(link.getAttribute('href')).toBe('/t/foo/dashboard');
        });

        it('shows the "IC" initials as aria-hidden decoration', () => {
            render(
                <NavBar
                    left={<NavBarBrand href="/t/foo/dashboard" initials="IC" />}
                />,
            );
            const link = screen.getByRole('link', {
                name: /Inflect Compliance/i,
            });
            const initials = link.querySelector('span[aria-hidden="true"]');
            expect(initials?.textContent).toBe('IC');
        });
    });

    describe('NavBarMobileMenu', () => {
        it('renders a `<button>` with `md:hidden`', () => {
            const onClick = jest.fn();
            render(
                <NavBar left={<NavBarMobileMenu onClick={onClick} />} />,
            );
            const button = screen.getByRole('button', {
                name: 'Open navigation menu',
            });
            expect(button).not.toBeNull();
            expect(button.className).toContain('md:hidden');
        });

        it('carries the press-feedback recipe (R14-PR11 invariant)', () => {
            render(
                <NavBar left={<NavBarMobileMenu onClick={() => {}} />} />,
            );
            const button = screen.getByRole('button', {
                name: 'Open navigation menu',
            });
            // The full recipe is in NAV_BAR_SLOT_PRESS; the
            // hamburger composes it via template-literal
            // interpolation.
            for (const token of NAV_BAR_SLOT_PRESS.split(' ')) {
                expect(button.className).toContain(token);
            }
        });

        it('fires the onClick handler when pressed', () => {
            const onClick = jest.fn();
            render(
                <NavBar left={<NavBarMobileMenu onClick={onClick} />} />,
            );
            const button = screen.getByRole('button', {
                name: 'Open navigation menu',
            });
            fireEvent.click(button);
            expect(onClick).toHaveBeenCalledTimes(1);
        });

        it('respects the custom `dataTestId` prop', () => {
            const { container } = render(
                <NavBar
                    left={
                        <NavBarMobileMenu
                            onClick={() => {}}
                            dataTestId="org-nav-toggle"
                        />
                    }
                />,
            );
            const button = container.querySelector(
                '[data-testid="org-nav-toggle"]',
            );
            expect(button).not.toBeNull();
        });

        it('respects the custom `ariaLabel` prop', () => {
            render(
                <NavBar
                    left={
                        <NavBarMobileMenu
                            onClick={() => {}}
                            ariaLabel="Open organization navigation menu"
                        />
                    }
                />,
            );
            const button = screen.getByRole('button', {
                name: 'Open organization navigation menu',
            });
            expect(button).not.toBeNull();
        });
    });

    describe('full composition', () => {
        it('all three slots can be filled independently', () => {
            const { container } = render(
                <NavBar
                    left={<span data-testid="left-content">L</span>}
                    center={<span data-testid="center-content">C</span>}
                    right={<span data-testid="right-content">R</span>}
                />,
            );
            const leftSlot = container.querySelector('[data-slot="left"]');
            const centerSlot = container.querySelector('[data-slot="center"]');
            const rightSlot = container.querySelector('[data-slot="right"]');

            expect(
                leftSlot?.querySelector('[data-testid="left-content"]'),
            ).not.toBeNull();
            expect(
                centerSlot?.querySelector('[data-testid="center-content"]'),
            ).not.toBeNull();
            expect(
                rightSlot?.querySelector('[data-testid="right-content"]'),
            ).not.toBeNull();
        });
    });
});
