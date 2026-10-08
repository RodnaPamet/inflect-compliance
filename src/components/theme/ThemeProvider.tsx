'use client';

/**
 * Epic 51 — theme provider & `useTheme()` hook.
 *
 * Thin client-side layer that flips `html[data-theme]` between `"dark"` (the
 * default) and `"light"`. It persists the user's CHOICE, in the cookie and in
 * localStorage. Until there is one, it follows the system `prefers-color-scheme`,
 * live, and writes nothing.
 *
 * ── WHEN IT WRITES ──────────────────────────────────────────────────────
 *
 * Only in `setTheme` / `toggle`: the user picked a theme and asked for it to
 * be kept. Never on mount, and never from the OS preference. Reading
 * `prefers-color-scheme` needs no storage at all, and a UI-customisation cookie
 * is exempt from consent only when the user asked for the preference to be
 * kept (Article 29 WP194). A host that promises "only essential cookies"
 * depends on this: this provider used to write a one-year cookie and a
 * localStorage entry with the OS setting on every first visit. The pre-paint
 * script in `@/lib/theme-constants` follows the same rule.
 *
 * The actual colour values live in `src/styles/tokens.css`. This file only
 * decides *which palette* is active; every token-driven component gets the
 * switch for free.
 *
 * The provider must mount inside the root layout (client-side); it does not
 * render anything and has no performance cost on SSR. Reading `useTheme()`
 * before the provider mounts returns `"dark"` (the baseline) — consistent
 * with SSR snapshots.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';

// Theme constants live in a SERVER-SAFE module (no 'use client') so the root
// layout can import them as real string values — importing them from THIS
// client module would hand the server a client-reference proxy, not the
// literal, which silently breaks the SSR cookie read + the inline script. See
// src/lib/theme-constants.ts. Re-exported here for existing client importers.
import {
    type Theme,
    THEME_STORAGE_KEY as STORAGE_KEY,
    THEME_COOKIE,
} from '@/lib/theme-constants';

export { STORAGE_KEY, THEME_COOKIE };
export type { Theme };

export interface ThemeContextValue {
    theme: Theme;
    setTheme: (next: Theme) => void;
    toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year
const ATTR = 'data-theme';

/**
 * Persist to BOTH channels: cookie (drives SSR) + localStorage (back-compat).
 * Called from `setTheme` ONLY — an explicit choice. See the file header.
 */
function persistTheme(theme: Theme) {
    try {
        window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
        // ignore — non-persisting is acceptable
    }
    try {
        const secure = window.location?.protocol === 'https:' ? '; secure' : '';
        document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax${secure}`;
    } catch {
        // ignore
    }
}

function readStoredTheme(): Theme | null {
    // Cookie first (matches what SSR used), then the legacy localStorage value.
    try {
        // Built FROM `THEME_COOKIE`, never from the literal. Spelling the name
        // here a second time is how the constant and the reader drift apart, and
        // they once did — the writer moved and this regex kept matching the old
        // name, so the cookie was set and never read back.
        const m = document.cookie.match(
            new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=(light|dark)\\b`),
        );
        if (m) return m[1] as Theme;
    } catch {
        // document.cookie may be unavailable — ignore.
    }
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored === 'light' || stored === 'dark') return stored;
    } catch {
        // localStorage may throw in private / sandboxed contexts — ignore.
    }
    return null;
}

const SYSTEM_LIGHT_QUERY = '(prefers-color-scheme: light)';

/** The OS preference: light when the system asks for it, else the dark baseline. */
function systemTheme(): Theme {
    if (typeof window === 'undefined') return 'dark';
    if (window.matchMedia?.(SYSTEM_LIGHT_QUERY).matches) return 'light';
    return 'dark';
}

function applyTheme(theme: Theme) {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute(ATTR, theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    // Start in dark (the SSR default) and rehydrate on mount to avoid a
    // hydration mismatch when the stored theme differs from the SSR snapshot.
    const [theme, setThemeState] = useState<Theme>('dark');
    const hasHydrated = useRef(false);
    // Whether the user has CHOSEN a theme: one is stored, or `setTheme` ran.
    // Until then the theme follows the OS and nothing is written.
    const chosen = useRef(false);

    useEffect(() => {
        if (hasHydrated.current) return;
        hasHydrated.current = true;
        const stored = readStoredTheme();
        chosen.current = stored !== null;
        const next = stored ?? systemTheme();
        setThemeState(next);
        applyTheme(next);
        // Nothing is written here. A stored theme is already stored, and the
        // OS preference is re-read on every visit rather than kept: see the
        // file header. (This used to persist on mount, which also copied
        // localStorage-only choices into the cookie. Such a visitor now
        // renders the `dark` server default, and the pre-paint script applies
        // their stored theme before the browser paints.)
    }, []);

    // With no stored choice, keep following the OS while the page is open —
    // a system switch to light or dark at dusk repaints without a reload.
    // Never written: the next visit re-reads the OS, as this one did.
    useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return;
        const query = window.matchMedia(SYSTEM_LIGHT_QUERY);
        const follow = (event: MediaQueryListEvent) => {
            if (chosen.current) return;
            const next: Theme = event.matches ? 'light' : 'dark';
            setThemeState(next);
            applyTheme(next);
        };
        query.addEventListener?.('change', follow);
        return () => query.removeEventListener?.('change', follow);
    }, []);

    const setTheme = useCallback((next: Theme) => {
        // The one place a theme is stored: the user picked it.
        chosen.current = true;
        setThemeState(next);
        applyTheme(next);
        persistTheme(next);
    }, []);

    const toggle = useCallback(() => {
        setTheme(theme === 'dark' ? 'light' : 'dark');
    }, [theme, setTheme]);

    const value = useMemo(
        () => ({ theme, setTheme, toggle }),
        [theme, setTheme, toggle],
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Access the current theme and its setters. Safe to call outside a provider —
 * returns a no-op `setTheme` / `toggle` plus the SSR-safe default, so feature
 * flags can render a toggle without forcing the provider everywhere.
 */
export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (ctx) return ctx;
    return {
        theme: 'dark',
        setTheme: () => {},
        toggle: () => {},
    };
}
