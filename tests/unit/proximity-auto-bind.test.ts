/**
 * R26-PR-C — Proximity auto-bind geometry tests.
 *
 * Exercises `findProximityCandidate` directly (the pure helper
 * the hook exposes for testing). The React surface that wires it
 * into xyflow is covered by the structural ratchet at
 * `tests/guards/r26-prc-proximity-auto-bind.test.ts`.
 */

import type { Edge, Node } from '@xyflow/react';
import {
    findProximityCandidate,
    DEFAULT_PROXIMITY_THRESHOLD_PX,
} from '@/lib/processes/use-proximity-auto-bind';

function makeNode(
    id: string,
    x: number,
    y: number,
    overrides: Partial<Node> = {},
): Node {
    return {
        id,
        type: 'processStep',
        position: { x, y },
        data: { label: id, kind: 'processStep' },
        width: 160,
        height: 60,
        ...overrides,
    } as Node;
}

describe('findProximityCandidate', () => {
    it('returns null when no node is within range', () => {
        const dragged = makeNode('A', 0, 0);
        const other = makeNode(
            'B',
            DEFAULT_PROXIMITY_THRESHOLD_PX * 4,
            0,
        );
        expect(
            findProximityCandidate(dragged, [dragged, other], []),
        ).toBeNull();
    });

    it('returns the closest node when one is in range', () => {
        const dragged = makeNode('A', 0, 0);
        const near = makeNode('B', 100, 0); // centre-to-centre ≈ 100, threshold default 80 → NOT in range
        const closer = makeNode('C', 60, 0);
        const result = findProximityCandidate(
            dragged,
            [dragged, near, closer],
            [],
        );
        expect(result).not.toBeNull();
        expect(result!.target).toBe('C');
    });

    it('skips pairs that already have an edge between them (forward direction)', () => {
        const a = makeNode('A', 0, 0);
        const b = makeNode('B', 60, 0);
        const edges: Edge[] = [
            { id: 'e1', source: 'A', target: 'B' },
        ];
        expect(findProximityCandidate(a, [a, b], edges)).toBeNull();
    });

    it('skips pairs that already have an edge between them (reverse direction)', () => {
        const a = makeNode('A', 0, 0);
        const b = makeNode('B', 60, 0);
        const edges: Edge[] = [
            { id: 'e1', source: 'B', target: 'A' },
        ];
        expect(findProximityCandidate(a, [a, b], edges)).toBeNull();
    });

    it('returns null when the dragged node is an annotation (no handles)', () => {
        const dragged = makeNode('A', 0, 0, {
            type: 'annotation',
            data: { label: 'note', kind: 'annotation' },
        });
        const other = makeNode('B', 60, 0);
        expect(
            findProximityCandidate(dragged, [dragged, other], []),
        ).toBeNull();
    });

    it('skips candidate annotation nodes (no handles)', () => {
        const dragged = makeNode('A', 0, 0);
        const annotation = makeNode('N', 60, 0, {
            type: 'annotation',
            data: { label: 'note', kind: 'annotation' },
        });
        const real = makeNode('B', 70, 0);
        const result = findProximityCandidate(
            dragged,
            [dragged, annotation, real],
            [],
        );
        expect(result).not.toBeNull();
        expect(result!.target).toBe('B');
    });

    it('infers direction: dragged-LEFT-of-target → dragged is source', () => {
        const dragged = makeNode('A', 0, 0);
        const right = makeNode('B', 70, 0);
        const result = findProximityCandidate(
            dragged,
            [dragged, right],
            [],
        );
        expect(result).toEqual(
            expect.objectContaining({ source: 'A', target: 'B' }),
        );
    });

    it('infers direction: dragged-RIGHT-of-target → dragged is target', () => {
        const dragged = makeNode('A', 100, 0);
        const left = makeNode('B', 50, 0);
        const result = findProximityCandidate(
            dragged,
            [dragged, left],
            [],
        );
        expect(result).toEqual(
            expect.objectContaining({ source: 'B', target: 'A' }),
        );
    });

    it('respects a custom threshold', () => {
        const dragged = makeNode('A', 0, 0);
        const other = makeNode('B', 200, 0);
        // Default threshold (80) is too small to bind these.
        expect(
            findProximityCandidate(dragged, [dragged, other], []),
        ).toBeNull();
        // A custom 300px threshold catches it.
        const wide = findProximityCandidate(
            dragged,
            [dragged, other],
            [],
            300,
        );
        expect(wide).not.toBeNull();
        expect(wide!.target).toBe('B');
    });

    it('falls back gracefully when the kind is unknown (treat as has-handles)', () => {
        const dragged = makeNode('A', 0, 0, {
            data: { label: 'A', kind: 'unknown-kind' },
        });
        const other = makeNode('B', 60, 0);
        const result = findProximityCandidate(
            dragged,
            [dragged, other],
            [],
        );
        expect(result).not.toBeNull();
        expect(result!.target).toBe('B');
    });

    it('returns the candidate distance for the caller to inspect', () => {
        const dragged = makeNode('A', 0, 0);
        const other = makeNode('B', 60, 0);
        const result = findProximityCandidate(
            dragged,
            [dragged, other],
            [],
        );
        expect(result).not.toBeNull();
        // Centre-to-centre distance is just the X delta since both
        // centres sit on the same Y axis. Both nodes are 160 wide,
        // so centres are at (80, 30) and (140, 30) → 60px apart.
        expect(result!.distance).toBeCloseTo(60, 0);
    });
});

// ─── Node-size resolution ──────────────────────────────────────────
//
// `nodeCentre` resolves a node's half-extent from three sources, in
// order: xyflow's `measured` box, the node's own `width`/`height`,
// then the 160×60 chassis default. Every assertion below reads the
// candidate's `distance`, which is the ONLY externally visible
// consequence of picking the wrong source — a threshold test alone
// would pass for several wrong centres.

/**
 * xyflow stamps `measured` onto the node object at runtime; the
 * published `Node` type does not declare it, and `width`/`height` are
 * typed `number | undefined` so a null cannot be written literally.
 * Both shapes are produced through this ONE named cast.
 */
function nodeWithSize(
    id: string,
    x: number,
    y: number,
    size: {
        width?: number | null;
        height?: number | null;
        measured?: { width?: number; height?: number };
    },
): Node {
    return {
        id,
        type: 'processStep',
        position: { x, y },
        data: { label: id, kind: 'processStep' },
        ...size,
    } as unknown as Node;
}

describe('findProximityCandidate — node-size resolution', () => {
    it('falls back to a 160-wide chassis when width is absent', () => {
        // Sizeless A → centre (80, 30). Sized B at x=100 → centre
        // (180, 30). Exactly 100px apart ONLY if the 160 default was
        // applied; a 0-width fallback would read 182.5.
        const dragged = nodeWithSize('A', 0, 0, {});
        const other = makeNode('B', 100, 0);
        const result = findProximityCandidate(
            dragged,
            [dragged, other],
            [],
            300,
        );
        expect(result).not.toBeNull();
        expect(result!.distance).toBeCloseTo(100, 6);
    });

    it('falls back to a 60-tall chassis when height is absent', () => {
        // Same trick on the Y axis: sizeless A → centre (80, 30),
        // sized B at y=100 → centre (80, 130). A 0-height fallback
        // would read 130 instead of 100.
        const dragged = nodeWithSize('A', 0, 0, {});
        const other = makeNode('B', 0, 100);
        const result = findProximityCandidate(
            dragged,
            [dragged, other],
            [],
            300,
        );
        expect(result).not.toBeNull();
        expect(result!.distance).toBeCloseTo(100, 6);
    });

    it('treats an explicit null width/height as absent, not as zero', () => {
        // A serialised node round-tripped through JSON can carry nulls.
        // The guard is `!== undefined && !== null`; dropping the null
        // half would give a 0-extent centre at the origin (182.5px).
        const dragged = nodeWithSize('A', 0, 0, { width: null, height: null });
        const other = makeNode('B', 100, 0);
        const result = findProximityCandidate(
            dragged,
            [dragged, other],
            [],
            300,
        );
        expect(result).not.toBeNull();
        expect(result!.distance).toBeCloseTo(100, 6);
    });

    it("prefers xyflow's measured box over the node's declared width", () => {
        // Declared 160×60 but MEASURED 400×200 → centre (200, 100).
        // B is sized 160×60 at (400, 100) → centre (480, 130).
        // Measured wins ⇒ 280.16; declared would give 320.0014.
        const dragged = nodeWithSize('A', 0, 0, {
            width: 160,
            height: 60,
            measured: { width: 400, height: 200 },
        });
        const other = makeNode('B', 400, 100);
        const result = findProximityCandidate(
            dragged,
            [dragged, other],
            [],
            600,
        );
        expect(result).not.toBeNull();
        expect(result!.distance).toBeCloseTo(
            Math.hypot(480 - 200, 130 - 100),
            6,
        );
    });

    it('resolves each axis independently when `measured` is half-filled', () => {
        // measured.width present, measured.height absent → width comes
        // from `measured`, height falls through to the declared 60.
        // Centre = (0 + 400/2, 0 + 60/2) = (200, 30).
        const dragged = nodeWithSize('A', 0, 0, {
            width: 160,
            height: 60,
            measured: { width: 400 },
        });
        const other = makeNode('B', 400, 0);
        const result = findProximityCandidate(
            dragged,
            [dragged, other],
            [],
            600,
        );
        expect(result).not.toBeNull();
        // B centre = (480, 30); same Y ⇒ distance is the pure X delta.
        expect(result!.distance).toBeCloseTo(280, 6);
    });
});

describe('findProximityCandidate — scan edge cases', () => {
    it('returns null for an empty node list', () => {
        const dragged = makeNode('A', 0, 0);
        expect(findProximityCandidate(dragged, [], [])).toBeNull();
    });

    it('excludes the dragged node by ID, not by object identity', () => {
        // xyflow hands `onNodeDrag` a FRESH node object every tick,
        // while the `nodes` array the hook closes over holds a
        // different object with the same id. A self-check written as
        // `other === draggedNode` would therefore bind a node to
        // ITSELF in production — at distance 0, so it wins every scan
        // — and would still pass every other test in this file,
        // because they all pass the same reference twice.
        const inNodesCopy = makeNode('A', 0, 0);
        const draggedCopy = makeNode('A', 0, 0);
        const neighbour = makeNode('B', 60, 0);
        expect(
            findProximityCandidate(draggedCopy, [inNodesCopy], []),
        ).toBeNull();
        // With a real neighbour in range the neighbour must win, not
        // the dragged node's own stale copy at distance 0.
        expect(
            findProximityCandidate(draggedCopy, [inNodesCopy, neighbour], [])
                ?.target,
        ).toBe('B');
    });

    it('binds at exactly the threshold distance but not one pixel beyond', () => {
        // The guard is `d > threshold` — inclusive at the boundary.
        const dragged = makeNode('A', 0, 0);
        const atLimit = makeNode('B', DEFAULT_PROXIMITY_THRESHOLD_PX, 0);
        expect(
            findProximityCandidate(dragged, [dragged, atLimit], []),
        ).not.toBeNull();

        const justOver = makeNode('C', DEFAULT_PROXIMITY_THRESHOLD_PX + 1, 0);
        expect(
            findProximityCandidate(dragged, [dragged, justOver], []),
        ).toBeNull();
    });

    it('keeps the first of two equidistant candidates rather than the last', () => {
        // The guard is `d < best.dist` (strict), so a tie does NOT
        // replace the incumbent. Loosening it to `<=` would make the
        // preview edge flip between two neighbours on every drag tick.
        const dragged = makeNode('A', 100, 0);
        const left = makeNode('L', 50, 0);
        const right = makeNode('R', 150, 0);
        const result = findProximityCandidate(
            dragged,
            [dragged, left, right],
            [],
        );
        expect(result).not.toBeNull();
        // L wins the tie; A is right of L, so A becomes the TARGET.
        expect(result).toEqual(
            expect.objectContaining({ source: 'L', target: 'A' }),
        );
    });

    it('treats perfectly-coincident centres as dragged-is-source', () => {
        // `draggedCentre.x <= targetCentre.x` — the `===` half of the
        // comparison. Two stacked nodes must still yield a stable
        // direction rather than depending on scan order.
        const dragged = makeNode('A', 0, 0);
        const stacked = makeNode('B', 0, 0);
        const result = findProximityCandidate(
            dragged,
            [dragged, stacked],
            [],
        );
        expect(result).toStrictEqual({
            source: 'A',
            target: 'B',
            distance: 0,
        });
    });

    it('falls back to the next-closest node when the closest is already linked', () => {
        // Exercises `continue` on the edge check WITHOUT the scan
        // returning null — the linked neighbour must be skipped over,
        // not abort the search.
        const dragged = makeNode('A', 0, 0);
        const linked = makeNode('B', 40, 0);
        const free = makeNode('C', 70, 0);
        const edges: Edge[] = [{ id: 'e1', source: 'A', target: 'B' }];
        const result = findProximityCandidate(
            dragged,
            [dragged, linked, free],
            edges,
        );
        expect(result).not.toBeNull();
        expect(result!.target).toBe('C');
    });

    it('treats a node with no `data` at all as having handles', () => {
        // `data?.kind` on an undefined data object — the forward-compat
        // arm. A palette node mid-creation can hit this.
        const dragged = nodeWithSize('A', 0, 0, { width: 160, height: 60 });
        const bare = {
            id: 'B',
            type: 'processStep',
            position: { x: 60, y: 0 },
            width: 160,
            height: 60,
        } as unknown as Node;
        const result = findProximityCandidate(dragged, [dragged, bare], []);
        expect(result).not.toBeNull();
        expect(result!.target).toBe('B');
    });
});
