/**
 * Epic 57 — command palette shortcut badges (final-hardening tests).
 *
 * Navigation/Actions rows surface keycap badges when a registered
 * shortcut's `description` matches the row's `label` exactly. The
 * registry stays the single source of truth — the palette only
 * renders what's there. These tests cover:
 *
 *   - Matching registered shortcut → badge shows on the action row
 *   - Matching shortcut is NOT also listed in the "Keyboard shortcuts"
 *     group (dedupe — one surface per affordance)
 *   - Rows without a matching shortcut render nothing extra (no
 *     phantom badges, no layout noise)
 *   - The palette's own `mod+k` is still filtered out of the shortcut
 *     group (invocation isn't a first-class command)
 */

const navigationMock = {
    pathname: '/t/demo/dashboard',
    push: jest.fn(),
};
jest.mock('next/navigation', () => ({
    usePathname: () => navigationMock.pathname,
    useRouter: () => ({
        push: (href: string) => navigationMock.push(href),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

// Mock next-auth/react so the palette's Sign-out action doesn't pull the
// real module (ESM boundary in jsdom).
jest.mock('next-auth/react', () => ({
    signOut: jest.fn(),
    signIn: jest.fn(),
}));

// jsdom's `navigator.userAgent` is "jsdom"-branded, so the palette's
// internal `isMac()` check returns false → `mod` renders as `Ctrl`.
// No explicit override needed.

import React from 'react';
import { render } from '@testing-library/react';

import {
    KeyboardShortcutProvider,
    useKeyboardShortcut,
} from '@/lib/hooks/use-keyboard-shortcut';
import {
    CommandPalette,
    CommandPaletteProvider,
    useCommandPalette,
} from '@/components/command-palette';

function Registrar() {
    // Exactly match the palette action label so the lookup finds it.
    useKeyboardShortcut('mod+shift+t', () => {}, {
        description: 'Toggle theme',
    });
    // Extra keep-in-shortcut-group entry (no matching palette row). The KEY is
    // incidental — only the description is asserted — and a bare printable
    // cannot be registered globally any more (WCAG 2.1.4), so it carries a
    // modifier rather than being scoped to a region this harness does not have.
    useKeyboardShortcut('mod+shift+f', () => {}, {
        description: 'Open filters',
    });
    return null;
}

function OpenPalette() {
    const { open } = useCommandPalette();
    React.useEffect(() => {
        open();
    }, [open]);
    return null;
}

function Shell() {
    return (
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                <Registrar />
                <OpenPalette />
                <CommandPalette />
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>
    );
}

describe('CommandPalette — shortcut badges on action/nav rows', () => {
    beforeEach(() => {
        navigationMock.pathname = '/t/demo/dashboard';
        navigationMock.push.mockReset();
    });

    it('renders a keycap badge on the matching action row', () => {
        render(<Shell />);

        // Palette Actions include `id: 'action:toggle-theme'` with label
        // "Toggle theme". The row's data-testid pattern is
        // `command-palette-<prefix>-<id>` and its shortcut chip is
        // suffixed `-shortcut`.
        const themeRow = document.querySelector(
            '[data-testid="command-palette-action-action:toggle-theme"]',
        );
        expect(themeRow).not.toBeNull();

        const badge = document.querySelector(
            '[data-testid="command-palette-action-action:toggle-theme-shortcut"]',
        );
        expect(badge).not.toBeNull();

        // Registered shortcut is `mod+shift+t` → pretty-printed as a
        // set of <kbd> chips: Ctrl / ⇧ / T.
        const kbds = badge!.querySelectorAll('kbd');
        expect(kbds.length).toBeGreaterThanOrEqual(3);
        const tokens = Array.from(kbds).map((k) => k.textContent?.trim());
        expect(tokens).toContain('Ctrl');
        expect(tokens).toContain('T');
    });

    it('removes the duplicated entry from the Keyboard-shortcuts group (dedupe)', () => {
        render(<Shell />);

        const shortcutRows = document.querySelectorAll(
            '[data-testid="command-palette-shortcut"]',
        );
        const descriptions = Array.from(shortcutRows).map(
            (el) => el.textContent?.trim() ?? '',
        );

        // "Toggle theme" is represented on the action row, so must
        // NOT appear again in the shortcut group.
        expect(
            descriptions.some((d) => d.startsWith('Toggle theme')),
        ).toBe(false);

        // "Open filters" has no matching palette command — it should
        // still be listed in the shortcut group for discoverability.
        expect(
            descriptions.some((d) => d.startsWith('Open filters')),
        ).toBe(true);
    });

    it('renders no shortcut badge on rows without a matching registration', () => {
        render(<Shell />);

        // The Dashboard navigation row is always present on tenant
        // routes; we didn't register a shortcut for "Dashboard".
        const dashRow = document.querySelector(
            '[data-testid^="command-palette-nav-"]',
        );
        expect(dashRow).not.toBeNull();

        const badge = dashRow!.querySelector('[data-testid$="-shortcut"]');
        expect(badge).toBeNull();
    });

    it('keeps the palette invocation shortcut out of the listed group', () => {
        render(<Shell />);

        const shortcutRows = document.querySelectorAll(
            '[data-testid="command-palette-shortcut"]',
        );
        const descriptions = Array.from(shortcutRows).map(
            (el) => el.textContent?.trim() ?? '',
        );

        // `mod+k` is the invocation affordance — never listed in the
        // group (filtered by description at the palette level).
        expect(
            descriptions.some((d) => d.includes('Open command palette')),
        ).toBe(false);
    });
});
