/**
 * #5477 — one sub-flow group, as `GET /processes/subflow-groups` returns it and
 * the rule builder's `INVOKE_SUBFLOW` target picker lists it.
 *
 * A leaf with no imports, so the client components and the repository share
 * the shape without a client module reaching into the app layer.
 */
export interface SubflowGroupItem {
    mapId: string;
    mapName: string;
    /** The group node's key: what an `INVOKE_SUBFLOW` rule stores as `targetGroupId`. */
    nodeKey: string;
    label: string;
}
