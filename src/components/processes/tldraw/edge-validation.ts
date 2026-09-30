/**
 * Whether an edge may end at a given node — decided at DRAW time.
 *
 * ═══ THE RULE ALREADY EXISTS SERVER-SIDE ═══
 *
 * `ProcessMapRepository.replaceGraph` refuses an edge naming a `nodeKey` the
 * map does not contain. #2960 asks for the same refusal client-side, and gives
 * the reason: *"The user should find out at draw time, not at save time."*
 *
 * This is a duplicate check by design, and the duplication is the point. The
 * server's copy is the one that protects the data; this one protects the
 * twenty minutes of work between drawing an edge and pressing save.
 *
 * ═══ THREE REFUSALS, NOT ONE ═══
 *
 * The obvious reading is that an edge is invalid when its endpoint does not
 * exist. Two more cases exist, and they are not the same thing:
 *
 *   UNKNOWN_NODE_KEY   the map contains no node with that key
 *   NODE_IS_ANNOTATION the node exists and floats free of the flow
 *   NODE_IS_GROUP      the node exists and is a CONTAINER, not a step
 *
 * `hasHandles` is false for exactly `annotation` and `group` — two kinds, not
 * one, which was measured wrong once and corrected on #2960.
 *
 * They are kept as SEPARATE CODES rather than one "cannot take edges" because
 * the next action a user takes differs in each case:
 *
 *   - an annotation is a note ABOUT the process, so the edge belongs on the
 *     step being annotated;
 *   - a group's members are flow participants that reference it through
 *     `parentNodeKey`, so the edge belongs on a node INSIDE it.
 *
 * Collapsing them would produce one message that is unhelpful in both cases.
 * A caller is free to render them identically; it must not be forced to.
 */
import { nodeTypeHasHandles, metaForNodeType } from './ProcessNodeShapeUtil';

/**
 * A refusal about ONE END of an edge.
 *
 * Kept as its own type because `validateEdgeEndpoint` answers a question about
 * a single node, and widening it to cover pair-level refusals would let a
 * caller ask "is this endpoint valid?" and get back "the two ends are the same".
 */
export type EdgeEndpointRefusal =
    | { code: 'UNKNOWN_NODE_KEY'; nodeKey: string }
    | { code: 'NODE_IS_ANNOTATION'; nodeKey: string; nodeType: string }
    | { code: 'NODE_IS_GROUP'; nodeKey: string; nodeType: string };

/**
 * A refusal about the EDGE — either end, or the pair, or the pair against the
 * rest of the graph.
 *
 * `SELF_LOOP` and `DUPLICATE_EDGE` come from the live xyflow canvas's
 * `isValidConnection`, which refuses three things: self, duplicate, annotation.
 * The first version of this module had the other three (unknown key,
 * annotation, group) and would therefore have ACCEPTED self-loops and
 * duplicates that the current canvas rejects — a behaviour regression that
 * #2962's row-diff would only have caught if whoever ran the dual-run happened
 * to draw one.
 */
export type EdgeRefusal =
    | EdgeEndpointRefusal
    | { code: 'SELF_LOOP'; nodeKey: string }
    | { code: 'DUPLICATE_EDGE'; sourceKey: string; targetKey: string };

/** An edge already on the map, for the duplicate check. */
export type KnownEdge = { sourceKey: string; targetKey: string };

/** The minimum a caller must know about a node to validate an edge to it. */
export type KnownNode = { nodeKey: string; nodeType: string };

/**
 * `null` when the endpoint is acceptable, otherwise the reason it is not.
 *
 * Returning the refusal rather than throwing, deliberately: this runs while the
 * user is dragging, and the common case is "not yet valid" rather than "an
 * error occurred". An exception per mouse-move would be the wrong shape for a
 * question asked continuously.
 */
export function validateEdgeEndpoint(
    nodeKey: string,
    nodes: readonly KnownNode[],
): EdgeEndpointRefusal | null {
    const node = nodes.find((n) => n.nodeKey === nodeKey);
    if (!node) return { code: 'UNKNOWN_NODE_KEY', nodeKey };

    if (nodeTypeHasHandles(node.nodeType)) return null;

    // Handle-less, so WHICH kind decides the message. Resolved through the
    // taxonomy rather than compared to a literal, so an unrecognised kind
    // cannot fall through into the wrong branch.
    const meta = metaForNodeType(node.nodeType);
    return meta.id === 'group'
        ? { code: 'NODE_IS_GROUP', nodeKey, nodeType: node.nodeType }
        : { code: 'NODE_IS_ANNOTATION', nodeKey, nodeType: node.nodeType };
}

/**
 * The whole edge — both ends, the pair, and the pair against the graph.
 *
 * `edges` is REQUIRED, not optional. An optional parameter would mean a caller
 * who forgets it silently loses duplicate detection — which is precisely the
 * failure the check exists to prevent, arriving as a permissive default that
 * nothing reports.
 *
 * Returns EVERY applicable refusal rather than the first, so a user dragging
 * from an annotation to a group is told about both ends instead of discovering
 * the second only after fixing the first. The live canvas showed one message at
 * a time; a caller wanting that behaviour can show `refusals[0]`, and a caller
 * wanting all of them now can.
 */
export function validateEdge(
    sourceKey: string,
    targetKey: string,
    nodes: readonly KnownNode[],
    edges: readonly KnownEdge[],
): EdgeRefusal[] {
    const out: EdgeRefusal[] = [];

    if (sourceKey === targetKey) {
        // ONE endpoint refusal, not two. The #2998 version evaluated both ends
        // even when they were the same key, on the reasoning that "reporting one
        // would have the user fix it and be refused again". That reasoning is
        // right for two DIFFERENT bad ends and wrong here: both ends are the
        // same node, so fixing it fixes both, and saying so twice is noise.
        const both = validateEdgeEndpoint(sourceKey, nodes);
        if (both) out.push(both);
        out.push({ code: 'SELF_LOOP', nodeKey: sourceKey });
    } else {
        const from = validateEdgeEndpoint(sourceKey, nodes);
        if (from) out.push(from);
        const to = validateEdgeEndpoint(targetKey, nodes);
        if (to) out.push(to);
    }

    // DIRECTED. `a -> b` and `b -> a` are different edges and both are legal —
    // a process can loop back through a rejection path. Comparing unordered
    // pairs would refuse the second one, which the live canvas permits.
    if (edges.some((e) => e.sourceKey === sourceKey && e.targetKey === targetKey)) {
        out.push({ code: 'DUPLICATE_EDGE', sourceKey, targetKey });
    }

    return out;
}

/** Human-facing text for a refusal. Separate so callers can substitute one. */
export function describeRefusal(r: EdgeRefusal): string {
    switch (r.code) {
        case 'UNKNOWN_NODE_KEY':
            return `No node “${r.nodeKey}” on this map.`;
        case 'NODE_IS_ANNOTATION':
            return 'An annotation is a note about the process, not part of it — connect the step it annotates instead.';
        case 'NODE_IS_GROUP':
            return 'A group is a container, not a step — connect a node inside it instead.';
        case 'SELF_LOOP':
            return 'A step cannot connect to itself.';
        case 'DUPLICATE_EDGE':
            return 'These two steps are already connected in that direction.';
    }
}
