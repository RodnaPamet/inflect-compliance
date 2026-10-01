/**
 * Epic 57 — app-shell integration test.
 *
 * Renders the real `<Providers>` wrapper (the client boundary the
 * server root layout mounts) and verifies that a component sitting
 * deep in the tree — as every page component does — can register a
 * shortcut and have the shared registry fire it. This is the "end to
 * end" contract from the audit: shortcut handling is a first-class
 * app-shell capability, not per-page plumbing.
 *
 * `sonner` is mocked because the toast host isn't relevant here and
 * calls into timers/animation APIs that aren't worth polyfilling for
 * this test. Everything else — ThemeProvider, TooltipProvider,
 * KeyboardShortcutProvider — is the real implementation.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react';

jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign(jest.fn(), {
        success: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
    }),
}));

// The real <Providers> now mounts <CommandPalette />, which reads
// next/navigation. Stub it so the palette's `usePathname()` /
// `useRouter()` calls don't throw in jsdom.
jest.mock('next/navigation', () => ({
    usePathname: () => '/',
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

jest.mock('next-auth/react', () => ({
    signOut: jest.fn(),
    signIn: jest.fn(),
}));

// Import AFTER jest.mock so the mock wins.

import { Providers } from '@/app/providers';

import { useKeyboardShortcut } from '@/lib/hooks/use-keyboard-shortcut';

function DeeplyNested({ onHit }: { onHit: () => void }) {
    useKeyboardShortcut('mod+d', onHit, { description: 'Go to Dashboard' });
    return <div data-testid="deep-child">deep</div>;
}

function AppShellStub({ onHit }: { onHit: () => void }) {
    // Three layers deep — mirrors the real tree shape
    //   AppShell → ClientProviders → page component → feature component.
    return (
        <div data-testid="shell">
            <div data-testid="page">
                <section>
                    <DeeplyNested onHit={onHit} />
                </section>
            </div>
        </div>
    );
}

describe('App-shell shortcut integration', () => {
    it('renders the real <Providers> without hydration errors', () => {
        const { getByTestId } = render(
            <Providers>
                <AppShellStub onHit={() => {}} />
            </Providers>,
        );
        expect(getByTestId('shell')).toBeInTheDocument();
        expect(getByTestId('deep-child')).toBeInTheDocument();
    });

    it('a component deep in the tree can register a shortcut that fires', () => {
        const onHit = jest.fn();
        render(
            <Providers>
                <AppShellStub onHit={onHit} />
            </Providers>,
        );

        // Emit the registered key on the window — the provider's
        // single listener must route it to our deep child's handler.
        fireEvent.keyDown(window, { key: 'd', code: 'KeyD', ctrlKey: true });
        expect(onHit).toHaveBeenCalledTimes(1);
    });

    it('app-shell shortcuts do not fire while typing in a form input', () => {
        const onHit = jest.fn();
        const { container } = render(
            <Providers>
                <AppShellStub onHit={onHit} />
                <input aria-label="search" />
            </Providers>,
        );
        const input = container.querySelector('input[aria-label="search"]')!;
        (input as HTMLInputElement).focus();
        fireEvent.keyDown(input, { key: 'd', code: 'KeyD', ctrlKey: true });
        expect(onHit).not.toHaveBeenCalled();
    });

    it('the same registry is shared across siblings mounted under the shell', () => {
        // Two peer components register different shortcuts; both fire
        // from the same provider. Regression check against any future
        // change that accidentally remounts the provider per-subtree.
        const aSpy = jest.fn();
        const bSpy = jest.fn();
        function A() {
            useKeyboardShortcut('mod+a', aSpy);
            return null;
        }
        function B() {
            useKeyboardShortcut('mod+b', bSpy);
            return null;
        }
        render(
            <Providers>
                <A />
                <B />
            </Providers>,
        );
        fireEvent.keyDown(window, { key: 'a', code: 'KeyA', ctrlKey: true });
        fireEvent.keyDown(window, { key: 'b', code: 'KeyB', ctrlKey: true });
        expect(aSpy).toHaveBeenCalledTimes(1);
        expect(bSpy).toHaveBeenCalledTimes(1);
    });
});
