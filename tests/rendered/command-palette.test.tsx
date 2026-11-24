/**
 * Epic 57 — Command Palette foundation tests.
 *
 * These assert the invocation contract the audit calls for:
 *
 *   - `mod+k` opens the palette (⌘K on Mac, Ctrl+K otherwise)
 *   - it opens from anywhere — including inside an input and over a
 *     pre-existing overlay
 *   - Escape closes it cleanly
 *   - the shortcut toggles (second `mod+k` while open → close)
 *   - `useCommandPalette()` exposes programmatic open/close/toggle
 *   - focus lands on the palette's search input when it mounts
 *   - the palette surfaces registered shortcuts so it has real
 *     content before the navigation / entity-search work lands
 *
 * We render the real palette + provider inside a minimal
 * `KeyboardShortcutProvider`. Radix Dialog requires DOM APIs that
 * jsdom provides (focus, portals). The Toaster is out of scope here,
 * so we don't pull it in.
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';

// The palette reads `usePathname()` (to derive the tenant slug) and
// `useRouter()` (to navigate on select). jsdom has no App Router
// context, so stub both — tests can override `usePathname` per block
// via the shared mock object below.
const navigationMock = {
    pathname: '/',
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

// next-auth/react is pulled in transitively by the palette's
// Sign-out action. It ships as ESM and isn't in the jsdom transform
// allowlist — stub it so the module graph loads.
jest.mock('next-auth/react', () => ({
    signOut: jest.fn(),
    signIn: jest.fn(),
}));


import { KeyboardShortcutProvider, useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';

import { __setIsMacForTests } from '@/lib/hooks/keyboard-shortcut-internals';


import {
    CommandPalette,
    CommandPaletteProvider,
    useCommandPalette,
} from '@/components/command-palette';

beforeEach(() => {
    navigationMock.pathname = '/';
    navigationMock.push.mockReset();
});

function Shell({ children }: { children?: React.ReactNode }) {
    return (
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                {children}
                <CommandPalette />
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>
    );
}

function isPaletteOpen(): boolean {
    return document.querySelector('[data-command-palette]') !== null;
}

afterEach(() => {
    __setIsMacForTests(null);
});

// ─── Invocation ────────────────────────────────────────────────────────

describe('CommandPalette — invocation', () => {
    it('is closed by default', () => {
        render(<Shell />);
        expect(isPaletteOpen()).toBe(false);
    });

    it('opens on ⌘K on macOS', () => {
        __setIsMacForTests(true);
        render(<Shell />);
        act(() => {
            fireEvent.keyDown(window, { key: 'k', metaKey: true });
        });
        expect(isPaletteOpen()).toBe(true);
    });

    it('opens on Ctrl+K on non-macOS', () => {
        __setIsMacForTests(false);
        render(<Shell />);
        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        expect(isPaletteOpen()).toBe(true);
    });

    it('closes on Escape (Radix native)', () => {
        __setIsMacForTests(false);
        render(<Shell />);
        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        expect(isPaletteOpen()).toBe(true);

        // Escape on the palette's content must close it. We dispatch on
        // `document` so Radix's captured keydown listener (installed
        // when the Dialog opens) picks it up.
        act(() => {
            fireEvent.keyDown(document.body, { key: 'Escape' });
        });
        expect(isPaletteOpen()).toBe(false);
    });

    it('mod+k toggles — a second press while open closes', () => {
        __setIsMacForTests(false);
        render(<Shell />);

        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        expect(isPaletteOpen()).toBe(true);

        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        expect(isPaletteOpen()).toBe(false);
    });

    it('opens even when focus is inside a text input', () => {
        __setIsMacForTests(false);
        const { container } = render(
            <Shell>
                <input aria-label="search" />
            </Shell>,
        );
        const input = container.querySelector('input[aria-label="search"]') as HTMLInputElement;
        input.focus();

        act(() => {
            fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
        });
        expect(isPaletteOpen()).toBe(true);
    });

    it('opens even when another modal overlay is already mounted (stacks on top)', () => {
        __setIsMacForTests(false);
        render(
            <Shell>
                {/* Radix Dialog style marker — treated as an overlay by
                    the shortcut registry. The palette's shortcut has
                    allowWhenOverlayOpen:true so it still fires. */}
                <div role="dialog" aria-label="pre-existing" data-state="open" />
            </Shell>,
        );
        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        expect(isPaletteOpen()).toBe(true);
    });
});

// ─── Programmatic API ──────────────────────────────────────────────────

describe('CommandPalette — useCommandPalette()', () => {
    function OpenerButton() {
        const { open, close, toggle, isOpen } = useCommandPalette();
        return (
            <div>
                <button onClick={open} data-testid="open-btn">
                    open
                </button>
                <button onClick={close} data-testid="close-btn">
                    close
                </button>
                <button onClick={toggle} data-testid="toggle-btn">
                    toggle
                </button>
                <output data-testid="is-open">{String(isOpen)}</output>
            </div>
        );
    }

    it('open / close / toggle operate on the shared state', () => {
        const { getByTestId } = render(
            <Shell>
                <OpenerButton />
            </Shell>,
        );
        expect(getByTestId('is-open').textContent).toBe('false');
        fireEvent.click(getByTestId('open-btn'));
        expect(getByTestId('is-open').textContent).toBe('true');
        expect(isPaletteOpen()).toBe(true);

        fireEvent.click(getByTestId('close-btn'));
        expect(getByTestId('is-open').textContent).toBe('false');
        expect(isPaletteOpen()).toBe(false);

        fireEvent.click(getByTestId('toggle-btn'));
        expect(getByTestId('is-open').textContent).toBe('true');
        fireEvent.click(getByTestId('toggle-btn'));
        expect(getByTestId('is-open').textContent).toBe('false');
    });

    it('returns an inert API when used without the provider', () => {
        function Probe() {
            const api = useCommandPalette();
            return (
                <div data-testid="probe">
                    {String(api.isOpen)}
                </div>
            );
        }
        const { getByTestId } = render(<Probe />);
        expect(getByTestId('probe').textContent).toBe('false');
    });
});

// ─── Focus + content ──────────────────────────────────────────────────

describe('CommandPalette — focus & content', () => {
    it('makes the search field the search bar\'s full height, so the whole bar takes a tap', () => {
        // The bar's vertical padding sits on the INPUT: a 23px field in a
        // 47px bar was the smallest tap target on the dashboard (#5884).
        __setIsMacForTests(false);
        render(<Shell />);
        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        const input = document.querySelector('[data-testid="command-palette-input"]') as HTMLElement;
        const bar = input.parentElement as HTMLElement;
        expect(input).toHaveClass('py-3', 'flex-1');
        expect(bar).toHaveClass('flex', 'items-center', 'px-4');
        expect(bar).not.toHaveClass('py-3');
    });

    it('focuses the search input when it opens', () => {
        __setIsMacForTests(false);
        render(<Shell />);

        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });

        const input = document.querySelector(
            '[data-testid="command-palette-input"]',
        ) as HTMLInputElement | null;
        expect(input).not.toBeNull();
        // Radix Dialog's `onOpenAutoFocus` lands on the first focusable
        // child (the input). Explicit `autoFocus` on the input is our
        // safety net for environments where Radix's focus management
        // races the assertion.
        expect(document.activeElement).toBe(input);
    });

    it('surfaces registered shortcuts with their descriptions', () => {
        __setIsMacForTests(false);
        function RegisterOne() {
            useKeyboardShortcut('g d', () => {}, {
                description: 'Go to Dashboard',
            });
            return null;
        }
        render(
            <Shell>
                <RegisterOne />
            </Shell>,
        );
        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        const items = document.querySelectorAll(
            '[data-testid="command-palette-shortcut"]',
        );
        const labels = Array.from(items).map((el) => el.textContent);
        expect(labels.some((l) => l && l.includes('Go to Dashboard'))).toBe(true);
    });

    it('does not list the palette\'s own mod+k shortcut', () => {
        // The ⌘K binding is the invocation, not a discoverable command.
        __setIsMacForTests(false);
        render(<Shell />);
        act(() => {
            fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
        });
        const items = document.querySelectorAll(
            '[data-testid="command-palette-shortcut"]',
        );
        const labels = Array.from(items).map((el) => el.textContent);
        expect(labels.some((l) => l && l.includes('Open command palette'))).toBe(
            false,
        );
    });
});
