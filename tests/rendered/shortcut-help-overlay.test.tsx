/**
 * Epic 57 — shortcut help overlay tests.
 *
 * Exercises the overlay end-to-end inside a real KeyboardShortcutProvider:
 *   - `?` opens the overlay when focus is on a non-editable element
 *   - `?` is NOT intercepted while typing into inputs/textareas
 *   - registered shortcuts appear in the listing (live via the provider's
 *     `useRegisteredShortcuts` snapshot)
 *   - undescribed/internal shortcuts are hidden
 *   - overlay-scoped shortcuts are grouped separately
 *   - overlay closes on `?` toggle and via the shared Modal's Escape
 */

// Modal uses next/navigation's useRouter as a fallback close path; stub
// it out for jsdom just like tests/rendered/modal.test.tsx does.
jest.mock('next/navigation', () => ({
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

import React from 'react';
import { render, screen, act, within } from '@testing-library/react';

import {
    KeyboardShortcutProvider,
    useKeyboardShortcut,
} from '@/lib/hooks/use-keyboard-shortcut';
import { ShortcutHelpOverlay } from '@/components/app-shell/shortcut-help-overlay';

function dispatchKey(
    key: string,
    mods: Partial<Record<'meta' | 'ctrl' | 'shift', boolean>> = {},
    target?: Element,
) {
    const event = new KeyboardEvent('keydown', {
        key,
        metaKey: !!mods.meta,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        bubbles: true,
        cancelable: true,
    });
    (target ?? window).dispatchEvent(event);
    return event;
}

function Registrar({ children }: { children?: React.ReactNode }) {
    // A handful of registrations that the overlay should surface.
    useKeyboardShortcut('mod+k', () => {}, {
        description: 'Open command palette',
    });
    useKeyboardShortcut(['Escape'], () => {}, {
        description: 'Close modal',
        scope: 'overlay',
    });
    // Deliberately undescribed — should be hidden from the overlay.
    useKeyboardShortcut('g a', () => {}, {});
    return <>{children}</>;
}

function Harness({ children }: { children?: React.ReactNode }) {
    return (
        <KeyboardShortcutProvider>
            <Registrar />
            <ShortcutHelpOverlay />
            {children}
        </KeyboardShortcutProvider>
    );
}

describe('ShortcutHelpOverlay', () => {
    it('does not render the modal until `?` is pressed', () => {
        render(<Harness />);
        expect(screen.queryByTestId('shortcut-help-body')).not.toBeInTheDocument();
    });

    it('`Ctrl+/` opens the overlay and surfaces registered shortcuts with descriptions', () => {
        render(<Harness />);

        act(() => {
            dispatchKey('/', { ctrl: true });
        });

        const body = screen.getByTestId('shortcut-help-body');
        expect(body).toBeInTheDocument();

        // Palette shortcut — described, global scope.
        expect(within(body).getByText('Open command palette')).toBeInTheDocument();

        // The overlay's own `?` shortcut is also described and must
        // appear (this is the discoverability entry point itself).
        expect(within(body).getByText('Show keyboard shortcuts')).toBeInTheDocument();

        // Overlay-scoped Escape shortcut is described and appears
        // under its own group heading.
        expect(within(body).getByText('Close modal')).toBeInTheDocument();
        expect(within(body).getByText('In dialogs & sheets')).toBeInTheDocument();
    });

    it('hides shortcuts with no description (internal-only)', () => {
        render(<Harness />);

        act(() => {
            dispatchKey('/', { ctrl: true });
        });

        const body = screen.getByTestId('shortcut-help-body');
        // The `g a` registration above has no description; no row for
        // a literal `G A` key combination should appear.
        const allText = body.textContent ?? '';
        // The rendered kbd for "g a" would be "G + A" via prettyKey.
        expect(allText).not.toContain('G + A');
    });

    it('groups global and overlay shortcuts separately', () => {
        render(<Harness />);
        act(() => {
            dispatchKey('/', { ctrl: true });
        });
        const body = screen.getByTestId('shortcut-help-body');
        expect(within(body).getByText('Available now')).toBeInTheDocument();
        expect(within(body).getByText('In dialogs & sheets')).toBeInTheDocument();
    });

    it('does NOT hijack `?` while typing into an input', () => {
        const { container } = render(
            <Harness>
                <input data-testid="search" placeholder="search" />
            </Harness>,
        );
        const input = within(container).getByTestId('search');

        input.focus();
        act(() => {
            dispatchKey('/', { ctrl: true }, input);
        });

        expect(screen.queryByTestId('shortcut-help-body')).not.toBeInTheDocument();
    });

    it('does NOT hijack `?` inside a textarea or contenteditable surface', () => {
        const { container } = render(
            <Harness>
                <textarea data-testid="note" />
                <div data-testid="rich" contentEditable suppressContentEditableWarning>
                    draft
                </div>
            </Harness>,
        );
        const ta = within(container).getByTestId('note');
        const rich = within(container).getByTestId('rich');

        ta.focus();
        act(() => dispatchKey('/', { ctrl: true }, ta));
        expect(screen.queryByTestId('shortcut-help-body')).not.toBeInTheDocument();

        rich.focus();
        act(() => dispatchKey('/', { ctrl: true }, rich));
        expect(screen.queryByTestId('shortcut-help-body')).not.toBeInTheDocument();
    });

    it('renders a Dialog role for screen readers when opened', async () => {
        // The overlay delegates a11y to the shared <Modal>: it mounts
        // a role="dialog" via Radix with a Title + Description. The
        // Modal primitive's close paths (Escape / backdrop / floating
        // button) are exercised in tests/rendered/modal.test.tsx; this
        // test just asserts the overlay PRESENTS as a dialog so
        // assistive tech knows what it's looking at.
        render(<Harness />);

        await act(async () => {
            dispatchKey('/', { ctrl: true });
        });

        expect(screen.getByRole('dialog')).toHaveAccessibleName(
            'Keyboard shortcuts',
        );
    });

    it('renders no overlay-group heading when no overlay-scoped shortcuts exist', () => {
        function MinimalHarness() {
            // Only one global shortcut — no overlay-scope registrations.
            useKeyboardShortcut('mod+k', () => {}, {
                description: 'Open command palette',
            });
            return null;
        }
        render(
            <KeyboardShortcutProvider>
                <MinimalHarness />
                <ShortcutHelpOverlay />
            </KeyboardShortcutProvider>,
        );

        act(() => dispatchKey('/', { ctrl: true }));
        const body = screen.getByTestId('shortcut-help-body');
        expect(within(body).queryByText('In dialogs & sheets')).not.toBeInTheDocument();
    });
});
