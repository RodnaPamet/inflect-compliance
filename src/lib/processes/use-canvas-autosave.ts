"use client";

/**
 * R28 — Canvas autosave.
 *
 * Debounced "save N seconds after the last edit" loop for the
 * Processes canvas. The manual Save button goes THROUGH it
 * (`flush`), so the two never race each other for the version
 * token. Autosave is the safety net, not the primary commit
 * gesture.
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
    /**
     * Save NOW, through the same queue — the manual Save button.
     *
     * Cancels the debounce, waits for a save already in flight, then saves
     * whether or not anything is dirty (a rename is a save of an unchanged
     * graph). One queue matters: a manual save that ran beside the autosave
     * sent the version the other had just spent, and the server answered 409,
     * which the user saw as somebody else editing their map.
     */
    flush: () => Promise<FlushResult>;
}

/** What a manual save reports back. */
export interface FlushResult {
    /** True when the save callback resolved. */
    ok: boolean;
    /** The failed save's message, or null. */
    error: string | null;
    /** What the failed save threw, for a caller that words its own message. */
    cause?: unknown;
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
    // The in-flight save itself, so `flush` can wait for it.
    const inFlightPromiseRef = useRef<Promise<FlushResult> | null>(null);
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

    const runSave = useCallback((): Promise<FlushResult> => {
        if (inFlightRef.current || !enabled) {
            return Promise.resolve({ ok: false, error: null });
        }
        const startedAt = Date.now();
        inFlightRef.current = true;
        setStatus("saving");
        setError(null);
        const run = (async (): Promise<FlushResult> => {
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
                return { ok: true, error: null };
            } catch (e) {
                const message = e instanceof Error ? e.message : "Autosave failed";
                setError(message);
                setStatus("error");
                return { ok: false, error: message, cause: e };
            } finally {
                inFlightRef.current = false;
                inFlightPromiseRef.current = null;
            }
        })();
        inFlightPromiseRef.current = run;
        return run;
    }, [enabled, delayMs, clearTimer]);

    const flush = useCallback(async (): Promise<FlushResult> => {
        clearTimer();
        // Wait for a save already on the wire. Its result is not ours: the
        // graph may have changed since it serialised, so save again.
        const pending = inFlightPromiseRef.current;
        if (pending) await pending;
        return runSave();
    }, [clearTimer, runSave]);

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
        () => ({ markDirty, markClean, flush, status, lastSavedAt, error }),
        [markDirty, markClean, flush, status, lastSavedAt, error],
    );
}
