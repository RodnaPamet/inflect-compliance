/** @jest-environment jsdom */

/**
 * The command palette in Bulgarian, and when search fails (#5309).
 *
 *   - Every command row and every filter chip reads in the reader's language,
 *     not English beside Bulgarian group headings. The English name still
 *     finds its row (match-only), so nothing typeable before became
 *     unreachable.
 *   - A /search that answers 500 or 429, or does not answer, says the search
 *     failed. It used to read "No results found", which tells a user the
 *     control they know exists does not.
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';

const navigationMock = { pathname: '/t/acme-corp/dashboard', push: jest.fn() };
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

jest.mock('next-auth/react', () => ({ signOut: jest.fn(), signIn: jest.fn() }));

// The Bulgarian catalogue, memoised per namespace. `mock`-prefixed so the
// hoisted factory may read it.
const mockBg: Record<string, unknown> = require('../../messages/bg.json');
jest.mock('next-intl', () => {
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const lookup = (key: string) => walk(mockBg, ns ? `${ns}.${key}` : key);
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = lookup(key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.rich = t;
        t.has = (key: string) => typeof lookup(key) === 'string';
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'bg',
    };
});

import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { CommandPalette, CommandPaletteProvider, useCommandPalette } from '@/components/command-palette';

function bg(path: string): string {
    const v = path.split('.').reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        mockBg,
    );
    if (typeof v !== 'string') throw new Error(`no bg message ${path}`);
    return v;
}

function OpenOnMount() {
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
                <OpenOnMount />
                <CommandPalette />
            </CommandPaletteProvider>
        </KeyboardShortcutProvider>
    );
}

function answer(response: { ok: boolean; status: number; json?: () => Promise<unknown> } | 'network') {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async () => {
        if (response === 'network') throw new TypeError('Failed to fetch');
        return response;
    });
}

async function type(value: string) {
    const input = document.querySelector('[data-testid="command-palette-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value } });
    await act(async () => {
        await new Promise((r) => setTimeout(r, 220));
    });
}

const emptyText = () => document.querySelector('[cmdk-empty]')?.textContent;

afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

describe('command palette — Bulgarian', () => {
    it('renders the command rows in Bulgarian', async () => {
        answer({ ok: true, status: 200, json: async () => ({ hits: [] }) });
        render(<Shell />);
        const row = document.querySelector('[data-testid="command-palette-nav-nav:dashboard"]');
        expect(row?.textContent).toContain(bg('commandPalette.commands.goToDashboard'));
        expect(document.body.textContent).not.toContain('Go to Dashboard');
        expect(document.body.textContent).not.toContain('Sign out');
    });

    it('renders the filter chips in Bulgarian', async () => {
        answer({ ok: true, status: 200, json: async () => ({ hits: [] }) });
        render(<Shell />);
        await type('zzqq');
        const chips = document.querySelector('[data-testid="palette-filter-chips"]');
        expect(chips?.textContent).toContain(bg('commandPalette.entityControl'));
        expect(chips?.textContent).not.toContain('Controls');
    });

    it('still finds a command by its English name', async () => {
        answer({ ok: true, status: 200, json: async () => ({ hits: [] }) });
        render(<Shell />);
        await type('go to risks');
        expect(document.querySelector('[data-testid="command-palette-nav-nav:risks"]')).not.toBeNull();
    });
});

describe('command palette — a failed search is not "no results"', () => {
    it.each([
        ['a 500', { ok: false, status: 500, json: async () => ({}) }],
        ['a 429', { ok: false, status: 429, json: async () => ({}) }],
        ['a network failure', 'network' as const],
    ])('%s says the search failed', async (_label, response) => {
        answer(response);
        render(<Shell />);
        await type('zzqq');
        expect(emptyText()).toBe(bg('commandPalette.searchFailed'));
    });

    it('an empty answer still says no results', async () => {
        answer({ ok: true, status: 200, json: async () => ({ hits: [] }) });
        render(<Shell />);
        await type('zzqq');
        expect(emptyText()).toBe(bg('commandPalette.noResults'));
    });
});
