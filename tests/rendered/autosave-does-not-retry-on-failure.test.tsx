/**
 * Autosave does not retry a failed save — and is not dead afterwards either.
 *
 * ── Why this needed its own test ─────────────────────────────────────
 *
 * `use-canvas-autosave` states the property in prose:
 *
 *   > stops auto-retrying — the user will see the error in the toolbar and
 *   > trigger a manual save. Auto-retry can lead to thrashing under permanent
 *   > failures (auth expired, …)
 *
 * and #2962's cutover list carries it as *"Autosave behaviour unchanged; no
 * retry-thrash on failure."* Nothing asserted it. The existing suite
 * (`use-canvas-autosave.test.tsx`, 13 tests, explicitly branch-coverage) has
 * two rejecting-save cases, and both advance the timers **once** and then check
 * `status` and `error`. Neither advances time again to see whether anything
 * fires.
 *
 * ── The property is an ABSENCE, which is why it is fragile ───────────
 *
 * No-retry works because the `catch` arm **omits** something the success path
 * does explicitly:
 *
 *     try   { … if (stillDirty) { setStatus("pending"); timerRef = setTimeout(runSave, delayMs) } … }
 *     catch { setError(…); setStatus("error") }        // ← no reschedule
 *
 * So the behaviour is correct by what is *not* written there. A later refactor
 * that hoists the reschedule into a shared place, or "fixes" the error path by
 * retrying, reintroduces the thrash — and nothing would have failed.
 *
 * ── Both directions, because one alone is satisfied by a dead hook ───
 *
 * "Never saves again" is also true of an autosave that is permanently broken
 * after its first failure. `dirtySinceRef` is deliberately NOT cleared in the
 * catch arm — the edit really is unsaved — so a NEW edit must still schedule a
 * save. That is the difference between *no auto-retry* and *no autosave*, and
 * the second test is the one that tells them apart.
 */
import { act, renderHook } from "@testing-library/react";

import {
    useCanvasAutosave,
    type UseCanvasAutosaveOptions,
} from "@/lib/processes/use-canvas-autosave";

const DELAY = 3000;

afterEach(() => {
    jest.useRealTimers();
});

function setup(save: jest.Mock) {
    const props: UseCanvasAutosaveOptions = { delayMs: DELAY, save, enabled: true };
    return renderHook((p: UseCanvasAutosaveOptions) => useCanvasAutosave(p), {
        initialProps: props,
    });
}

/** Let the debounce fire and the rejected promise settle. */
async function runDebounce() {
    await act(async () => {
        jest.advanceTimersByTime(DELAY);
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe("after a failed save", () => {
    it("never retries on its own, however long the canvas sits there", async () => {
        jest.useFakeTimers();
        const save = jest.fn().mockRejectedValue(new Error("auth expired"));
        const view = setup(save);

        act(() => view.result.current.markDirty());
        await runDebounce();
        expect(view.result.current.status).toBe("error");
        expect(save).toHaveBeenCalledTimes(1);

        // Ten debounce windows with no user input. A rescheduling error path
        // would have fired nine more times by here — which under a permanent
        // failure (expired auth, revoked access) is the thrash the hook's
        // comment names.
        await act(async () => {
            jest.advanceTimersByTime(DELAY * 10);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(save).toHaveBeenCalledTimes(1);
        // And it is still saying so — the error does not lapse into a state
        // that reads like nothing is wrong.
        expect(view.result.current.status).toBe("error");
    });

    it("but a NEW edit still schedules a save — the hook is not dead", async () => {
        // The discriminator. Without this, a hook that permanently stopped
        // saving after its first failure would pass the test above.
        jest.useFakeTimers();
        const save = jest.fn().mockRejectedValue(new Error("auth expired"));
        const view = setup(save);

        act(() => view.result.current.markDirty());
        await runDebounce();
        expect(save).toHaveBeenCalledTimes(1);
        expect(view.result.current.status).toBe("error");

        // The user carries on editing, which is what the canvas lets them do.
        act(() => view.result.current.markDirty());
        expect(view.result.current.status).toBe("pending");

        await runDebounce();
        expect(save).toHaveBeenCalledTimes(2);
    });

    it("and a success after a failure clears the error rather than sticking", async () => {
        // The manual-retry path the hook's comment points the user at: "the
        // user will see the error in the toolbar and trigger a manual save".
        // If the error survived a subsequent success, the chip would lie.
        jest.useFakeTimers();
        const save = jest
            .fn()
            .mockRejectedValueOnce(new Error("transient"))
            .mockResolvedValue(undefined);
        const view = setup(save);

        act(() => view.result.current.markDirty());
        await runDebounce();
        expect(view.result.current.status).toBe("error");

        act(() => view.result.current.markDirty());
        await runDebounce();

        expect(view.result.current.status).toBe("saved");
        expect(view.result.current.error).toBeNull();
    });
});
