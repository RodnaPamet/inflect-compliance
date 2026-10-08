import type { Metadata, Viewport } from 'next';
import { headers, cookies } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Providers } from './providers';
import { CSP_NONCE_HEADER } from '@/lib/security/csp';
// Import the theme constants from the SERVER-SAFE module — NOT from
// ThemeProvider ('use client'), whose exports resolve to client-reference
// proxies (not their string values) on the server. That proxy bug is exactly
// what made `cookies().get(THEME_COOKIE)` always miss and the inline script's
// localStorage key resolve to `undefined`. See src/lib/theme-constants.ts.
//
// THEME_INIT_SCRIPT is the anti-FOUC script, the SECOND line of defence behind
// the SSR cookie. The primary fix is the `data-theme` rendered server-side from
// the theme cookie below. A user who has CHOSEN a theme has the cookie, so their
// `<html>` is already correct in the first SSR byte, with no client script in
// the race. The script covers everyone else: it resolves cookie → localStorage
// → system `prefers-color-scheme` and sets `data-theme` before paint. It writes
// nothing (see its definition for why).
import {
    THEME_COOKIE,
    THEME_INIT_SCRIPT,
    type Theme,
} from '@/lib/theme-constants';
import './globals.css';

export const metadata: Metadata = {
    title: 'Inflect Compliance — Платформа за съответствие по ISO 27001',
    description: 'Цялостно управление на съответствието по ISO 27001:2022 с карти на SOC 2 и NIS2.',
};

/**
 * R11-PR9 — explicit viewport metadata. Next.js no longer emits a
 * default viewport meta starting in 14.x, so any layout that wants
 * sane mobile rendering must declare it. Locked here at the root so
 * every page inherits the same width=device-width + initial-scale=1
 * baseline. `maximumScale: 5` keeps user-pinch-zoom intact (an
 * accessibility requirement — never set 1 unless the design has
 * truly tested at every viewport).
 */
export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 5,
    viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
    const locale = await getLocale();
    const messages = await getMessages();
    const nonce = (await headers()).get(CSP_NONCE_HEADER) ?? undefined;

    // Flash-proof theme: render `data-theme` from the persisted cookie so the
    // FIRST SSR byte is already the user's theme — no client script has to beat
    // first paint. The cookie exists only once the user has CHOSEN a theme.
    // Without it, this renders the `dark` baseline, and the blocking inline
    // script switches to the stored or OS theme before the browser paints, so
    // there is no flash. Nothing writes the cookie for a visitor who never chose.
    const cookieTheme = (await cookies()).get(THEME_COOKIE)?.value;
    const initialTheme: Theme = cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : 'dark';

    return (
        <html lang={locale} data-theme={initialTheme} suppressHydrationWarning>
            <head>
                {/* Anti-FOUC: set the persisted theme before the browser paints,
                    so a light-theme user never sees a dark flash on load / hard
                    navigation. Carries the CSP nonce when present. */}
                <script
                    nonce={nonce}
                    suppressHydrationWarning
                    dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }}
                />
                {/*
                    2026-05-14 — CSP `strict-dynamic` + webpack chunk
                    loader bridge. Next.js auto-applies the request
                    nonce to its server-rendered `<script>` and
                    `<link>` tags, but DYNAMICALLY-loaded webpack
                    chunks (Next's `chunks/*.js` for code-split
                    components like the R16 visx/motion charts) are
                    injected at runtime via `document.createElement
                    ('script')`. Those don't inherit the nonce
                    automatically — they need webpack to set
                    `script.nonce` at injection time, which webpack
                    does only when `__webpack_nonce__` is defined.
                    Setting it on `window` (and `globalThis` for
                    completeness in stricter runtimes) BEFORE any
                    chunk loads kicks in is what unblocks
                    strict-dynamic for the chart code.

                    The script itself carries the nonce so CSP
                    allows it. Inline content is deterministic
                    (just `var __webpack_nonce__ = '<nonce>';`),
                    no user input — no XSS surface beyond the
                    nonce itself (which is per-request +
                    cryptographically random).
                */}
                {nonce && (
                    /*
                        2026-05-27 — `suppressHydrationWarning` is
                        LOAD-BEARING. Browsers strip the `nonce`
                        attribute from DOM elements AFTER CSP
                        processing (HTML spec — `nonce` is a one-
                        time secret that must never be readable
                        from JavaScript). React's hydration then
                        compares the SSR-emitted `nonce="…"` to the
                        client-visible `nonce=""` and emits a noisy
                        console error: "tree hydrated but some
                        attributes didn't match. This won't be
                        patched up."
                        Hydration itself succeeds (the bridge sets
                        `__webpack_nonce__` before any chunk
                        loads), but headless QA tools that abort on
                        the first console error misinterpret this
                        as a hard hydration failure — see the
                        2026-05-25 QA pass that marked Sidebar /
                        Forms / Mobile sections as BLOCKED due to
                        "JS hydration failure".
                        `suppressHydrationWarning` is the canonical
                        React fix (https://react.dev/link/
                        hydration-mismatch). It tells React: "this
                        attribute will legitimately differ between
                        server and client — don't warn." Zero CSP
                        change; nonce stays applied for browser
                        enforcement.
                    */
                    <script
                        nonce={nonce}
                        suppressHydrationWarning
                        dangerouslySetInnerHTML={{
                            __html: `window.__webpack_nonce__=${JSON.stringify(nonce)};globalThis.__webpack_nonce__=${JSON.stringify(nonce)};`,
                        }}
                    />
                )}
            </head>
            <body suppressHydrationWarning nonce={nonce}>
                {/* NextIntlClientProvider MUST wrap <Providers>, not sit inside
                    it: <Providers> renders app-wide client chrome (the command
                    palette, the shortcut-help <Modal>, toasts) that now call
                    useTranslations(). If the intl provider sat inside Providers,
                    those components would render with no intl context and throw
                    during SSR — 500-ing every route, including /login. */}
                <NextIntlClientProvider messages={messages} locale={locale}>
                    <Providers>{children}</Providers>
                </NextIntlClientProvider>
            </body>
        </html>
    );
}
