/**
 * useCanvasDrillStack — branch coverage.
 *
 * Branches enumerated from the hook:
 *   - initial state: empty stack → currentGroupId null branch
 *   - enter(): appends to stack (callback updater)
 *   - exit() at root: stack.length === 0 → returns same ref (no-op branch)
 *   - exit() with depth: stack.length !== 0 → slice(0, -1) branch
 *   - reset(): empties stack
 *   - currentGroupId: stack.length === 0 ? null : last (both ternary arms)
 *   - useKeyboardShortcut enabled flag: stack.length > 0 vs === 0
 *
 * The hook calls useKeyboardShortcut, which is a no-op outside the
 * provider (returns inert). That's fine — we drive state via the
 * returned callbacks, not via real Escape keystrokes.
 */
import { act, renderHook } from '@testing-library/react';
import { useCanvasDrillStack } from '@/lib/processes/use-canvas-drill-stack';

describe('useCanvasDrillStack', () => {
    // Branch: initial state — empty stack, currentGroupId null arm.
    it('starts at root: empty stack, null currentGroupId', () => {
        const { result } = renderHook(() => useCanvasDrillStack());
        expect(result.current.stack).toEqual([]);
        expect(result.current.currentGroupId).toBeNull();
    });

    // Branch: enter() append + currentGroupId non-null (last element) arm.
    it('enter pushes a group id and updates currentGroupId', () => {
        const { result } = renderHook(() => useCanvasDrillStack());
        act(() => result.current.enter('g1'));
        expect(result.current.stack).toEqual(['g1']);
        expect(result.current.currentGroupId).toBe('g1');

        act(() => result.current.enter('g2'));
        expect(result.current.stack).toEqual(['g1', 'g2']);
        // last-element arm of the ternary
        expect(result.current.currentGroupId).toBe('g2');
    });

    // Branch: exit() with depth → slice(0,-1) arm.
    it('exit pops one level when nested', () => {
        const { result } = renderHook(() => useCanvasDrillStack());
        act(() => result.current.enter('g1'));
        act(() => result.current.enter('g2'));
        act(() => result.current.exit());
        expect(result.current.stack).toEqual(['g1']);
        expect(result.current.currentGroupId).toBe('g1');
        act(() => result.current.exit());
        expect(result.current.stack).toEqual([]);
        expect(result.current.currentGroupId).toBeNull();
    });

    // Branch: exit() at root → length===0 no-op arm (returns same ref).
    it('exit at root is a no-op', () => {
        const { result } = renderHook(() => useCanvasDrillStack());
        act(() => result.current.exit());
        expect(result.current.stack).toEqual([]);
        expect(result.current.currentGroupId).toBeNull();
    });

    // Branch: reset() empties a populated stack.
    it('reset returns to root from any depth', () => {
        const { result } = renderHook(() => useCanvasDrillStack());
        act(() => result.current.enter('g1'));
        act(() => result.current.enter('g2'));
        act(() => result.current.enter('g3'));
        expect(result.current.stack).toEqual(['g1', 'g2', 'g3']);
        act(() => result.current.reset());
        expect(result.current.stack).toEqual([]);
        expect(result.current.currentGroupId).toBeNull();
    });

    // Branch: reset() on already-empty stack stays empty.
    it('reset at root stays at root', () => {
        const { result } = renderHook(() => useCanvasDrillStack());
        act(() => result.current.reset());
        expect(result.current.stack).toEqual([]);
    });

    // Drives the useKeyboardShortcut `enabled` flag across both arms
    // (stack.length > 0 → enabled true; === 0 → false) by transitioning
    // through both states within one mounted instance.
    it('transitions the keyboard-shortcut enabled flag across both arms', () => {
        const { result } = renderHook(() => useCanvasDrillStack());
        // enabled: false arm at mount
        expect(result.current.stack.length).toBe(0);
        act(() => result.current.enter('g1')); // enabled: true arm
        expect(result.current.stack.length).toBe(1);
        act(() => result.current.exit()); // back to enabled: false arm
        expect(result.current.stack.length).toBe(0);
    });
});
