'use client';

// Side effect — disable Zod's eval-based JIT before any schema parses,
// so the strict CSP doesn't report Zod's `new Function` probe. Keep at
// the top of the client entry. See src/lib/zod-jitless.ts.
import '@/lib/zod-jitless';
import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { SWRConfig } from 'swr';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { SessionExpiredNotice } from '@/components/layout/session-expired-notice';
import { isSessionExpired, noteUnauthorized } from '@/lib/auth/session-expiry';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
    CommandPalette,
    CommandPaletteProvider,
} from '@/components/command-palette';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { ShortcutHelpOverlay } from '@/components/app-shell/shortcut-help-overlay';
import { registerFormTelemetrySink } from '@/lib/telemetry/form-telemetry';

/**
 * Epic 54 — bootstrap the global form-telemetry sink once at mount.
 *
 * The sink is intentionally a no-op in open-source mode: a real
 * observability stack (Sentry breadcrumb + PostHog track) can swap in
 * a richer handler from `src/lib/observability/` without touching any
 * modal call site. For local / Playwright visibility of form events,
 * developers set `window.__INFLECT_FORM_TELEMETRY__` from DevTools or
 * a test setup — the hook honours it independent of the sink
 * registered here.
 *
 * We DO register the no-op explicitly (rather than leaving the sink
 * unset) so the hook's `registered === true` check is satisfied and
 * future migrations of the sink don't have to re-discover whether
 * `Providers` already initialised it.
 */
function useFormTelemetryBootstrap() {
    useEffect(() => {
        registerFormTelemetrySink(() => {
            /* wired by the observability layer */
        });
    }, []);
}

function FormTelemetrySink() {
    useFormTelemetryBootstrap();
    return null;
}

/**
 * #2222 — the SWR half of the app-wide 401 seam.
 *
 * Two writers exist, and they cover DISJOINT halves of the problem, which is
 * why neither is sufficient alone. 173 client files call raw `fetch` and 9
 * import `@/lib/api-client`, so:
 *
 *   • a 401 branch in `api-client.ts` reaches the ~150 `useTenantSWR` /
 *     `apiGet` callers — all of which are already bounded — and none of the
 *     hand-rolled pollers that are actually broken;
 *   • this `onError` reaches every `useSWR` in the tree whatever its fetcher,
 *     including one that throws its own error type.
 *
 * `isPaused` is the READ half, and it is the reason this sits at the root: it
 * is checked at the top of SWR's `revalidate` and again before `onError`, so
 * once the flag is set every SWR hook in the app — poll, focus revalidation,
 * reconnect, error retry — stops issuing requests. The timers keep re-arming
 * (SWR's polling `execute()` calls `next()` regardless), but they issue no
 * network calls, which is the behaviour we want: quiet, and recoverable by a
 * reload after re-auth.
 *
 * Deliberately NOT `onErrorRetry`: that hook is skipped entirely when
 * `shouldRetryOnError` is false, so a config that disables retries would also
 * silently disable the seam.
 */
const SWR_SESSION_SEAM = {
    onError: (err: unknown, key: string) => {
        const status = (err as { status?: unknown } | null)?.status;
        noteUnauthorized(typeof status === 'number' ? status : undefined, key);
    },
    isPaused: isSessionExpired,
};

export function Providers({ children }: { children: React.ReactNode }) {
    // No <SessionProvider>. The tenant layout resolves the session
    // server-side via `auth()`, nothing calls `useSession`, and
    // `signIn`/`signOut` work without the provider. Mounting it would
    // trigger a client-side `/api/auth/session` fetch on every page
    // load that frequently aborts when tests/users navigate away,
    // producing "Failed to fetch" noise in the console.
    // Epic 57 — `KeyboardShortcutProvider` owns the single window
    // keydown listener that routes every registered shortcut. It wraps
    // the theme + tooltip providers so shortcuts can reach into the
    // tree without every page re-mounting its own listener.
    // Epic 57 — `CommandPaletteProvider` sits INSIDE the shortcut
    // provider so it can register `mod+k` on the shared registry. The
    // palette itself is rendered once at the shell so it's reachable
    // from any route, layered above page content via its own portal.
    return (
        <SWRConfig value={SWR_SESSION_SEAM}>
            <KeyboardShortcutProvider>
                <CommandPaletteProvider>
                    <ThemeProvider>
                        <TooltipProvider>
                            <FormTelemetrySink />
                            {/*
                             * #2222 — ONE notice for a lapsed session, mounted once
                             * at the shell. Every poller writes into the same
                             * module-scoped store; a per-hook notice would render
                             * ~38 identical banners on a process canvas.
                             */}
                            <SessionExpiredNotice />
                            {children}
                            <CommandPalette />
                            {/*
                             * Epic 57 — `?` pops a live listing of every
                             * registered shortcut. Mounted once at the shell so
                             * the registry is the single source of truth and
                             * shortcuts registered deeper in the tree appear
                             * automatically.
                             */}
                            <ShortcutHelpOverlay />
                            {/*
                             * Global toast host. CopyButton / CopyText and the
                             * optimistic-update hook emit into this Toaster;
                             * without it, every `toast()` call is a silent no-op.
                             */}
                            <Toaster
                                theme="dark"
                                position="top-right"
                                richColors
                                closeButton
                                duration={3000}
                            />
                        </TooltipProvider>
                    </ThemeProvider>
                </CommandPaletteProvider>
            </KeyboardShortcutProvider>
        </SWRConfig>
    );
}
