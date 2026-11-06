/**
 * useCanvasAutosave — branch-coverage tests (JSDOM project).
 *
 * Exercises the debounced autosave hook from
 * `src/lib/processes/use-canvas-autosave.ts`:
 *
 *   • markDirty: !enabled early-return, status saving-vs-pending,
 *     debounce timer restart (clearTimer with a live timer).
 *   • runSave: inFlight guard, !enabled guard, save success path,
 *     stillDirty true (re-schedule) vs false (settle to "saved"),
 *     catch arm with Error message vs non-Error fallback message.
 *   • markClean: clears dirty + timer, resets to idle.
 *   • unmount cleanup effect (clearTimer on teardown).
 *   • saveRef refresh effect when the save callback identity changes.
 */
import { act, renderHook } from "@testing-library/react";
import {
    useCanvasAutosave,
    type CanvasAutosaveApi,
    type UseCanvasAutosaveOptions,
} from "@/lib/processes/use-canvas-autosave";

const DELAY = 3000;

afterEach(() => {
    jest.useRealTimers();
});

function setup(opts: Partial<UseCanvasAutosaveOptions> = {}) {
    const save = opts.save ?? jest.fn().mockResolvedValue(undefined);
    const props: UseCanvasAutosaveOptions = {
        delayMs: opts.delayMs ?? DELAY,
        save,
        enabled: opts.enabled ?? true,
    };
    const view = renderHook(
        (p: UseCanvasAutosaveOptions) => useCanvasAutosave(p),
        { initialProps: props },
    );
    return { view, save, props };
}

describe("useCanvasAutosave", () => {
    // ─── initial status ─────────────────────────────────────────────
    it("starts idle with null lastSavedAt and error", () => {
        const { view } = setup();
        expect(view.result.current.status).toBe("idle");
        expect(view.result.current.lastSavedAt).toBeNull();
        expect(view.result.current.error).toBeNull();
    });

    // ─── markDirty: !enabled early-return branch ────────────────────
    it("markDirty is a no-op when disabled (early return)", () => {
        jest.useFakeTimers();
        const save = jest.fn().mockResolvedValue(undefined);
        const { view } = setup({ enabled: false, save });
        act(() => view.result.current.markDirty());
        // Status untouched, no timer scheduled.
        expect(view.result.current.status).toBe("idle");
        act(() => jest.advanceTimersByTime(DELAY * 2));
        expect(save).not.toHaveBeenCalled();
    });

    // ─── markDirty → pending → debounce → save success → saved ──────
    it("debounces a dirty edit, runs save, and settles to saved", async () => {
        jest.useFakeTimers();
        const save = jest.fn().mockResolvedValue(undefined);
        const { view } = setup({ save });

        act(() => view.result.current.markDirty());
        expect(view.result.current.status).toBe("pending");
        // Before the delay elapses, save has not fired.
        act(() => jest.advanceTimersByTime(DELAY - 1));
        expect(save).not.toHaveBeenCalled();

        await act(async () => {
            jest.advanceTimersByTime(1);
            await Promise.resolve();
        });
        expect(save).toHaveBeenCalledTimes(1);
        expect(view.result.current.status).toBe("saved");
        expect(view.result.current.lastSavedAt).not.toBeNull();
        expect(view.result.current.error).toBeNull();
    });

    // ─── markDirty restarts the debounce (clearTimer live-timer branch) ─
    it("a second markDirty before the delay restarts the timer", async () => {
        jest.useFakeTimers();
        const save = jest.fn().mockResolvedValue(undefined);
        const { view } = setup({ save });

        act(() => view.result.current.markDirty());
        act(() => jest.advanceTimersByTime(DELAY - 500));
        // Restart — clearTimer hits the live-timer branch.
        act(() => view.result.current.markDirty());
        act(() => jest.advanceTimersByTime(DELAY - 500));
        // Original deadline passed but timer was reset → no save yet.
        expect(save).not.toHaveBeenCalled();

        await act(async () => {
            jest.advanceTimersByTime(500);
            await Promise.resolve();
        });
        expect(save).toHaveBeenCalledTimes(1);
    });

    // ─── runSave catch arm: Error instance → uses .message ──────────
    it("a rejecting save with an Error transitions to error with its message", async () => {
        jest.useFakeTimers();
        const save = jest.fn().mockRejectedValue(new Error("disk full"));
        const { view } = setup({ save });

        act(() => view.result.current.markDirty());
        await act(async () => {
            jest.advanceTimersByTime(DELAY);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(view.result.current.status).toBe("error");
        expect(view.result.current.error).toBe("disk full");
    });

    // ─── runSave catch arm: non-Error throw → fallback message ──────
    it("a rejecting save with a non-Error uses the fallback message", async () => {
        jest.useFakeTimers();
        const save = jest.fn().mockRejectedValue("string failure");
        const { view } = setup({ save });

        act(() => view.result.current.markDirty());
        await act(async () => {
            jest.advanceTimersByTime(DELAY);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(view.result.current.status).toBe("error");
        expect(view.result.current.error).toBe("Autosave failed");
    });

    // ─── runSave stillDirty=true branch: edit during in-flight save ─
    it("an edit during the in-flight save re-schedules another save (stillDirty)", async () => {
        jest.useFakeTimers();
        let resolveSave: (() => void) | null = null;
        const save = jest.fn().mockImplementation(
            () =>
                new Promise<void>((res) => {
                    resolveSave = res;
                }),
        );
        const { view } = setup({ save });

        // First dirty → debounce → save starts (status saving).
        act(() => view.result.current.markDirty());
        act(() => jest.advanceTimersByTime(DELAY));
        expect(view.result.current.status).toBe("saving");
        expect(save).toHaveBeenCalledTimes(1);

        // Edit arrives DURING the in-flight save. dirtySince advances
        // past the save's startedAt. markDirty sees status==="saving"
        // so it keeps "saving" (the saving-branch of the setStatus).
        act(() => {
            jest.advanceTimersByTime(10);
            view.result.current.markDirty();
        });
        expect(view.result.current.status).toBe("saving");

        // Resolve the in-flight save → stillDirty=true → status pending
        // and a fresh debounce is scheduled.
        await act(async () => {
            resolveSave!();
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(view.result.current.status).toBe("pending");

        // The re-scheduled save fires after the delay.
        await act(async () => {
            jest.advanceTimersByTime(DELAY);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(save).toHaveBeenCalledTimes(2);
    });

    // ─── runSave inFlight guard: concurrent invocation is ignored ───
    it("runSave's in-flight guard prevents a concurrent second run", async () => {
        jest.useFakeTimers();
        let resolveSave: (() => void) | null = null;
        const save = jest.fn().mockImplementation(
            () =>
                new Promise<void>((res) => {
                    resolveSave = res;
                }),
        );
        const { view } = setup({ save });

        act(() => view.result.current.markDirty());
        act(() => jest.advanceTimersByTime(DELAY));
        expect(save).toHaveBeenCalledTimes(1);
        expect(view.result.current.status).toBe("saving");

        // markClean does NOT touch inFlight; manually firing another
        // debounce while saving must not start a second save. We
        // simulate by marking dirty (re-arm) then forcing the timer —
        // runSave bails on the inFlightRef guard.
        act(() => view.result.current.markDirty());
        act(() => jest.advanceTimersByTime(DELAY));
        expect(save).toHaveBeenCalledTimes(1); // guard held

        await act(async () => {
            resolveSave!();
            await Promise.resolve();
            await Promise.resolve();
        });
    });

    // ─── runSave !enabled guard ─────────────────────────────────────
    // Note: the in-runSave `!enabled` early-return is only reachable
    // via a timer whose captured `runSave` closure already saw
    // `enabled:false`. Because `markDirty` itself guards on `!enabled`,
    // a fresh debounce can never be scheduled while disabled, and an
    // in-flight re-schedule re-binds through the latest closure. The
    // branch is defensively dead from the public surface; covered as
    // far as the API allows by the markDirty/markClean disabled tests.

    // ─── markClean: clears dirty + timer, resets to idle ────────────
    it("markClean cancels a pending save and resets to idle", () => {
        jest.useFakeTimers();
        const save = jest.fn().mockResolvedValue(undefined);
        const { view } = setup({ save });

        act(() => view.result.current.markDirty());
        expect(view.result.current.status).toBe("pending");
        act(() => view.result.current.markClean());
        expect(view.result.current.status).toBe("idle");
        expect(view.result.current.error).toBeNull();

        act(() => jest.advanceTimersByTime(DELAY * 2));
        expect(save).not.toHaveBeenCalled();
    });

    // ─── markClean with no live timer (clearTimer null branch) ──────
    it("markClean is safe when no timer is pending (clearTimer null branch)", () => {
        const { view } = setup();
        act(() => view.result.current.markClean());
        expect(view.result.current.status).toBe("idle");
    });

    // ─── unmount cleanup effect: clearTimer on teardown ─────────────
    it("unmounting clears the pending debounce timer", () => {
        jest.useFakeTimers();
        const save = jest.fn().mockResolvedValue(undefined);
        const { view } = setup({ save });
        act(() => view.result.current.markDirty());
        view.unmount();
        act(() => jest.advanceTimersByTime(DELAY * 2));
        expect(save).not.toHaveBeenCalled();
    });

    // ─── saveRef refresh effect: latest callback is used ────────────
    it("uses the latest save callback after the consumer re-renders", async () => {
        jest.useFakeTimers();
        const firstSave = jest.fn().mockResolvedValue(undefined);
        const secondSave = jest.fn().mockResolvedValue(undefined);
        const { view, props } = setup({ save: firstSave });

        act(() => view.result.current.markDirty());
        // Re-render with a new save identity BEFORE the timer fires.
        view.rerender({ ...props, save: secondSave });
        await act(async () => {
            jest.advanceTimersByTime(DELAY);
            await Promise.resolve();
        });
        expect(firstSave).not.toHaveBeenCalled();
        expect(secondSave).toHaveBeenCalledTimes(1);
    });

    // ─── markDirty default delayMs branch (delayMs undefined) ───────
    it("falls back to the 3000ms default when delayMs is omitted", async () => {
        jest.useFakeTimers();
        const save = jest.fn().mockResolvedValue(undefined);
        const view = renderHook(() =>
            useCanvasAutosave({ save, enabled: true } as UseCanvasAutosaveOptions),
        );
        act(() => view.result.current.markDirty());
        act(() => jest.advanceTimersByTime(2999));
        expect(save).not.toHaveBeenCalled();
        await act(async () => {
            jest.advanceTimersByTime(1);
            await Promise.resolve();
        });
        expect(save).toHaveBeenCalledTimes(1);
    });

    // ─── flush: the manual Save, through the same queue ─────────────
    describe("flush", () => {
        it("saves at once, cancels the pending debounce, and reports ok", async () => {
            jest.useFakeTimers();
            const save = jest.fn().mockResolvedValue(undefined);
            const { view } = setup({ save });
            act(() => view.result.current.markDirty());

            let result: Awaited<ReturnType<CanvasAutosaveApi["flush"]>> | undefined;
            await act(async () => {
                result = await view.result.current.flush();
            });
            expect(result).toEqual({ ok: true, error: null });
            expect(save).toHaveBeenCalledTimes(1);
            expect(view.result.current.status).toBe("saved");

            // The debounce the edit armed must not fire a second save.
            await act(async () => {
                jest.advanceTimersByTime(DELAY * 2);
                await Promise.resolve();
            });
            expect(save).toHaveBeenCalledTimes(1);
        });

        it("saves even with nothing dirty — a rename is a save of an unchanged graph", async () => {
            const save = jest.fn().mockResolvedValue(undefined);
            const { view } = setup({ save });
            await act(async () => {
                await view.result.current.flush();
            });
            expect(save).toHaveBeenCalledTimes(1);
        });

        it("WAITS for a save already in flight, then saves again — never two at once", async () => {
            // The defect this exists for: the bar's Save PUT on its own beside
            // an in-flight autosave, both carrying the same version, and the
            // second came back 409.
            jest.useFakeTimers();
            let release!: () => void;
            let concurrent = 0;
            let maxConcurrent = 0;
            const save = jest.fn(async () => {
                concurrent += 1;
                maxConcurrent = Math.max(maxConcurrent, concurrent);
                if (save.mock.calls.length === 1) {
                    await new Promise<void>((r) => {
                        release = r;
                    });
                }
                concurrent -= 1;
            });
            const { view } = setup({ save });
            act(() => view.result.current.markDirty());
            await act(async () => {
                jest.advanceTimersByTime(DELAY);
                await Promise.resolve();
            });
            expect(save).toHaveBeenCalledTimes(1);

            let flushed: Promise<unknown> | undefined;
            act(() => {
                flushed = view.result.current.flush();
            });
            await act(async () => {
                await Promise.resolve();
            });
            // Still the one: the flush is waiting, not racing.
            expect(save).toHaveBeenCalledTimes(1);

            await act(async () => {
                release();
                await flushed;
            });
            expect(save).toHaveBeenCalledTimes(2);
            expect(maxConcurrent).toBe(1);
        });

        it("reports a failure with its message and what was thrown", async () => {
            const boom = new Error("Only an editor can change this map");
            const save = jest.fn().mockRejectedValue(boom);
            const { view } = setup({ save });
            let result: Awaited<ReturnType<CanvasAutosaveApi["flush"]>> | undefined;
            await act(async () => {
                result = await view.result.current.flush();
            });
            expect(result).toEqual({
                ok: false,
                error: "Only an editor can change this map",
                cause: boom,
            });
            expect(view.result.current.status).toBe("error");
        });

        it("does not save while disabled", async () => {
            const save = jest.fn().mockResolvedValue(undefined);
            const { view } = setup({ save, enabled: false });
            let result: Awaited<ReturnType<CanvasAutosaveApi["flush"]>> | undefined;
            await act(async () => {
                result = await view.result.current.flush();
            });
            expect(save).not.toHaveBeenCalled();
            expect(result?.ok).toBe(false);
        });
    });
});

// Keep the API type referenced so an unused-import lint never strips it.
const _typeCheck: CanvasAutosaveApi | null = null;
void _typeCheck;
