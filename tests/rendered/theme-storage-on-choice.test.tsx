/** @jest-environment jsdom */

/**
 * A theme is STORED only when the user picks one.
 *
 * `ThemeProvider` used to write a one-year `inflect_theme` cookie and an
 * `inflect:theme` localStorage entry with the OS light/dark setting on every
 * first visit, before anyone chose anything. So did the pre-paint script. Reading
 * `prefers-color-scheme` needs no storage, and a UI-customisation cookie is exempt
 * from consent only when the user asked for the preference to be kept (Article 29
 * WP194). A host that vendors this provider was about to tell its visitors it sets
 * "only essential cookies", and that sentence would have been false on the first
 * page view.
 *
 * Every write is observed at the SOURCE, not inferred from what is stored
 * afterwards: `document.cookie`'s setter and `Storage.prototype.setItem` are
 * wrapped, so a write that stored the same value as before still counts. The OS
 * preference is a controllable `matchMedia` double, because jsdom has none.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import { ThemeProvider, useTheme } from '@/components/theme/ThemeProvider';
import { THEME_COOKIE, THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from '@/lib/theme-constants';

// ─── The OS: a controllable prefers-color-scheme ────────────────────────

type ChangeListener = (event: MediaQueryListEvent) => void;

let systemLight = false;
let listeners: ChangeListener[] = [];

// tests/rendered/setup.ts installs a writable (not configurable) static stub;
// this one is assigned over it per test and the stub is put back afterwards.
const setupMatchMedia = window.matchMedia;

function installMatchMedia() {
    window.matchMedia = ((query: string) => ({
        get matches() {
            return query === '(prefers-color-scheme: light)' ? systemLight : !systemLight;
        },
        media: query,
        onchange: null,
        addEventListener: (_type: string, fn: ChangeListener) => {
            listeners.push(fn);
        },
        removeEventListener: (_type: string, fn: ChangeListener) => {
            listeners = listeners.filter((l) => l !== fn);
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

/** The OS flips while the page is open. */
function systemSwitchesTo(theme: 'light' | 'dark') {
    systemLight = theme === 'light';
    act(() => {
        for (const fn of listeners) fn({ matches: systemLight } as MediaQueryListEvent);
    });
}

// ─── Every write, at the source ─────────────────────────────────────────

const cookieAccessor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;
const realSetItem = Storage.prototype.setItem;
let cookieWrites: string[] = [];
let storageWrites: Array<[string, string]> = [];

function recordWrites() {
    cookieWrites = [];
    storageWrites = [];
    Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: () => cookieAccessor.get!.call(document),
        set: (value: string) => {
            cookieWrites.push(value);
            cookieAccessor.set!.call(document, value);
        },
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
    ) {
        storageWrites.push([key, value]);
        realSetItem.call(this, key, value);
    });
}

const themeWrites = () => ({
    cookie: cookieWrites.filter((w) => w.startsWith(`${THEME_COOKIE}=`)),
    storage: storageWrites.filter(([key]) => key === THEME_STORAGE_KEY),
});

/** Seed a choice made on an EARLIER visit, without it counting as a write here. */
function seedCookie(value: 'light' | 'dark') {
    cookieAccessor.set!.call(document, `${THEME_COOKIE}=${value}; path=/`);
}
function seedStorage(value: 'light' | 'dark') {
    realSetItem.call(window.localStorage, THEME_STORAGE_KEY, value);
}

function clearStoredTheme() {
    cookieAccessor.set!.call(document, `${THEME_COOKIE}=; path=/; max-age=0`);
    window.localStorage.clear();
}

// ─── A consumer: shows the theme and offers the user's own choice ────────

function Probe() {
    const { theme, toggle } = useTheme();
    return (
        <div>
            <output data-testid="theme">{theme}</output>
            <button type="button" onClick={toggle}>
                Toggle theme
            </button>
        </div>
    );
}

function renderApp() {
    return render(
        <ThemeProvider>
            <Probe />
        </ThemeProvider>,
    );
}

const shownTheme = () => screen.getByTestId('theme').textContent;
const htmlTheme = () => document.documentElement.getAttribute('data-theme');

beforeEach(() => {
    systemLight = false;
    listeners = [];
    installMatchMedia();
    clearStoredTheme();
    document.documentElement.removeAttribute('data-theme');
    recordWrites();
});

afterEach(() => {
    jest.restoreAllMocks();
    window.matchMedia = setupMatchMedia;
    // Drop the instance accessor so the prototype's real one is used again.
    delete (document as unknown as { cookie?: string }).cookie;
    clearStoredTheme();
});

// ─── ThemeProvider ──────────────────────────────────────────────────────

describe('ThemeProvider — a theme is stored only when the user picks one', () => {
    it('a first visit follows the OS and writes NOTHING: no cookie, no localStorage', () => {
        systemLight = true;
        renderApp();

        expect(shownTheme()).toBe('light');
        expect(htmlTheme()).toBe('light');
        expect(themeWrites()).toEqual({ cookie: [], storage: [] });
        expect(document.cookie).not.toContain(`${THEME_COOKIE}=`);
        expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    });

    it('with nothing stored it keeps following the OS while open, still writing nothing', () => {
        renderApp();
        expect(shownTheme()).toBe('dark');

        systemSwitchesTo('light');
        expect(shownTheme()).toBe('light');
        expect(htmlTheme()).toBe('light');

        systemSwitchesTo('dark');
        expect(shownTheme()).toBe('dark');
        expect(themeWrites()).toEqual({ cookie: [], storage: [] });
    });

    it('the user toggling writes BOTH the cookie and localStorage', () => {
        renderApp();
        fireEvent.click(screen.getByRole('button', { name: 'Toggle theme' }));

        expect(shownTheme()).toBe('light');
        expect(htmlTheme()).toBe('light');
        expect(themeWrites().cookie).toHaveLength(1);
        expect(themeWrites().cookie[0]).toMatch(new RegExp(`^${THEME_COOKIE}=light;`));
        expect(themeWrites().storage).toEqual([[THEME_STORAGE_KEY, 'light']]);
        expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    });

    it('once the user has chosen, the OS no longer moves the theme', () => {
        renderApp();
        fireEvent.click(screen.getByRole('button', { name: 'Toggle theme' }));
        systemSwitchesTo('dark');
        expect(shownTheme()).toBe('light');
    });

    it('a stored choice wins over the OS, and mounting does not write it again', () => {
        seedCookie('dark');
        systemLight = true;
        renderApp();

        expect(shownTheme()).toBe('dark');
        expect(htmlTheme()).toBe('dark');
        systemSwitchesTo('light');
        expect(shownTheme()).toBe('dark');
        expect(themeWrites()).toEqual({ cookie: [], storage: [] });
    });

    it('a localStorage-only choice still wins over the OS, and is not copied into a cookie on mount', () => {
        seedStorage('light');
        renderApp();

        expect(shownTheme()).toBe('light');
        expect(themeWrites()).toEqual({ cookie: [], storage: [] });
        expect(document.cookie).not.toContain(`${THEME_COOKIE}=`);
    });
});

// ─── The pre-paint script ───────────────────────────────────────────────

describe('THEME_INIT_SCRIPT — the pre-paint script follows the same rule', () => {
    // The script is what the root layout inlines in <head>. Executed here as a
    // browser would, so the assertion is about what it DOES.
    const runScript = () => new Function(THEME_INIT_SCRIPT)();

    it('with nothing stored it paints the OS theme and writes no cookie', () => {
        systemLight = true;
        runScript();
        expect(htmlTheme()).toBe('light');
        expect(themeWrites()).toEqual({ cookie: [], storage: [] });
        expect(document.cookie).not.toContain(`${THEME_COOKIE}=`);
    });

    it('paints a stored cookie choice over the OS, without writing', () => {
        seedCookie('dark');
        systemLight = true;
        runScript();
        expect(htmlTheme()).toBe('dark');
        expect(themeWrites()).toEqual({ cookie: [], storage: [] });
    });

    it('paints a localStorage-only choice over the OS, without writing', () => {
        seedStorage('light');
        runScript();
        expect(htmlTheme()).toBe('light');
        expect(themeWrites()).toEqual({ cookie: [], storage: [] });
    });
});
