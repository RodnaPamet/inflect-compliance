'use client';

// Side effect — disable Zod's eval-based JIT before any schema parses,
// so the strict CSP doesn't report Zod's `new Function` probe. Keep at
// the top of the client entry. See src/lib/zod-jitless.ts.
import '@/lib/zod-jitless';
import { useEffect, useMemo, useState } from 'react';
import { Toaster } from 'sonner';
import { SWRConfig } from 'swr';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { SessionExpiredNotice } from '@/components/layout/session-expired-notice';
import { isSessionExpired, noteUnauthorized, subscribe } from '@/lib/auth/session-expiry';
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
 * `isPaused` was the obvious lever here and it is the WRONG one. SWR checks it
 * twice: at the top of `revalidate`, which is the behaviour we want, and again
 * inside its own `catch` — where a paused config makes it DISCARD the error
 * rather than assign `finalState.error`. Measured against real SWR:
 *
 *     without the seam:  error = ERR:401
 *     with `isPaused`:   expired=true  err=no-error  data=no-data
 *
 * So it bought quiet at the price of blindness: 17 components destructure
 * `error` and would render nothing at all, and `MonitorTab`'s own
 * "feed unavailable" branch — added by this same change, and guarded on
 * `error && !data` — would never fire in the one case it was written for. A
 * hook mounting AFTER expiry gets no loading state either
 * (`shouldDoInitialRevalidation` false ⇒ `isLoading` false, `data` undefined,
 * `error` undefined): indistinguishable from an empty result.
 *
 * So the error is allowed to land, and fetching is stopped by turning off the
 * things that would START a fetch. That also lets SWR's own quiescing work:
 * its polling loop guards on `!getCache().error`, which an assigned error
 * satisfies — a mechanism `isPaused` was defeating by never writing one.
 *
 * `revalidateOnFocus` is the reason this cannot simply be left alone.
 * `DEFAULT_SWR_CONFIG` turns it ON, so without a switch every tab focus would
 * restart the 401 burst that error-quiescing had just stopped.
 *
 * Deliberately NOT `onErrorRetry`: that hook is skipped entirely when
 * `shouldRetryOnError` is false, so a config disabling retries would also
 * silently disable the seam.
 *
 * WHY THERE ARE TWO WRITERS, and why this one was dead until it was fixed.
 * `api-client.ts` marks inside `handleErrorResponse`, which covers every
 * `apiGet` / `useTenantSWR` caller. This `onError` is meant to cover the raw
 * `useSWR` sites that never touch `apiGet` — but it reads `.status` off the
 * thrown error, and all three such fetchers in `src/` put the status in the
 * MESSAGE instead (`throw new Error(\`upcoming-count ${res.status}\`)`). So
 * it could never mark anything `api-client` had not already marked, and the
 * "two disjoint halves" rationale was false as written.
 *
 * `use-calendar-badge` was among them — the 5-minute SidebarNav poller this
 * seam's own reasoning names as the motivating background writer, unable to
 * fire the store it motivates. Those three now throw `ApiClientError`, which
 * carries `status` as a property. A NEW raw `useSWR` fetcher must do the same
 * or it silently falls outside the seam.
 */
export function useSwrSessionSeam() {
    // Re-render the provider when the flag flips, so the config below is
    // recomputed. The store is module-scope (an already-scheduled interval
    // callback closes over its bindings and never sees a `setState`), and
    // this subscription is the one place that scope has to reach React.
    const [expired, setExpired] = useState(isSessionExpired);
    useEffect(() => subscribe(() => setExpired(isSessionExpired())), []);

    return useMemo(
        () => ({
            onError: (err: unknown, key: string) => {
                const status = (err as { status?: unknown } | null)?.status;
                noteUnauthorized(typeof status === 'number' ? status : undefined, key);
            },
            // No `isPaused`. See above.
            ...(expired
                ? {
                      refreshInterval: 0,
                      revalidateOnFocus: false,
                      revalidateOnReconnect: false,
                      revalidateIfStale: false,
                      shouldRetryOnError: false,
                  }
                : {}),
        }),
        [expired],
    );
}

export function Providers({ children }: { children: React.ReactNode }) {
    const swrSeam = useSwrSessionSeam();

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
        <SWRConfig value={swrSeam}>
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
