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

export type EdgeEndpointRefusal =
    | { code: 'UNKNOWN_NODE_KEY'; nodeKey: string }
    | { code: 'NODE_IS_ANNOTATION'; nodeKey: string; nodeType: string }
    | { code: 'NODE_IS_GROUP'; nodeKey: string; nodeType: string };

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
 * Both ends at once — the question the editor actually asks.
 *
 * Returns every refusal rather than the first, so a user dragging an edge from
 * an annotation to a group is told about both ends instead of discovering the
 * second only after fixing the first.
 */
export function validateEdge(
    sourceKey: string,
    targetKey: string,
    nodes: readonly KnownNode[],
): EdgeEndpointRefusal[] {
    const out: EdgeEndpointRefusal[] = [];
    const from = validateEdgeEndpoint(sourceKey, nodes);
    if (from) out.push(from);
    // Evaluated even when `sourceKey` failed, and even when the two keys are
    // equal: a self-edge on an annotation is two refusals about one node, and
    // reporting one of them would have the user fix it and be refused again.
    const to = validateEdgeEndpoint(targetKey, nodes);
    if (to) out.push(to);
    return out;
}

/** Human-facing text for a refusal. Separate so callers can substitute one. */
export function describeRefusal(r: EdgeEndpointRefusal): string {
    switch (r.code) {
        case 'UNKNOWN_NODE_KEY':
            return `No node “${r.nodeKey}” on this map.`;
        case 'NODE_IS_ANNOTATION':
            return 'An annotation is a note about the process, not part of it — connect the step it annotates instead.';
        case 'NODE_IS_GROUP':
            return 'A group is a container, not a step — connect a node inside it instead.';
    }
}
