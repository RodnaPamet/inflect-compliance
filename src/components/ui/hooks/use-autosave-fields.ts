"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Debounced field autosave with an explicit four-state status.
 *
 * `ControlEditPanel` and `TaskEditPanel` each carried the same ~65-line
 * machine — `fieldsRef`, `saveTimer`, `commitFields`, `scheduleCommit`,
 * `commitNow`, `update(partial, immediate)`, the four-state `saveState` and
 * its aria-live status line — with
 * `setTimeout(() => void commitFields(), 800)` byte-identical in both.
 *
 * Two things made that expensive beyond the duplication:
 *
 *   1. `tests/guards/controls-quickview-interaction.test.ts` asserted that
 *      exact `setTimeout` regex against EACH file separately, so extracting
 *      it broke both assertions. The ratchet was holding the copy-paste in
 *      place — the roadmap's central complaint, in miniature. Those two
 *      assertions are now behavioural tests of this hook.
 *   2. The panels seeded form state on mount only, which forced the caller
 *      to remount them with `key={...}` to show a different row. Owning the
 *      values here means a `seed` change re-seeds, and the remount hack goes.
 *
 * ## The parts that are easy to get wrong
 *
 * **`fieldsRef` is the source of truth for a commit, not React state.** A
 * debounced save fires ~800 ms after the keystroke; reading state inside that
 * closure would PATCH whatever was current when the timer was armed. The ref
 * is written synchronously by `update`, so a commit always sends the latest
 * values.
 *
 * **The timer is cleared on unmount.** Otherwise a panel closed mid-debounce
 * fires a PATCH against a component that is gone.
 *
 * **`commitNow` clears the pending timer first.** Blur-after-typing would
 * otherwise send the same body twice.
 *
 * **`canCommit` is a callback, not a boolean.** `TaskEditPanel` gates commits
 * on an async GET having landed, tracked in a ref precisely so it does not
 * re-render. A boolean option would be captured stale; this is read fresh at
 * commit time.
 *
 * **`validate` runs before the status moves to `saving`.** A field that fails
 * a client-side rule was never sent, so showing "Saving…" first would be a
 * lie.
 */

export type AutosaveState = "idle" | "saving" | "saved" | "error";

export interface UseAutosaveFieldsOptions<T extends Record<string, string>> {
    /**
     * Current values. A CHANGE to this object (by value, not identity)
     * re-seeds the fields — which is what lets a caller show a different row,
     * or finish an async load, without remounting.
     */
    seed: T;
    /**
     * Persist the fields. Return a message to surface as an error, or nothing
     * on success. Throwing is treated as a network failure.
     */
    save: (fields: T) => Promise<string | void>;
    /**
     * Client-side check run BEFORE the request. A returned message becomes the
     * error and no request is made.
     */
    validate?: (fields: T) => string | null | undefined;
    /**
     * Read fresh at commit time. `false` skips the commit silently, leaving
     * the status untouched — for gates like "read-only" or "not loaded yet"
     * where there is nothing to report.
     */
    canCommit?: () => boolean;
    /** Message for a thrown (network) failure. */
    networkErrorMessage: string;
    /** Debounce in ms. 800 matches the two panels this replaced. */
    debounceMs?: number;
}

export interface UseAutosaveFieldsResult<T> {
    fields: T;
    state: AutosaveState;
    error: string;
    /** Update fields, then save — debounced, or immediately on blur/change. */
    update: (partial: Partial<T>, immediate?: boolean) => void;
    /** Flush any pending debounce now. */
    commitNow: () => void;
    /**
     * Run an unrelated async save through the SAME status machine — the
     * sibling endpoints (owner, assignee, status) that each panel commits
     * separately but reports in the same status line.
     */
    run: (operation: () => Promise<string | void>) => Promise<void>;
}

export function useAutosaveFields<T extends Record<string, string>>(
    options: UseAutosaveFieldsOptions<T>,
): UseAutosaveFieldsResult<T> {
    const { seed, save, validate, canCommit, networkErrorMessage, debounceMs = 800 } = options;

    const [fields, setFields] = useState<T>(seed);
    const [state, setState] = useState<AutosaveState>("idle");
    const [error, setError] = useState("");

    // The authoritative values for a commit — see the note above on why this
    // is a ref and not the state.
    const fieldsRef = useRef<T>(seed);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Keep the returned callbacks stable while always calling the latest
    // closures — the caller passes inline arrow functions, and rebuilding
    // `update` on every parent render would churn every field's onChange.
    const saveRef = useRef(save);
    saveRef.current = save;
    const validateRef = useRef(validate);
    validateRef.current = validate;
    const canCommitRef = useRef(canCommit);
    canCommitRef.current = canCommit;
    const networkMessageRef = useRef(networkErrorMessage);
    networkMessageRef.current = networkErrorMessage;

    // Re-seed when the caller points at a different row (or an async load
    // lands). Compared by VALUE so an inline object literal does not re-seed
    // on every render and stomp what the user is typing.
    const seedKey = JSON.stringify(seed);
    useEffect(() => {
        // A successful save makes the caller refetch, which hands back a seed
        // equal to what we already hold. That is our own echo, not a new row —
        // re-seeding there would reset "Saved" to "Autosaves" immediately.
        if (JSON.stringify(fieldsRef.current) === seedKey) return;
        fieldsRef.current = seed;
        setFields(seed);
        setState("idle");
        setError("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seedKey]);

    // A panel closed mid-debounce must not PATCH after unmount.
    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        [],
    );

    const run = useCallback(async (operation: () => Promise<string | void>) => {
        setState("saving");
        setError("");
        try {
            const message = await operation();
            if (message) {
                setError(message);
                setState("error");
                return;
            }
            setState("saved");
        } catch {
            // The operation threw — network / offline / DNS. Never surface the
            // raw Error string; it is untranslated.
            setError(networkMessageRef.current);
            setState("error");
        }
    }, []);

    const commitFields = useCallback(async () => {
        if (canCommitRef.current && !canCommitRef.current()) return;
        const current = fieldsRef.current;
        const invalid = validateRef.current?.(current);
        if (invalid) {
            setError(invalid);
            setState("error");
            return;
        }
        await run(() => saveRef.current(current));
    }, [run]);

    const commitNow = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        void commitFields();
    }, [commitFields]);

    const scheduleCommit = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void commitFields(), debounceMs);
    }, [commitFields, debounceMs]);

    const update = useCallback(
        (partial: Partial<T>, immediate = false) => {
            fieldsRef.current = { ...fieldsRef.current, ...partial };
            setFields(fieldsRef.current);
            if (immediate) commitNow();
            else scheduleCommit();
        },
        [commitNow, scheduleCommit],
    );

    return { fields, state, error, update, commitNow, run };
}
