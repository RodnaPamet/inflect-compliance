/**
 * The shell on a phone: a touch way into the command palette, and a toaster
 * that follows the theme and moves off the header (#5821).
 *
 *   · The palette opened only on ⌘K / Ctrl+K. The top-bar search icon opens
 *     the ONE palette the provider owns — asserted against the provider's own
 *     state, so a second palette rendered beside it would not satisfy this.
 *   · The toaster was pinned to `theme="dark"` and top-right. It now reads the
 *     app theme and sits bottom-centre below `md`, top-right from `md` up.
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mockToasterProps = jest.fn();
jest.mock('sonner', () => ({
    Toaster: (props: Record<string, unknown>) => {
        mockToasterProps(props);
        return null;
    },
}));

import {
    CommandPaletteProvider,
    CommandPaletteTopBarButton,
    useCommandPalette,
} from '@/components/command-palette';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { AppToaster } from '@/components/theme/AppToaster';
import { ThemeProvider, useTheme } from '@/components/theme/ThemeProvider';

describe('the top-bar search icon opens the command palette', () => {
    function PaletteState() {
        const { isOpen } = useCommandPalette();
        return <span data-testid="palette-state">{String(isOpen)}</span>;
    }

    function mount() {
        return render(
            <KeyboardShortcutProvider>
                <CommandPaletteProvider>
                    <CommandPaletteTopBarButton />
                    <PaletteState />
                </CommandPaletteProvider>
            </KeyboardShortcutProvider>,
        );
    }

    it('a tap opens the provider\'s palette', () => {
        mount();
        expect(screen.getByTestId('palette-state').textContent).toBe('false');
        fireEvent.click(screen.getByTestId('command-palette-top-bar-button'));
        expect(screen.getByTestId('palette-state').textContent).toBe('true');
    });

    it('is phone-only, 44px to a finger, and named', () => {
        mount();
        const btn = screen.getByTestId('command-palette-top-bar-button');
        const cls = btn.className.split(/\s+/);
        expect(cls).toContain('md:hidden');
        expect(cls).toContain('pointer-coarse:min-h-11');
        expect(cls).toContain('pointer-coarse:min-w-11');
        expect(btn).toHaveAttribute('aria-label', 'Open command palette');
    });
});

describe('the toaster follows the theme and the breakpoint', () => {
    const realWidth = window.innerWidth;

    function setWidth(px: number) {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: px });
    }

    afterEach(() => {
        setWidth(realWidth);
        mockToasterProps.mockClear();
        document.documentElement.removeAttribute('data-theme');
        // `setTheme` persists the choice; the next case must start unchosen.
        window.localStorage.clear();
    });

    const last = () => mockToasterProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;

    function ThemeFlip() {
        const { setTheme } = useTheme();
        return (
            <button type="button" data-testid="go-light" onClick={() => setTheme('light')}>
                light
            </button>
        );
    }

    it('takes the app theme, and changes with it', () => {
        setWidth(1280);
        render(
            <ThemeProvider>
                <ThemeFlip />
                <AppToaster />
            </ThemeProvider>,
        );
        const before = last().theme;
        act(() => {
            fireEvent.click(screen.getByTestId('go-light'));
        });
        // Not merely "not dark": the value is the provider's, before and after.
        expect(before).toBe('dark');
        expect(last().theme).toBe('light');
    });

    it('sits bottom-centre on a phone, clear of the home indicator', () => {
        setWidth(390);
        render(
            <ThemeProvider>
                <AppToaster />
            </ThemeProvider>,
        );
        expect(last().position).toBe('bottom-center');
        expect(JSON.stringify(last().mobileOffset)).toContain('safe-area-inset-bottom');
    });

    it('keeps top-right on a desktop — the control', () => {
        setWidth(1280);
        render(
            <ThemeProvider>
                <AppToaster />
            </ThemeProvider>,
        );
        expect(last().position).toBe('top-right');
    });

    it('treats md (768px) as desktop and 767px as a phone', () => {
        setWidth(768);
        const { unmount } = render(
            <ThemeProvider>
                <AppToaster />
            </ThemeProvider>,
        );
        expect(last().position).toBe('top-right');
        unmount();
        setWidth(767);
        render(
            <ThemeProvider>
                <AppToaster />
            </ThemeProvider>,
        );
        expect(last().position).toBe('bottom-center');
    });
});
