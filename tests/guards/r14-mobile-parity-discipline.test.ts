/**
 * Roadmap-14 PR-12 — Mobile parity (unify dual chrome).
 *
 * Pre-R14: `<AppShell>` rendered a SEPARATE mobile-only top bar
 * with its own hamburger, brand wordmark, and theme toggle. The
 * desktop `<TopChrome>` was gated behind `hidden md:flex` and
 * never rendered on mobile.
 *
 * R14-PR12 unifies the two:
 *
 *   • `NAV_BAR_SHELL` no longer carries `hidden md:flex` — the
 *     NavBar renders on all viewports.
 *
 *   • A new `<NavBarMobileMenu>` component (the hamburger) lives
 *     in nav-bar.tsx, hidden at md+, shown below. TopChrome
 *     mounts it as the FIRST element of the left slot.
 *
 *   • Breadcrumbs collapse to hidden below md (the brand mark +
 *     env badge + hamburger already crowd the small viewport).
 *
 *   • Tenant switcher pill collapses to hidden below sm (the
 *     right-slot would otherwise be unworkably crowded on a
 *     375px iPhone SE viewport).
 *
 *   • The pre-R14 AppShell mobile-only top bar (a `<div
 *     className="md:hidden sticky top-0 ...">`) is DELETED. The
 *     ratchet at `top-chrome-discipline.test.ts` was updated in
 *     the same diff to enforce its absence.
 *
 *   • AppShell still owns the drawer-open state and passes an
 *     `onMobileMenuClick` handler through `<TopChrome>` to
 *     `<NavBarMobileMenu>`.
 *
 *   • Theme toggle's mobile mount moved to the `<UserMenu>` in
 *     R14-PR5; that single mount covers mobile + desktop.
 *
 * Six load-bearing invariants:
 *
 *   1. NavBar shell renders on all viewports (no `hidden md:flex`).
 *   2. `NavBarMobileMenu` component exists in nav-bar.tsx with
 *      `md:hidden` so it's only visible below md.
 *   3. TopChrome takes an `onMobileMenuClick` prop + passes it
 *      to NavBarMobileMenu.
 *   4. AppShell creates an `openDrawer` callback and threads it
 *      through TopChrome.
 *   5. AppShell no longer renders its own `<Menu>` button or
 *      mobile-only sticky bar.
 *   6. Tenant switcher pill carries `hidden sm:inline-flex` so
 *      it collapses on the narrowest viewports.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const NAV_BAR_SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/layout/nav-bar.tsx'),
    'utf8',
));
const TOP_CHROME_SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/layout/TopChrome.tsx'),
    'utf8',
));
const APP_SHELL_SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/layout/AppShell.tsx'),
    'utf8',
));
const SWITCHER_SRC = codeOf(fs.readFileSync(
    path.join(ROOT, 'src/components/layout/tenant-switcher.tsx'),
    'utf8',
));

describe('Roadmap-14 PR-12 — Mobile parity (unify dual chrome)', () => {
    describe('NAV_BAR_SHELL renders on all viewports', () => {
        it('does NOT include `hidden md:flex`', () => {
            // The R14-PR1 shell carried `hidden md:flex` which
            // gated the bar to md+. R14-PR12 retired the gate.
            const shellRegion =
                NAV_BAR_SRC.match(
                    /export\s+const\s+NAV_BAR_SHELL\s*=\s*\[[\s\S]+?\]\.join\(/,
                )?.[0] ?? '';
            expect(shellRegion).not.toBe('');
            expect(shellRegion).not.toMatch(/['"]hidden\s+md:flex['"]/);
        });

        it('uses plain `flex` (visible everywhere)', () => {
            const shellRegion =
                NAV_BAR_SRC.match(
                    /export\s+const\s+NAV_BAR_SHELL\s*=\s*\[[\s\S]+?\]\.join\(/,
                )?.[0] ?? '';
            expect(shellRegion).toMatch(/['"]flex['"]/);
        });
    });

    describe('NavBarMobileMenu component', () => {
        it('exports `NavBarMobileMenu` from nav-bar.tsx', () => {
            expect(NAV_BAR_SRC).toMatch(
                /export\s+function\s+NavBarMobileMenu\b/,
            );
        });

        it('uses `md:hidden` so it only renders below the md breakpoint', () => {
            // Counterpart of the retired `hidden md:flex` on the
            // shell — the menu button is the mobile-only piece.
            expect(NAV_BAR_SRC).toMatch(/NavBarMobileMenu[\s\S]+?md:hidden/);
        });

        it('renders the Menu (hamburger) icon from lucide', () => {
            expect(NAV_BAR_SRC).toMatch(
                /import\s+\{\s*Menu\s*\}\s+from\s+['"]lucide-react['"]/,
            );
        });

        it('takes an onClick prop + ariaLabel prop + dataTestId prop', () => {
            expect(NAV_BAR_SRC).toMatch(
                /export\s+interface\s+NavBarMobileMenuProps\s*\{[\s\S]+?onClick:[\s\S]+?ariaLabel[\s\S]+?dataTestId/,
            );
        });

        it('carries the shared press-feedback recipe', () => {
            // R14-PR11 invariant — every clickable chrome slot
            // composes NAV_BAR_SLOT_PRESS. The mobile menu button
            // is no exception.
            expect(NAV_BAR_SRC).toMatch(
                /NavBarMobileMenu[\s\S]+?NAV_BAR_SLOT_PRESS/,
            );
        });
    });

    describe('TopChrome wiring', () => {
        it('takes an `onMobileMenuClick` prop', () => {
            expect(TOP_CHROME_SRC).toMatch(
                /interface\s+TopChromeProps\s*\{[\s\S]+?onMobileMenuClick:/,
            );
        });

        it('destructures and passes onMobileMenuClick to NavBarMobileMenu', () => {
            // After the R14 hotfix the destructure also includes
            // the `user` prop (server-side session data threaded
            // through). The exact destructure shape is locked
            // permissively — variant + onMobileMenuClick must
            // appear in any order with other props allowed.
            expect(TOP_CHROME_SRC).toMatch(/\bvariant\b/);
            expect(TOP_CHROME_SRC).toMatch(/\bonMobileMenuClick\b/);
            expect(TOP_CHROME_SRC).toMatch(
                /<NavBarMobileMenu[\s\S]+?onClick=\{onMobileMenuClick\}/,
            );
        });

        it('imports NavBarMobileMenu alongside NavBar + NavBarBrand', () => {
            expect(TOP_CHROME_SRC).toMatch(
                /import\s+\{[^}]*\bNavBarMobileMenu\b[^}]*\}\s+from\s+['"]\.\/nav-bar['"]/,
            );
        });

        it('mounts NavBarMobileMenu BEFORE the brand mark in the left slot', () => {
            // Hamburger leads on mobile (it's the most discoverable
            // affordance for navigating). On desktop the hamburger
            // is hidden via `md:hidden`, so the brand mark visually
            // leads anyway.
            const menuIdx = TOP_CHROME_SRC.indexOf('<NavBarMobileMenu');
            const brandIdx = TOP_CHROME_SRC.indexOf('<NavBarBrand');
            expect(menuIdx).toBeGreaterThan(-1);
            expect(brandIdx).toBeGreaterThan(menuIdx);
        });

        it('Breadcrumbs are wrapped with `hidden md:inline-flex`', () => {
            // Mobile hides breadcrumbs — the left slot already
            // crowds with hamburger + brand + env badge.
            expect(TOP_CHROME_SRC).toMatch(
                /hidden\s+md:inline-flex[\s\S]+?<Breadcrumbs/,
            );
        });
    });

    describe('AppShell retired its mobile-only top bar', () => {
        it('no `md:hidden sticky top-0` sticky-bar wrapper', () => {
            // The retired mobile top bar had this exact class
            // sequence on a top-level div. A regression that
            // re-introduces it would re-stack two bars on mobile.
            expect(APP_SHELL_SRC).not.toMatch(
                /md:hidden\s+sticky\s+top-0/,
            );
        });

        it('no `<Menu>` icon import (the hamburger lives in NavBar now)', () => {
            // Pre-R14 AppShell imported `Menu` from lucide for its
            // own hamburger. With the mobile bar deleted, the
            // import is dead and the regression-class is "someone
            // re-adds the Menu icon to AppShell for a new mobile
            // bar."
            expect(APP_SHELL_SRC).not.toMatch(
                /from\s+['"]lucide-react['"][^;]*\bMenu\b/,
            );
            expect(APP_SHELL_SRC).not.toMatch(
                /import\s+\{[^}]*\bMenu\b[^}]*\}\s+from\s+['"]lucide-react['"]/,
            );
        });

        it('no `<ThemeToggle>` import (theme toggle moved to UserMenu)', () => {
            // R14-PR5 moved the theme toggle into the UserMenu.
            // The AppShell mobile bar used to mount its own
            // ThemeToggle; with the bar gone, the import is
            // unused and re-adding it would split the affordance
            // across two surfaces.
            expect(APP_SHELL_SRC).not.toMatch(
                /import\s+\{\s*ThemeToggle\s*\}\s+from\s+['"]@\/components\/theme\/ThemeToggle['"]/,
            );
        });

        it('creates an `openDrawer` callback and passes it to TopChrome', () => {
            // The drawer-open handler is what wires the
            // NavBarMobileMenu's click to the existing
            // MobileDrawer's open state. AppShell owns the state
            // (it's already in this file), threads through.
            expect(APP_SHELL_SRC).toMatch(
                /const\s+openDrawer\s*=\s*useCallback\(\s*\(\)\s*=>\s*setDrawerOpen\(true\)/,
            );
            expect(APP_SHELL_SRC).toMatch(
                /<TopChrome[\s\S]+?onMobileMenuClick=\{openDrawer\}/,
            );
        });
    });

    describe('tenant switcher collapses on narrow viewports', () => {
        it('carries `hidden sm:inline-flex` on the trigger', () => {
            // R14-PR12 hides the switcher pill on the narrowest
            // viewport. On iPhone SE (375px) the right-slot would
            // otherwise be unworkably crowded.
            expect(SWITCHER_SRC).toMatch(
                /SWITCHER_PILL_CLASS\s*=[\s\S]+?hidden\s+sm:inline-flex/,
            );
        });
    });
});
