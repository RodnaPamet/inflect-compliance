/**
 * @jest-environment jsdom
 */
/**
 * R26-PR-C — behavioural coverage for the `useProximityAutoBind`
 * REACT surface.
 *
 * `tests/unit/proximity-auto-bind.test.ts` exercises the pure
 * `findProximityCandidate` geometry. Nothing exercised the hook that
 * wraps it, so every branch below was previously unreached:
 *
 *   • the `threshold` option defaulting vs an explicit override
 *   • the `setCandidate` memo gate that suppresses a re-render when
 *     the pair is unchanged (and therefore FREEZES the reported
 *     distance for the life of that pair)
 *   • `onNodeDragStop` re-running the finder against the latest
 *     props rather than trusting the possibly-unflushed state
 *   • the commit path with and without an `onCommit` callback
 *   • the candidate always clearing on drag stop, committed or not
 */

import { renderHook, act } from '@testing-library/react';
import type { Edge, Node } from '@xyflow/react';
import {
    useProximityAutoBind,
    findProximityCandidate,
    DEFAULT_PROXIMITY_THRESHOLD_PX,
    type ProximityCandidate,
} from '@/lib/processes/use-proximity-auto-bind';

function makeNode(id: string, x: number, y: number): Node {
    return {
        id,
        type: 'processStep',
        position: { x, y },
        data: { label: id, kind: 'processStep' },
        width: 160,
        height: 60,
    } as unknown as Node;
}

/** xyflow passes a real pointer event; the hook ignores it entirely. */
const DRAG_EVENT: unknown = { type: 'pointermove' };

describe('useProximityAutoBind — candidate lifecycle', () => {
    it('starts with no candidate and exposes the pure finder unwrapped', () => {
        const { result } = renderHook(() =>
            useProximityAutoBind([makeNode('A', 0, 0)], []),
        );
        expect(result.current.candidate).toBeNull();
        // The hook advertises `findCandidate` as the SAME pure helper,
        // not a bound wrapper — consumers memoise against it.
        expect(result.current.findCandidate).toBe(findProximityCandidate);
    });

    it('publishes the candidate (with direction + distance) on drag', () => {
        const a = makeNode('A', 0, 0);
        const b = makeNode('B', 60, 0);
        const { result } = renderHook(() =>
            useProximityAutoBind([a, b], []),
        );

        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, a);
        });

        expect(result.current.candidate).toStrictEqual({
            source: 'A',
            target: 'B',
            distance: 60,
        });
    });

    it('leaves the candidate null while the drag stays out of range', () => {
        const a = makeNode('A', 0, 0);
        const far = makeNode('B', 1000, 0);
        const { result } = renderHook(() =>
            useProximityAutoBind([a, far], []),
        );

        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, a);
        });
        expect(result.current.candidate).toBeNull();
    });

    it('clears a live candidate once the drag leaves range', () => {
        const b = makeNode('B', 60, 0);
        const near = makeNode('A', 0, 0);
        const { result, rerender } = renderHook(
            ({ nodes }: { nodes: Node[] }) => useProximityAutoBind(nodes, []),
            { initialProps: { nodes: [near, b] } },
        );

        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, near);
        });
        expect(result.current.candidate?.target).toBe('B');

        // The user keeps dragging; A is now 1000px away.
        const dragged = makeNode('A', 1000, 0);
        rerender({ nodes: [dragged, b] });
        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, dragged);
        });
        expect(result.current.candidate).toBeNull();
    });

    it('keeps the SAME candidate object while the pair is unchanged', () => {
        // The memo gate returns `prev` when source+target match, so the
        // reported `distance` deliberately freezes at the value from
        // the tick that first proposed the pair. Removing the gate
        // would republish a fresh object (and a fresh distance) on
        // every pixel of motion — the re-render storm the gate exists
        // to prevent.
        const b = makeNode('B', 60, 0);
        const { result, rerender } = renderHook(
            ({ nodes }: { nodes: Node[] }) => useProximityAutoBind(nodes, []),
            { initialProps: { nodes: [makeNode('A', 0, 0), b] } },
        );

        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, makeNode('A', 0, 0));
        });
        const first: ProximityCandidate | null = result.current.candidate;
        expect(first).not.toBeNull();
        expect(first!.distance).toBe(60);

        // Same pair, genuinely closer (10px apart now).
        const closer = makeNode('A', 50, 0);
        rerender({ nodes: [closer, b] });
        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, closer);
        });

        expect(result.current.candidate).toBe(first);
        expect(result.current.candidate!.distance).toBe(60);
    });

    it('replaces the candidate when the drag swings to a different target', () => {
        const b = makeNode('B', 60, 0);
        const c = makeNode('C', 0, 400);
        const { result, rerender } = renderHook(
            ({ nodes }: { nodes: Node[] }) => useProximityAutoBind(nodes, []),
            { initialProps: { nodes: [makeNode('A', 0, 0), b, c] } },
        );

        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, makeNode('A', 0, 0));
        });
        expect(result.current.candidate?.target).toBe('B');

        const nearC = makeNode('A', 0, 350);
        rerender({ nodes: [nearC, b, c] });
        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, nearC);
        });
        expect(result.current.candidate).toStrictEqual({
            source: 'A',
            target: 'C',
            distance: 50,
        });
    });
});

describe('useProximityAutoBind — threshold option', () => {
    it('defaults to DEFAULT_PROXIMITY_THRESHOLD_PX when no option is given', () => {
        const a = makeNode('A', 0, 0);
        // 100px apart — inside a 150px threshold, outside the 80px default.
        const b = makeNode('B', 100, 0);
        expect(100).toBeGreaterThan(DEFAULT_PROXIMITY_THRESHOLD_PX);

        const { result } = renderHook(() =>
            useProximityAutoBind([a, b], []),
        );
        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, a);
        });
        expect(result.current.candidate).toBeNull();
    });

    it('honours an explicit threshold override on the same geometry', () => {
        const a = makeNode('A', 0, 0);
        const b = makeNode('B', 100, 0);
        const { result } = renderHook(() =>
            useProximityAutoBind([a, b], [], { threshold: 150 }),
        );
        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, a);
        });
        expect(result.current.candidate).toStrictEqual({
            source: 'A',
            target: 'B',
            distance: 100,
        });
    });

    it('applies the override to the COMMIT path too, not just the preview', () => {
        const a = makeNode('A', 0, 0);
        const b = makeNode('B', 100, 0);
        const onCommit = jest.fn<void, [ProximityCandidate]>();
        const { result } = renderHook(() =>
            useProximityAutoBind([a, b], [], { threshold: 150, onCommit }),
        );
        act(() => {
            result.current.onNodeDragStop(DRAG_EVENT, a);
        });
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith({
            source: 'A',
            target: 'B',
            distance: 100,
        });
    });
});

describe('useProximityAutoBind — drag stop', () => {
    it('commits the in-range candidate and clears the preview', () => {
        const a = makeNode('A', 0, 0);
        const b = makeNode('B', 60, 0);
        const onCommit = jest.fn<void, [ProximityCandidate]>();
        const { result } = renderHook(() =>
            useProximityAutoBind([a, b], [], { onCommit }),
        );

        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, a);
        });
        expect(result.current.candidate).not.toBeNull();

        act(() => {
            result.current.onNodeDragStop(DRAG_EVENT, a);
        });
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith({
            source: 'A',
            target: 'B',
            distance: 60,
        });
        expect(result.current.candidate).toBeNull();
    });

    it('commits without a preceding onNodeDrag — the finder re-runs on stop', () => {
        // The stop handler deliberately does NOT read the `candidate`
        // state (which may not have flushed); it recomputes from the
        // latest props. A drop fast enough to skip a drag tick must
        // still bind.
        const a = makeNode('A', 0, 0);
        const b = makeNode('B', 60, 0);
        const onCommit = jest.fn<void, [ProximityCandidate]>();
        const { result } = renderHook(() =>
            useProximityAutoBind([a, b], [], { onCommit }),
        );

        act(() => {
            result.current.onNodeDragStop(DRAG_EVENT, a);
        });
        expect(onCommit).toHaveBeenCalledWith({
            source: 'A',
            target: 'B',
            distance: 60,
        });
    });

    it('does NOT commit when the node was dragged back out of range', () => {
        const b = makeNode('B', 60, 0);
        const onCommit = jest.fn<void, [ProximityCandidate]>();
        const { result, rerender } = renderHook(
            ({ nodes }: { nodes: Node[] }) =>
                useProximityAutoBind(nodes, [], { onCommit }),
            { initialProps: { nodes: [makeNode('A', 0, 0), b] } },
        );

        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, makeNode('A', 0, 0));
        });
        expect(result.current.candidate).not.toBeNull();

        // Dragged away before release — the preview must be abandoned.
        const away = makeNode('A', 1000, 0);
        rerender({ nodes: [away, b] });
        act(() => {
            result.current.onNodeDragStop(DRAG_EVENT, away);
        });

        expect(onCommit).not.toHaveBeenCalled();
        expect(result.current.candidate).toBeNull();
    });

    it('does not commit a pair that already has an edge', () => {
        const a = makeNode('A', 0, 0);
        const b = makeNode('B', 60, 0);
        const edges: Edge[] = [{ id: 'e1', source: 'B', target: 'A' }];
        const onCommit = jest.fn<void, [ProximityCandidate]>();
        const { result } = renderHook(() =>
            useProximityAutoBind([a, b], edges, { onCommit }),
        );

        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, a);
            result.current.onNodeDragStop(DRAG_EVENT, a);
        });
        expect(onCommit).not.toHaveBeenCalled();
        expect(result.current.candidate).toBeNull();
    });

    it('still clears the preview when no onCommit callback was supplied', () => {
        // `latest && onCommit` — the arm where a candidate exists but
        // the consumer opted out of committing. It must not throw, and
        // the preview edge must still disappear.
        const a = makeNode('A', 0, 0);
        const b = makeNode('B', 60, 0);
        const { result } = renderHook(() =>
            useProximityAutoBind([a, b], []),
        );

        act(() => {
            result.current.onNodeDrag(DRAG_EVENT, a);
        });
        expect(result.current.candidate).not.toBeNull();

        act(() => {
            result.current.onNodeDragStop(DRAG_EVENT, a);
        });
        expect(result.current.candidate).toBeNull();
    });
});
