'use client';

/**
 * Epic 51 — theme provider & `useTheme()` hook.
 *
 * Thin client-side layer that flips `html[data-theme]` between `"dark"` (the
 * default) and `"light"`, persisting the user's choice in localStorage and
 * honouring the system `prefers-color-scheme` for the first visit.
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

/** Persist to BOTH channels: cookie (drives SSR) + localStorage (back-compat). */
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

function readInitialTheme(): Theme {
    if (typeof window === 'undefined') return 'dark';
    const stored = readStoredTheme();
    if (stored) return stored;
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
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

    useEffect(() => {
        if (hasHydrated.current) return;
        hasHydrated.current = true;
        const next = readInitialTheme();
        setThemeState(next);
        applyTheme(next);
        // Write the cookie even on a read (migrates localStorage-only users and
        // first-visit prefers-color-scheme picks) so the NEXT load's SSR is
        // already correct — the flash can never recur after the first paint.
        persistTheme(next);
    }, []);

    const setTheme = useCallback((next: Theme) => {
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
