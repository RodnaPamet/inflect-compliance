/**
 * Epic 57 — navigation + action commands inside the Command Palette.
 *
 * Verifies the contract for the two curated command buckets:
 *
 *   - Navigation commands (Go to Dashboard / Controls / Risks / …)
 *     render when a tenant slug is present in the URL, each carries
 *     the expected tenant-scoped `/t/<slug>/<route>` href, and
 *     selecting one calls `router.push()` + closes the palette.
 *
 *   - Action commands (Toggle theme / Sign out) invoke the
 *     appropriate handler. No action command issues a destructive
 *     operation — the two shipped are deliberately universal.
 *
 *   - Both buckets are hidden outside tenant routes (the palette on
 *     /login shows only the keyboard-shortcut discoverability group).
 *
 *   - Typing into the palette filters commands by label.
 */

import React from 'react';
import {
    render,
    renderHook,
    fireEvent,
    act,
    waitFor,
} from '@testing-library/react';

// Shared mocks — populated per-test.
const navigationMock = {
    pathname: '/t/acme-corp/dashboard',
    push: jest.fn(),
};
const signOutMock = jest.fn();
const toggleThemeMock = jest.fn();

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

jest.mock('next-auth/react', () => ({
    signOut: (opts: unknown) => {
        signOutMock(opts);
        return Promise.resolve();
    },
}));

// Stub `useTheme` so we don't need the real ThemeProvider tree just
// to exercise the action handler.
jest.mock('@/components/theme/ThemeProvider', () => ({
    useTheme: () => ({
        theme: 'dark',
        setTheme: jest.fn(),
        toggle: () => toggleThemeMock(),
    }),
    ThemeProvider: ({ children }: { children: React.ReactNode }) => (
        <>{children}</>
    ),
}));


import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

import {
    CommandPalette,
    CommandPaletteProvider,
    useCommandPalette,
} from '@/components/command-palette';
import {
    filterPaletteCommands,
    usePaletteCommands,
    type PaletteCommand,
} from '@/components/command-palette/use-palette-commands';

// Render an auto-opened palette for each test.
function Shell({ children }: { children?: React.ReactNode }) {
    // Test-only inner component: opens the palette imperatively
    // after the provider mounts. Defined inline so it can call
    // useCommandPalette() under the just-mounted provider.

    function OpenOnMount() {
        const { open } = useCommandPalette();
        React.useEffect(() => {
            open();
        }, [open]);
        return null;
    }
    return (
        <KeyboardShortcutProvider>
            <CommandPaletteProvider>
                {/* eslint-disable-next-line react-hooks/static-components */}
                <OpenOnMount />
                {children}
                <CommandPalette />
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>
    );
}

beforeEach(() => {
    navigationMock.pathname = '/t/acme-corp/dashboard';
    navigationMock.push.mockReset();
    signOutMock.mockReset();
    toggleThemeMock.mockReset();
    // Stub fetch so the entity-search hook doesn't error when an
    // incidental query triggers it.
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
        ok: true,
        json: async () => ({ items: [] }),
    }));
});

afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

// ─── Navigation ───────────────────────────────────────────────────────

describe('Command Palette — navigation commands', () => {
    it('renders one row per curated navigation target', () => {
        render(<Shell />);
        const expected = [
            'nav:dashboard',
            'nav:controls',
            'nav:risks',
            'nav:policies',
            'nav:evidence',
            'nav:tasks',
            'nav:frameworks',
            'nav:vendors',
            'nav:reports',
            'nav:admin',
        ];
        for (const id of expected) {
            const row = document.querySelector(
                `[data-testid="command-palette-nav-${id}"]`,
            );
            expect(row).not.toBeNull();
        }
    });

    it('each navigation row carries a tenant-scoped href', () => {
        render(<Shell />);
        const rows = document.querySelectorAll(
            '[data-testid^="command-palette-nav-nav:"]',
        );
        rows.forEach((row) => {
            const href = row.getAttribute('data-href');
            expect(href).toMatch(/^\/t\/acme-corp\//);
        });
    });

    it('selecting a navigation command calls router.push and closes the palette', async () => {
        const { queryByTestId } = render(<Shell />);
        const row = document.querySelector(
            '[data-testid="command-palette-nav-nav:controls"]',
        )!;
        expect(row.getAttribute('data-href')).toBe('/t/acme-corp/controls');

        fireEvent.click(row);
        expect(navigationMock.push).toHaveBeenCalledWith('/t/acme-corp/controls');
        await waitFor(() => {
            expect(queryByTestId('command-palette-input')).toBeNull();
        });
    });

    it('no navigation rows render outside a tenant route', () => {
        navigationMock.pathname = '/login';
        render(<Shell />);
        expect(
            document.querySelectorAll(
                '[data-testid^="command-palette-nav-nav:"]',
            ).length,
        ).toBe(0);
    });

    it('filters commands by label when the user types', async () => {
        render(<Shell />);
        const input = document.querySelector(
            '[data-testid="command-palette-input"]',
        ) as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'risk' } });

        // Commands filter immediately (no debounce). Nav:risks stays,
        // nav:controls disappears.
        await waitFor(() => {
            expect(
                document.querySelector(
                    '[data-testid="command-palette-nav-nav:risks"]',
                ),
            ).not.toBeNull();
        });
        expect(
            document.querySelector(
                '[data-testid="command-palette-nav-nav:controls"]',
            ),
        ).toBeNull();
    });
});

// ─── Actions ──────────────────────────────────────────────────────────

describe('Command Palette — action commands', () => {
    it('renders exactly the two safe, universal actions', () => {
        render(<Shell />);
        const actions = document.querySelectorAll(
            '[data-testid^="command-palette-action-action:"]',
        );
        const ids = Array.from(actions).map((a) =>
            a.getAttribute('data-testid'),
        );
        expect(ids.sort()).toEqual([
            'command-palette-action-action:sign-out',
            'command-palette-action-action:toggle-theme',
        ]);
    });

    it('selecting "Toggle theme" invokes the theme hook and closes the palette', async () => {
        const { queryByTestId } = render(<Shell />);
        const row = document.querySelector(
            '[data-testid="command-palette-action-action:toggle-theme"]',
        )!;
        fireEvent.click(row);

        await waitFor(() => {
            expect(queryByTestId('command-palette-input')).toBeNull();
        });
        // handleAction defers invocation by a microtask — flush.
        await act(async () => {
            await Promise.resolve();
        });
        expect(toggleThemeMock).toHaveBeenCalledTimes(1);
    });

    it('selecting "Sign out" calls next-auth signOut with the login callback', async () => {
        const { queryByTestId } = render(<Shell />);
        const row = document.querySelector(
            '[data-testid="command-palette-action-action:sign-out"]',
        )!;
        fireEvent.click(row);

        await waitFor(() => {
            expect(queryByTestId('command-palette-input')).toBeNull();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(signOutMock).toHaveBeenCalledTimes(1);
        expect(signOutMock).toHaveBeenCalledWith({ callbackUrl: '/login' });
    });

    it('actions do not render outside a tenant route', () => {
        navigationMock.pathname = '/login';
        render(<Shell />);
        expect(
            document.querySelectorAll(
                '[data-testid^="command-palette-action-action:"]',
            ).length,
        ).toBe(0);
    });
});

// ─── Operator vocabulary (#2559) ──────────────────────────────────────

/**
 * The prompt behind the agentic palette entries named the words an
 * operator would type: **agent, AI, autonomy, MCP, kill**. Only `agent`
 * appeared in a label, and `filterPaletteCommands` read labels alone, so
 * four of the five reached the palette's empty state.
 *
 * Widening the labels is not the fix and would undo a deliberate one —
 * the entries are named by destination precisely because "Go to MCP" is
 * untypeable for anyone who does not already know the acronym. So these
 * assert the opposite pairing: the word finds the row, and the word is
 * NOT on the row.
 *
 * Every assertion below states the EXACT id set, never a non-empty
 * count. A predicate mutated to a pass-through satisfies every
 * "the word finds something" phrasing at once.
 */
describe('Command Palette — operator vocabulary', () => {
    function paletteCommands(): PaletteCommand[] {
        const { result } = renderHook(() => usePaletteCommands('acme-corp'));
        return result.current;
    }

    function idsMatching(query: string): string[] {
        return filterPaletteCommands(paletteCommands(), query).map((c) => c.id);
    }

    const ALL_THREE = [
        'nav:agents',
        'nav:agent-proposals',
        'nav:agent-quarantine',
    ];

    it('"agent" reaches all three agentic destinations', () => {
        expect(idsMatching('agent')).toEqual(ALL_THREE);
    });

    it('"AI" reaches all three agentic destinations', () => {
        expect(idsMatching('AI')).toEqual(ALL_THREE);
    });

    it('"MCP" reaches all three agentic destinations', () => {
        expect(idsMatching('mcp')).toEqual(ALL_THREE);
    });

    it('"autonomy" reaches the agent register', () => {
        expect(idsMatching('autonomy')).toEqual(['nav:agents']);
    });

    it('"kill" reaches the agent register', () => {
        expect(idsMatching('kill')).toEqual(['nav:agents']);
    });

    it('a query matching nothing still returns nothing', () => {
        // Load-bearing negative control: without it, a predicate mutated
        // to `() => true` passes every assertion above.
        expect(idsMatching('zzzznotathing')).toEqual([]);
    });

    it('an unrelated word is unaffected by the keyword channel', () => {
        expect(idsMatching('vendor')).toEqual(['nav:vendors']);
    });

    it('keywords match but never render — the row still reads by destination', async () => {
        render(<Shell />);
        const input = document.querySelector(
            '[data-testid="command-palette-input"]',
        ) as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'mcp' } });

        await waitFor(() => {
            expect(
                document.querySelector(
                    '[data-testid="command-palette-nav-nav:agents"]',
                ),
            ).not.toBeNull();
        });

        // The whole point of the keyword channel: the acronym found the
        // row without becoming its name.
        const row = document.querySelector(
            '[data-testid="command-palette-nav-nav:agents"]',
        )!;
        const text = row.textContent ?? '';
        expect(text.includes('Go to Agent register')).toBe(true);
        expect(text.toLowerCase().includes('mcp')).toBe(false);

        // …and the rows the query does not reach are gone.
        expect(
            document.querySelector(
                '[data-testid="command-palette-nav-nav:controls"]',
            ),
        ).toBeNull();
    });
});

// ─── Source-level hint regression guards ──────────────────────────────

describe('Shortcut hints — filter trigger', () => {
    // Lightweight structural check that future UI refactors don't
    // accidentally strip the visible `F` hint off the filter trigger
    // or the aria-keyshortcuts affordance that screen readers pick up.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const ROOT = path.resolve(__dirname, '../..');

    let src = '';
    beforeAll(() => {
        src = fs.readFileSync(
            path.join(ROOT, 'src/components/ui/filter/filter-select.tsx'),
            'utf-8',
        );
    });

    it('exposes aria-keyshortcuts="F" on the trigger for assistive tech', () => {
        expect(src).toMatch(/aria-keyshortcuts=["']F["']/);
    });

    it('renders a visible <kbd> chip reading "F" on the trigger', () => {
        expect(src).toMatch(
            /<kbd[\s\S]*?data-filter-shortcut-hint[\s\S]*?>\s*F\s*<\/kbd>/,
        );
    });

    it('the trigger carries the data-filter-trigger marker for E2E / visual tests', () => {
        expect(src).toContain('data-filter-trigger');
    });
});
