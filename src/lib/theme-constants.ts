import { uiStorageKey, uiCookieName } from '@/lib/ui-storage';
/**
 * Theme constants — SERVER-SAFE.
 *
 * This module MUST NOT carry a `'use client'` directive and MUST NOT import any
 * client-only module. The root layout (`src/app/layout.tsx`) is a SERVER
 * component and reads these to render `<html data-theme>` from the persisted
 * cookie and to build the anti-FOUC inline script.
 *
 * Why this file exists (load-bearing): these constants previously lived in
 * `ThemeProvider.tsx`, which is a `'use client'` module. When a server
 * component imports a value from a `'use client'` module, Next replaces the
 * export with a CLIENT REFERENCE PROXY — so on the server `THEME_COOKIE` was a
 * function, not the string `'inflect_theme'`. That silently broke BOTH
 * `cookies().get(THEME_COOKIE)` (always undefined → SSR fell back to `dark`)
 * AND `JSON.stringify(THEME_STORAGE_KEY)` in the inline script (→ `undefined`
 * localStorage key) — which is why the theme flashed on every reload.
 *
 * Keep the literal values HERE; the client `ThemeProvider` re-exports them.
 */

export type Theme = 'dark' | 'light';

/** localStorage key (legacy/back-compat mirror, client-only). */
export const THEME_STORAGE_KEY = uiStorageKey('theme');

/**
 * Cookie name — the flash-proof, server-readable channel. RFC6265 token (no
 * `:`), so it differs from THEME_STORAGE_KEY.
 */
export const THEME_COOKIE = uiCookieName('theme');

/**
 * Anti-FOUC theme script, rendered by the root layout in `<head>` before the
 * body, so it runs before first paint.
 *
 * It resolves cookie → localStorage → system `prefers-color-scheme` and sets
 * `data-theme`. It WRITES NOTHING. A theme is stored only when the user picks
 * one (`ThemeProvider`'s `setTheme` / `toggle`), never on a first visit and
 * never from the OS preference: reading `prefers-color-scheme` needs no storage
 * at all, and a UI-customisation cookie is exempt from consent only when the
 * user asked for the preference to be kept (Article 29 WP194). An earlier
 * version wrote the cookie here on every first visit so the NEXT server render
 * would already be right. Without that, a visitor who never chose gets the
 * `dark` server default, and this script corrects it before paint, every visit.
 *
 * Lives here, not in `layout.tsx`, for two reasons. A layout may only export the
 * fields Next allows. And the script is code that runs in a browser, so
 * `tests/rendered/theme-storage-on-choice.test.tsx` executes it rather than
 * pattern-matching its source.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var d=document.documentElement;var ck=${JSON.stringify(THEME_COOKIE)};var lk=${JSON.stringify(THEME_STORAGE_KEY)};var t=null;var m=document.cookie.match(new RegExp('(?:^|;\\\\s*)'+ck+'=(light|dark)\\\\b'));if(m){t=m[1];}if(!t){var s=null;try{s=localStorage.getItem(lk);}catch(e){}if(s==='light'||s==='dark'){t=s;}}if(!t){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';}d.setAttribute('data-theme',t);}catch(e){}})();`;
