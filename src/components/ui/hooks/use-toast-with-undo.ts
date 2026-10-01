/**
 * Epic 67 — `useToastWithUndo` hook.
 *
 * Reusable foundation for delayed-commit destructive actions across
 * delete / unlink / remove flows. The actual destructive commit is
 * delayed by `delayMs` (default 5000); during that window the user
 * sees a toast with an Undo button + animated countdown. Click Undo
 * before the timer fires → commit is cancelled. Let the timer fire →
 * commit runs and the toast dismisses.
 *
 * Returns a stable `trigger` function that callers invoke with the
 * destructive action and presentation strings:
 *
 *   ```tsx
 *   const triggerUndoToast = useToastWithUndo();
 *
 *   async function handleDelete(id: string) {
 *     setLocalRows((rs) => rs.filter((r) => r.id !== id));   // optimistic
 *     triggerUndoToast({
 *       message: 'Item deleted',
 *       undoMessage: 'Undo',
 *       action: () => fetch(`/api/.../items/${id}`, { method: 'DELETE' }),
 *       undoAction: () => refetchRows(),                      // restore optimistic UI
 *       onError: () => refetchRows(),
 *     });
 *   }
 *   ```
 *
 * Lifecycle model — pending commits are held in module-level state, NOT
 * component state. That choice is deliberate:
 *
 *   - Sonner's toast portal lives at the app shell, so the toast itself
 *     survives client-side navigation. Tying the timer to a per-page
 *     hook instance would mean an in-flight commit is silently dropped
 *     when the user navigates away mid-countdown — a destructive bug.
 *   - Gmail "undo send" UX: the user pressed Delete, they meant it; the
 *     undo window is a courtesy. If they leave the page before clicking
 *     Undo, the commit fires.
 *
 * Programmatic cancellation (without running undoAction) is available
 * via `cancelPendingUndoToast(id)` for callers that need it.
 *
 * SSR safety: every browser-touching path is guarded with
 * `typeof window === 'undefined'`. The trigger is a no-op on the server.
 *
 * @module
 */
import { createElement, useCallback } from "react";
import { toast as sonnerToast } from "sonner";

import { UndoToast } from "@/components/ui/undo-toast";

// ─── Types ──────────────────────────────────────────────────────────

export interface TriggerUndoToastInput<T = unknown> {
    /**
     * The destructive commit. Called once after `delayMs` if the user
     * does NOT click Undo. Resolved value is forwarded to `onCommit`.
     */
    action: () => Promise<T>;
    /**
     * Optional restore step. Called when the user clicks Undo. Useful
     * for restoring an optimistic UI change (e.g. re-inserting a row
     * the caller already removed locally before triggering the toast).
     */
    undoAction?: () => Promise<void> | void;
    /** Primary message shown in the toast (e.g. "Item deleted"). */
    message: string;
    /** Label for the Undo button (e.g. "Undo"). */
    undoMessage: string;
    /** Delay before the action commits, in ms. Default 5000. */
    delayMs?: number;
    /** Called once `action` resolves. Not called if Undo wins. */
    onCommit?: (result: T) => void;
    /** Called if `action` rejects. Receives the thrown error. */
    onError?: (error: unknown) => void;
    /** Called when the user clicks Undo, before `undoAction` runs. */
    onUndo?: () => void;
}

export type TriggerUndoToast = <T = unknown>(
    input: TriggerUndoToastInput<T>,
) => string | number;

// ─── Module-level pending registry ──────────────────────────────────
//
// Keyed by an internal pendingId so we can cancel a specific entry
// without confusing it with sonner's toastId. We deliberately don't
// reuse the toastId because sonner returns numbers + strings depending
// on call shape and we want a stable string for `cancelPendingUndoToast`
// callers.

interface PendingEntry {
    timer: ReturnType<typeof setTimeout>;
    settled: boolean;
}

const pending = new Map<string, PendingEntry>();

// Counter only used for in-process uniqueness — never persisted.
let pendingCounter = 0;

function nextPendingId(): string {
    pendingCounter += 1;
    return `undo-toast-${Date.now()}-${pendingCounter}`;
}

// ─── Hook ───────────────────────────────────────────────────────────

const DEFAULT_DELAY_MS = 5000;

export function useToastWithUndo(): TriggerUndoToast {
    // The trigger is stable across renders — no per-render closure
    // captures, all state lives in the module Map.
    const trigger = useCallback(
        <T = unknown>(input: TriggerUndoToastInput<T>): string | number => {
            // SSR no-op — sonner's `toast(...)` itself would crash if
            // called outside the browser, and there's no Toaster portal
            // to render into either way.
            if (typeof window === "undefined") return "";

            const {
                action,
                undoAction,
                message,
                undoMessage,
                delayMs = DEFAULT_DELAY_MS,
                onCommit,
                onError,
                onUndo: onUndoCallback,
            } = input;

            const pendingId = nextPendingId();

            // Capture sonner's toastId from the synchronous `toast.custom`
            // return so the timer can dismiss the row when the commit
            // resolves on its own.
            let toastId: string | number = "";

            // Schedule the commit. Anything held in Map is mutable so
            // the Undo path can flag-set `settled` before clearing.
            const timer = setTimeout(() => {
                const entry = pending.get(pendingId);
                if (!entry || entry.settled) return;
                entry.settled = true;
                pending.delete(pendingId);

                // Run the destructive action. Errors are caller-routable
                // via onError; we do NOT re-throw — there's no React
                // boundary at the timer callsite, an unhandled rejection
                // here would just log to the console.
                Promise.resolve()
                    .then(() => action())
                    .then(
                        (result) => {
                            sonnerToast.dismiss(toastId);
                            onCommit?.(result);
                        },
                        (err) => {
                            sonnerToast.dismiss(toastId);
                            onError?.(err);
                        },
                    );
            }, delayMs);

            pending.set(pendingId, { timer, settled: false });

            const handleUndo = (id: string) => {
                const entry = pending.get(id);
                if (!entry || entry.settled) return;
                entry.settled = true;
                clearTimeout(entry.timer);
                pending.delete(id);

                onUndoCallback?.();
                if (undoAction) {
                    Promise.resolve()
                        .then(() => undoAction())
                        .catch(() => {
                            /* swallow — the user already saw the undo
                             * succeed visually; surfacing a follow-up
                             * error would be confusing. Caller can
                             * handle it inside undoAction itself. */
                        });
                }
            };

            toastId = sonnerToast.custom(
                (t) =>
                    createElement(UndoToast, {
                        toastId: t,
                        pendingId,
                        message,
                        undoMessage,
                        delayMs,
                        onUndo: handleUndo,
                    }),
                {
                    // Add a small grace beyond delayMs so sonner's own
                    // auto-dismiss doesn't fire before our setTimeout
                    // gets to run. We dismiss explicitly on commit.
                    duration: delayMs + 1000,
                },
            );

            return toastId;
        },
        [],
    );

    return trigger;
}

// ─── Programmatic cancellation ──────────────────────────────────────

/**
 * Cancel a pending undo-toast commit WITHOUT running the caller's
 * `undoAction`. Useful for cleanup paths where the caller has already
 * undone the optimistic UI change by other means (e.g. a parent
 * `useEffect` reset). Returns true if a pending entry was cancelled,
 * false if the id is unknown or already settled.
 */
export function cancelPendingUndoToast(pendingId: string): boolean {
    const entry = pending.get(pendingId);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    pending.delete(pendingId);
    return true;
}

/**
 * Test-only escape hatch — flushes every pending commit by clearing
 * timers and removing entries. Not exported via the barrel; tests
 * reach in directly to keep the public API minimal.
 */
export function __resetPendingUndoToastsForTest(): void {
    for (const entry of pending.values()) {
        clearTimeout(entry.timer);
    }
    pending.clear();
    pendingCounter = 0;
}

/**
 * Test-only inspection — returns the count of currently-pending
 * commits. Used by hook tests to assert lifecycle invariants.
 */
export function __pendingUndoToastCountForTest(): number {
    return pending.size;
}
