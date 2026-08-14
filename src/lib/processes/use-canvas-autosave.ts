"use client";

/**
 * R28 — Canvas autosave.
 *
 * Debounced "save N seconds after the last edit" loop for the
 * Processes canvas. Sits OUTSIDE the manual Save button — the
 * button still ships, and a manual save resets the autosave
 * dirty clock. Autosave is the safety net, not the primary
 * commit gesture.
 *
 *   • The consumer flags edits via `markDirty()` — typically
 *     inside the `onNodesChange` / `onEdgesChange` handlers
 *     that already fire on every xyflow change.
 *
 *   • After `delayMs` of idle (default 3000ms), the hook calls
 *     the supplied `save()` callback exactly once. If another
 *     edit comes in mid-debounce, the clock restarts.
 *
 *   • If `save()` rejects, the hook returns to `error` and
 *     stops auto-retrying — the user will see the error in the
 *     toolbar and trigger a manual save. Auto-retry can lead
 *     to thrashing under permanent failures (auth expired,
 *     server down) so we make the failure visible instead.
 *
 *   • The dirty flag is preserved across save cycles so a save
 *     that fires while in-flight doesn't lose subsequent edits.
 *     The post-save resolution checks `dirtySince` against the
 *     save's start timestamp; if newer edits arrived during the
 *     in-flight save, the loop schedules another save.
 *
 * Status surface:
 *   • idle     — no pending changes
 *   • pending  — edits seen, debounce timer running
 *   • saving   — save callback in flight
 *   • saved    — last save succeeded; transient "Saved" tag
 *   • error    — last save threw; manual retry required
 *
 * The hook does NOT auto-run on mount. The canvas calls
 * `markDirty()` only AFTER an actual edit fires, so the
 * initial rehydration sequence doesn't trigger a save.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type AutosaveStatus =
    | "idle"
    | "pending"
    | "saving"
    | "saved"
    | "error";

export interface UseCanvasAutosaveOptions {
    /** Idle window before the save fires, ms. Default 3000. */
    delayMs?: number;
    /** Save callback. Throws or rejects on failure. */
    save: () => Promise<void>;
    /** Disable autosave (e.g. while loading or no active map). */
    enabled: boolean;
}

export interface CanvasAutosaveApi {
    /** Flag an edit. Restarts the debounce timer. */
    markDirty: () => void;
    /**
     * Clear the dirty state without saving. Useful after a
     * manual save or a rehydration that should NOT autosave.
     */
    markClean: () => void;
    status: AutosaveStatus;
    /** Wall-clock millis of last successful save, or null. */
    lastSavedAt: number | null;
    /** Error message from the last failed save, or null. */
    error: string | null;
}

export function useCanvasAutosave({
    delayMs = 3000,
    save,
    enabled,
}: UseCanvasAutosaveOptions): CanvasAutosaveApi {
    const [status, setStatus] = useState<AutosaveStatus>("idle");
    const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const dirtySinceRef = useRef<number | null>(null);
    const inFlightRef = useRef(false);
    // Carry the latest save callback through the timer closure so
    // a re-rendered consumer doesn't bind a stale reference.
    const saveRef = useRef(save);
    useEffect(() => {
        saveRef.current = save;
    }, [save]);

    const clearTimer = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const runSave = useCallback(async () => {
        if (inFlightRef.current) return;
        if (!enabled) return;
        const startedAt = Date.now();
        inFlightRef.current = true;
        setStatus("saving");
        setError(null);
        try {
            await saveRef.current();
            // Re-check dirty: if an edit arrived during the save,
            // schedule another debounce cycle. Otherwise we're
            // genuinely clean.
            const dirtyAt = dirtySinceRef.current;
            const stillDirty = dirtyAt !== null && dirtyAt > startedAt;
            setLastSavedAt(Date.now());
            if (stillDirty) {
                setStatus("pending");
                clearTimer();
                timerRef.current = setTimeout(() => {
                    void runSave();
                }, delayMs);
            } else {
                setStatus("saved");
                dirtySinceRef.current = null;
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Autosave failed");
            setStatus("error");
        } finally {
            inFlightRef.current = false;
        }
    }, [enabled, delayMs, clearTimer]);

    const markDirty = useCallback(() => {
        if (!enabled) return;
        dirtySinceRef.current = Date.now();
        setStatus((prev) => (prev === "saving" ? prev : "pending"));
        clearTimer();
        timerRef.current = setTimeout(() => {
            void runSave();
        }, delayMs);
    }, [enabled, delayMs, runSave, clearTimer]);

    const markClean = useCallback(() => {
        dirtySinceRef.current = null;
        clearTimer();
        setStatus("idle");
        setError(null);
    }, [clearTimer]);

    // Tear down the debounce timer when the consumer unmounts —
    // never fire a save against a stale state.
    useEffect(() => () => clearTimer(), [clearTimer]);

    // Memoised so the object only changes identity when its CONTENTS change,
    // rather than on every render.
    //
    // Be clear about what this does NOT buy: `status`, `lastSavedAt` and
    // `error` are part of the returned object and they change during every
    // save cycle, so this object can never be a stable dependency. A consumer
    // that puts the whole object in an effect's dep array WILL re-run that
    // effect mid-cycle — and if the effect calls `markClean()`, it clears the
    // debounce timer `markDirty()` just armed.
    //
    // That is not hypothetical: it is exactly how autosave came to never fire
    // once on the process canvas. The fix that matters is on the consumer
    // side — depend on the specific callback (`markClean`), which IS stable —
    // and `tests/rendered/canvas-autosave-consumer-shape.test.tsx` pins both
    // halves, including a test documenting that the object-dep shape still
    // churns.
    return useMemo(
        () => ({ markDirty, markClean, status, lastSavedAt, error }),
        [markDirty, markClean, status, lastSavedAt, error],
    );
}
