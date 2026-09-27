/**
 * SPIKE ONLY — #2960 §2.5. "Respect the caps in the editor — nodes 500, edges
 * 1000. Surface the ceiling as you APPROACH it; a server rejection after ten
 * minutes of work is the worst place to learn."
 *
 * ═══ THE NUMBERS ARE DUPLICATED, AND THAT IS THE PROBLEM TO SOLVE ═══
 *
 * The authoritative caps live inline in `SaveProcessMapSchema` as
 * `.max(500)` / `.max(1000)`. They are not exported, so an editor-side check
 * cannot import them, and a hand-copied constant drifts the day somebody
 * raises one — silently, and in the permissive direction: the editor would
 * stop warning before a limit that still rejects.
 *
 * Two honest options. The right one is to EXPORT the constants from the schema
 * and have both read one value; that is a production change and belongs in the
 * real phase, not a spike. Until then these are duplicated deliberately and
 * `capacity.test.ts` asserts they match what the schema ACTUALLY enforces, by
 * feeding it an oversized graph. A duplicate with a test that it is still a
 * duplicate is honest; a duplicate on its own is a trap.
 */

/** Mirrors `SaveProcessMapSchema.nodes.max(...)`. Pinned by test. */
export const NODE_CAP = 500;
/** Mirrors `SaveProcessMapSchema.edges.max(...)`. Pinned by test. */
export const EDGE_CAP = 1000;

/**
 * How close to the ceiling a warning should appear.
 *
 * 90% rather than "the last N": a proportion scales if a cap moves, and the
 * point is to give a user room to finish a thought, not to count down. At 500
 * nodes that is a warning from 450 — fifty nodes of warning, which on a graph
 * being authored by hand is minutes, not seconds.
 */
const WARN_AT = 0.9;

export type CapacityState = 'ok' | 'approaching' | 'full' | 'over';

export interface Capacity {
    readonly count: number;
    readonly cap: number;
    readonly remaining: number;
    readonly state: CapacityState;
}

function assess(count: number, cap: number): Capacity {
    // `over` is reachable in the editor even though the server refuses it: a
    // user can paste, import, or undo into a state the save will reject, and
    // the editor's job is to say so BEFORE they spend ten more minutes.
    const state: CapacityState =
        count > cap ? 'over' : count === cap ? 'full' : count >= cap * WARN_AT ? 'approaching' : 'ok';
    return { count, cap, remaining: Math.max(0, cap - count), state };
}

export interface GraphCapacity {
    readonly nodes: Capacity;
    readonly edges: Capacity;
    /** The worse of the two — what a single indicator should show. */
    readonly state: CapacityState;
    /** True when a save would be REFUSED server-side as things stand. */
    readonly wouldBeRefused: boolean;
}

const RANK: Record<CapacityState, number> = { ok: 0, approaching: 1, full: 2, over: 3 };

export function graphCapacity(nodeCount: number, edgeCount: number): GraphCapacity {
    const nodes = assess(nodeCount, NODE_CAP);
    const edges = assess(edgeCount, EDGE_CAP);
    // The WORSE of the two, never the node count alone. A map can sit at 40% of
    // the node cap and be over the edge cap — reporting "ok" there would be a
    // green light on a graph that cannot be saved.
    const state = RANK[nodes.state] >= RANK[edges.state] ? nodes.state : edges.state;
    return { nodes, edges, state, wouldBeRefused: nodes.state === 'over' || edges.state === 'over' };
}
