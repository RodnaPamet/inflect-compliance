/**
 * Epic 67 — visual variant for `useToastWithUndo`.
 *
 * Renders inside sonner's `toast.custom(...)` slot. The hook owns the
 * timer + commit lifecycle (so commits survive page navigation); this
 * component owns nothing but presentation: the destructive message,
 * the Undo button, and an animated countdown bar that mirrors the
 * remaining time until the commit fires.
 *
 * Why a custom variant rather than `toast(message, { action: ... })`:
 *   - Sonner's built-in `action` is a single button without visible
 *     remaining-time feedback. For destructive flows, the user MUST
 *     see how much time they have to act.
 *   - The countdown is the safety affordance — without it the user
 *     can't tell whether the action has already committed or not.
 *
 * Accessibility:
 *   - `role="status"` + `aria-live="polite"` so the message is
 *     announced once when the toast mounts. Subsequent progress
 *     updates are NOT re-announced (would spam screen readers).
 *   - `role="progressbar"` on the bar with `aria-valuenow/min/max`
 *     in milliseconds remaining — surfaces the countdown to AT users
 *     who want to know how long they have left.
 *   - The Undo button is a real `<button>` — keyboard-focusable,
 *     Enter/Space activatable, no custom-role hack.
 *   - `prefers-reduced-motion`: the bar's CSS transition is the only
 *     motion. Browsers honour the user's preference automatically
 *     when we use CSS transition on `width` rather than JS-driven
 *     frame loops.
 */
"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast as sonnerToast } from "sonner";
import { cn } from "@/lib/cn";

export interface UndoToastProps {
    /** Sonner-supplied id for the toast row. Used to dismiss on Undo. */
    toastId: string | number;
    /** Hook-internal id used to look up the pending commit. */
    pendingId: string;
    /** Primary message (e.g. "Item deleted"). */
    message: string;
    /** Undo button label (e.g. "Undo"). */
    undoMessage: string;
    /** Total delay in ms — drives the countdown bar's duration. */
    delayMs: number;
    /**
     * Called when the user clicks Undo. The hook resolves this by:
     *   1. cancelling the pending timer
     *   2. dismissing the toast
     *   3. running the optional caller-supplied `undoAction`
     */
    onUndo: (pendingId: string) => void;
}

export function UndoToast({
    toastId,
    pendingId,
    message,
    undoMessage,
    delayMs,
    onUndo,
}: UndoToastProps) {
    const t = useTranslations("common.ui");
    // The bar starts at 100% width and animates to 0% over `delayMs`.
    // Initial render writes 100%; an effect on the next frame writes 0%
    // so the CSS transition kicks in. Without the two-step the browser
    // sees a single static value and skips the animation.
    const barRef = useRef<HTMLDivElement | null>(null);
    const [remainingMs, setRemainingMs] = useState(delayMs);

    useEffect(() => {
        // Kick the CSS transition on the next paint.
        const raf = requestAnimationFrame(() => {
            if (barRef.current) {
                barRef.current.style.width = "0%";
            }
        });
        return () => cancelAnimationFrame(raf);
    }, []);

    // Update `aria-valuenow` (in seconds remaining, integer) so screen
    // readers exposing the progressbar give a useful read-out without
    // the noise of every-frame updates. Tick at 250ms — smooth enough
    // for AT, cheap enough that it doesn't dominate the main thread.
    useEffect(() => {
        const start = Date.now();
        const interval = window.setInterval(() => {
            const elapsed = Date.now() - start;
            const next = Math.max(0, delayMs - elapsed);
            setRemainingMs(next);
            if (next === 0) window.clearInterval(interval);
        }, 250);
        return () => window.clearInterval(interval);
    }, [delayMs]);

    const remainingSec = Math.ceil(remainingMs / 1000);

    return (
        <div
            role="status"
            aria-live="polite"
            data-undo-toast=""
            className={cn(
                // Sonner's default toast frame — match its size/padding so
                // our custom variant doesn't visually jump compared to the
                // default toast row.
                // B3 — brand-tinted focal-glow texture + elegant border +
                // glass edge (the class provides bg, border, shadow).
                "surface-popup-texture flex w-full max-w-sm flex-col gap-tight rounded-lg",
                "px-4 py-3",
                "text-sm text-content-default",
            )}>
            <div className="flex items-center justify-between gap-compact">
                <span className="font-medium">{message}</span>
                <button
                    type="button"
                    onClick={() => {
                        onUndo(pendingId);
                        sonnerToast.dismiss(toastId);
                    }}
                    className={cn(
                        "shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold",
                        "border border-border-default bg-bg-default",
                        "text-content-default hover:bg-bg-muted",
                        "focus-visible:outline-none focus-visible:ring-2",
                        "focus-visible:ring-brand-emphasis focus-visible:ring-offset-2",
                        "focus-visible:ring-offset-bg-elevated",
                    )}>
                    {undoMessage}
                </button>
            </div>
            <div
                role="progressbar"
                aria-label={t("undoWindow", { label: undoMessage })}
                aria-valuenow={remainingSec}
                aria-valuemin={0}
                aria-valuemax={Math.ceil(delayMs / 1000)}
                aria-valuetext={t("secondsRemaining", { seconds: remainingSec })}
                className="h-1 w-full overflow-hidden rounded-full bg-bg-subtle">
                <div
                    ref={barRef}
                    data-undo-toast-bar=""
                    className="h-full bg-content-warning"
                    style={{
                        width: "100%",
                        transition: `width ${delayMs}ms linear`,
                    }}
                />
            </div>
        </div>
    );
}
