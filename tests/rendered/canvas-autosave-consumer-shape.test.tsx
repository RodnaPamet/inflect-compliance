/**
 * Autosave, exercised the way the CANVAS uses it — not in isolation.
 *
 * `tests/rendered/use-canvas-autosave.test.tsx` drives the hook directly and
 * passes. It always did. The canvas nevertheless never autosaved once, because
 * the defect lived in the SEAM between hook and consumer:
 *
 *   1. the hook returned a fresh object literal, so its identity changed every
 *      render;
 *   2. the canvas listed that object in an effect's dependency array;
 *   3. the effect called `markClean()`, which clears the debounce timer that
 *      `markDirty()` had just armed.
 *
 * markDirty scheduled a save, the next render cancelled it, forever. Not
 * "autosave stops retrying after an error" — autosave never ran at all, so
 * every edit between manual saves was unprotected.
 *
 * The consumer's own comment reasoned "markClean is stable (memoised in the
 * hook)". True of the function; false of the object holding it — and the
 * object was what sat in the deps. That is why no unit test caught it: each
 * half is correct on its own.
 *
 * Second defect, same seam: `handleSave` caught every failure and did not
 * rethrow, so the hook's `save()` always resolved. Failures took the SAVED
 * branch — dirtySince nulled, "Saved" rendered over unsaved work — which made
 * `status === 'error'` unreachable from the canvas and the documented
 * no-retry behaviour invisible.
 */
import * as React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useCanvasAutosave } from '@/lib/processes/use-canvas-autosave';

jest.useFakeTimers();

/** The consumer's shape: hook + the markClean-on-load effect. */
function useCanvasLike(save: () => Promise<void>, loading = false) {
    const autosave = useCanvasAutosave({ enabled: !loading, save });
    const { markClean } = autosave;
    React.useEffect(() => {
        if (!loading) markClean();
    }, [loading, markClean]);
    return autosave;
}

/** The ORIGINAL consumer shape: depends on the hook's whole return object. */
function useCanvasLikeObjectDep(save: () => Promise<void>, loading = false) {
    const autosave = useCanvasAutosave({ enabled: !loading, save });
    React.useEffect(() => {
        if (!loading) autosave.markClean();
    }, [loading, autosave]);
    return autosave;
}

describe('depending on the whole hook object is the hazard, not the fix', () => {
    /**
     * The shape that shipped — and it is STILL wrong, which is the point.
     *
     * My first fix memoised the hook's return and claimed that made it safe to
     * depend on. It does not. `status`, `lastSavedAt` and `error` are part of
     * that object and change during every save cycle, so the identity churns
     * mid-cycle no matter how it is memoised. An object carrying changing
     * state can never be a stable dependency.
     *
     * This test exists to stop the next person "fixing" the consumer by
     * depending on the object again, reassured by the memo. The real fix is
     * depending on the specific callback, which the suite below covers.
     */
    it('re-runs the effect mid-cycle, cancelling the pending save', async () => {
        const save = jest.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() => useCanvasLikeObjectDep(save));

        act(() => result.current.markDirty());
        await act(async () => {
            jest.advanceTimersByTime(10_000);
        });

        // Documents the hazard rather than asserting a guarantee that is not
        // there: markDirty flips status to 'pending', the object identity
        // changes, the effect re-runs, markClean() clears the timer.
        expect(save).not.toHaveBeenCalled();
    });
});

describe('autosave fires from the consumer shape', () => {
    it('actually calls save after the debounce', async () => {
        const save = jest.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() => useCanvasLike(save));

        act(() => result.current.markDirty());
        await act(async () => {
            jest.advanceTimersByTime(10_000);
        });

        expect(save).toHaveBeenCalledTimes(1);
        expect(result.current.status).toBe('saved');
    });

    it('survives re-renders between markDirty and the timer firing', () => {
        // The regression exactly: a render in the debounce window used to
        // cancel the pending save.
        const save = jest.fn().mockResolvedValue(undefined);
        const { result, rerender } = renderHook(() => useCanvasLike(save));

        act(() => result.current.markDirty());
        rerender();
        rerender();
        act(() => {
            jest.advanceTimersByTime(10_000);
        });

        expect(save).toHaveBeenCalled();
    });

    it('reaches the error state when the save rejects', async () => {
        // Unreachable before: the canvas swallowed failures, so the hook took
        // its saved branch and reported success over unsaved work.
        const save = jest.fn().mockRejectedValue(new Error('boom'));
        const { result } = renderHook(() => useCanvasLike(save));

        act(() => result.current.markDirty());
        await act(async () => {
            jest.advanceTimersByTime(10_000);
        });

        expect(result.current.status).toBe('error');
        expect(result.current.error).toBe('boom');
    });

    it('does NOT report saved when the save failed', async () => {
        const save = jest.fn().mockRejectedValue(new Error('nope'));
        const { result } = renderHook(() => useCanvasLike(save));

        act(() => result.current.markDirty());
        await act(async () => {
            jest.advanceTimersByTime(10_000);
        });

        expect(result.current.status).not.toBe('saved');
    });

    it('still does not auto-retry after an error — the no-thrash property holds', async () => {
        const save = jest.fn().mockRejectedValue(new Error('down'));
        const { result } = renderHook(() => useCanvasLike(save));

        act(() => result.current.markDirty());
        await act(async () => {
            jest.advanceTimersByTime(10_000);
        });
        expect(save).toHaveBeenCalledTimes(1);

        // A long wait with no further edit must not produce a second attempt.
        await act(async () => {
            jest.advanceTimersByTime(120_000);
        });
        expect(save).toHaveBeenCalledTimes(1);
    });
});

/**
 * The harness above proves the hook behaves correctly WHEN CONSUMED
 * CORRECTLY. It does not prove the canvas consumes it that way — I checked,
 * and reverting either page-side fix leaves all six green.
 *
 * That gap is the whole defect in miniature: `use-canvas-autosave.test.tsx`
 * was green throughout, because the bug lived in the seam rather than in
 * either side. So these pin the two page-side halves directly, in the
 * mirror-and-verify style this repo already uses for the /tests predicates.
 *
 * Rendering PersistedProcessCanvas itself would be better and is not
 * proportionate — 2,504 lines, ReactFlow, SWR and a tenant context.
 */
describe('the canvas consumes the hook the way the harness does', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(
        path.resolve(__dirname, '../../src/components/processes/PersistedProcessCanvas.tsx'),
        'utf8',
    );

    it('the markClean effect depends on the CALLBACK, not the hook object', () => {
        // `[loading, activeId, autosave]` re-runs every time status changes and
        // clears the pending save. That is how autosave never fired.
        expect(src).toMatch(/\}, \[loading, activeId, markClean\]\);/);
        expect(src).not.toMatch(/\}, \[loading, activeId, autosave\]\);/);
    });

    it('handleSave RETHROWS so the hook can see a failure', () => {
        // Swallowing made every failure take the hook's saved branch: dirty
        // cleared, "Saved" rendered over unsaved work, error state unreachable.
        const i = src.indexOf('reportFailure(err, "failSave")');
        expect(i).toBeGreaterThan(-1);
        expect(src.slice(i, i + 900)).toMatch(/throw err;/);
    });
});
