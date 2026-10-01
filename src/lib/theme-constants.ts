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
