'use client';

/**
 * `useToast()` — Roadmap-2 PR-9.
 *
 * One canonical toast vocabulary across the product. Four named
 * methods, each with a locked variant + duration + dismiss
 * behaviour. Pages don't reach for sonner's raw `toast()` —
 * they call the right method on this hook and the design
 * decisions stay centralized.
 *
 *   useToast().success('Item created')
 *   useToast().error('Save failed', { description: '…' })
 *   useToast().info('Settings updated')
 *   useToast().warning('This action cannot be undone')
 *
 * Why a hook (not a free function):
 *   • Future versions can layer in route-context (auto-dismiss
 *     on navigation, suppression during print mode) without
 *     touching call sites.
 *   • The hook is the canonical seam for ratchets — banning
 *     direct `from 'sonner'` imports forces every call site
 *     through one place.
 *
 * The undo pattern (`useToastWithUndo`) is the FIFTH method.
 * It lives in its own file because the timing + countdown bar
 * mechanics are different enough to deserve a dedicated hook.
 * `useToast` and `useToastWithUndo` coexist; this hook never
 * tries to absorb the undo flow.
 *
 * Locked durations:
 *   • success — 3000ms (short, the user moves on)
 *   • info    — 4000ms (slightly longer to read)
 *   • warning — 5000ms (caution, ensure attention)
 *   • error   — Infinity (sticky-with-dismiss; the user must
 *               acknowledge)
 *
 * Override locked durations via `opts.duration` only when
 * genuinely needed (long-running uploads etc.). Default is the
 * locked value.
 */
import { toast as sonnerToast, type ExternalToast } from 'sonner';
import { useMemo } from 'react';

const LOCKED_DURATION = {
    success: 3000,
    info: 4000,
    warning: 5000,
    // sonner treats `Infinity` as sticky-until-dismiss. The
    // close button rendered by the Toaster (in providers.tsx)
    // is the user's exit.
    error: Infinity,
} as const;

export interface ToastOptions extends Omit<ExternalToast, 'duration'> {
    /** Override the locked duration (ms). Use sparingly. */
    duration?: number;
}

export interface ToastApi {
    success: (message: string, opts?: ToastOptions) => string | number;
    error: (message: string, opts?: ToastOptions) => string | number;
    info: (message: string, opts?: ToastOptions) => string | number;
    warning: (message: string, opts?: ToastOptions) => string | number;
    /** Dismiss a specific toast by id, or all toasts if omitted. */
    dismiss: (id?: string | number) => void;
}

function build(
    variant: 'success' | 'error' | 'info' | 'warning',
): ToastApi['success'] {
    return (message, opts) =>
        // THE LOCKED DURATION IS FORWARDED ON EVERY CALL, opts or no
        // opts. It used to be forwarded only when the caller passed
        // `opts`, on the stated grounds that the `<Toaster>` mount's
        // `toastOptions` set the default per variant. It does not:
        // `providers.tsx` mounts `<Toaster … duration={3000} />` and has
        // no `toastOptions` at all. So three of the four documented
        // durations above were fiction for the common call — the
        // single-argument one — and the consequential one was `error`,
        // documented as sticky-until-dismiss (`Infinity`) and actually
        // auto-dismissing after three seconds. A failure the user has
        // not acknowledged disappearing on its own is the exact thing
        // `Infinity` was chosen to prevent.
        //
        // Forwarding unconditionally also makes the locked table the
        // single source of truth, rather than something a flat number at
        // the mount silently overrides.
        //
        // An explicit `opts.duration` still wins — that is the
        // documented override, and `??` keeps a caller-supplied
        // `Infinity` or `0` intact where `||` would not.
        sonnerToast[variant](message, {
            ...opts,
            duration: opts?.duration ?? LOCKED_DURATION[variant],
        });
}

const api: ToastApi = {
    success: build('success'),
    error: build('error'),
    info: build('info'),
    warning: build('warning'),
    dismiss: (id) => sonnerToast.dismiss(id),
};

export function useToast(): ToastApi {
    // Stable reference per app — sonner's API is module-scoped,
    // so the hook just hands back the same `api` object across
    // re-renders. `useMemo` keeps the contract explicit if a
    // future version of the hook adds context-dependent state.
    return useMemo(() => api, []);
}
