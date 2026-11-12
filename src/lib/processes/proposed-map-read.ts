/**
 * The server READ of a stored process-map proposal (#5053): the one function
 * pair the review diff and approval share.
 *
 *   • `previewStoredProcessMap` — the review diff's preview, including the
 *     per-step boxes the read-only mini canvas is drawn with;
 *   • `prepareProcessMapApproval` — approval's re-validation, which returns
 *     the PUT-ready graph at the SAME boxes.
 *
 * Both call `readProposedProcessMap` then `layoutProposedProcessMap`, so a map
 * the review surfaces cannot render can never be approved, and the map is
 * created where the reviewer saw it.
 *
 * Pure apart from the layout: no database, no audit, no permission check
 * (those are in `app-layer/usecases/process-map-proposal.ts`), so the review
 * diff reads it without the approval's dependencies. SERVER-ONLY: it reaches
 * the layout engine.
 */
import { badRequest } from '@/lib/errors/types';
import {
    buildProcessMapPreview,
    proposedEdgeKey,
    readProposedProcessMap,
    type CanonicalProposedProcessMap,
    type ProcessMapPreview,
    type ProposedProcessMapUnreadable,
} from '@/lib/agentic/process-map-proposal';
import { layoutProposedProcessMap } from '@/lib/processes/proposed-map-layout';
import { buildTemplateGraph, type TemplateGraph } from '@/lib/processes/template-graph';

/** `details.reason` of the approve-with-edits refusal. */
export const PROCESS_MAP_PROPOSAL_NOT_EDITABLE = 'PROCESS_MAP_PROPOSAL_NOT_EDITABLE';
/** `details.reason` of the refusal of a stored map that no longer reads. */
export const PROCESS_MAP_PROPOSAL_UNREADABLE = 'PROCESS_MAP_PROPOSAL_UNREADABLE';

/** A stored map, read and laid out: what both the review and approval use. */
interface ReadStoredMap {
    map: CanonicalProposedProcessMap;
    boxes: ReturnType<typeof layoutProposedProcessMap>;
}

function readStoredMap(
    payloadJson: string,
): { ok: true; read: ReadStoredMap } | { ok: false; reason: ProposedProcessMapUnreadable } {
    let payload: unknown;
    try {
        payload = JSON.parse(payloadJson);
    } catch {
        return { ok: false, reason: 'NOT_AN_OBJECT' };
    }
    const result = readProposedProcessMap(payload);
    if (!result.ok) return result;
    return {
        ok: true,
        read: { map: result.map, boxes: layoutProposedProcessMap(result.map.nodes, result.map.edges) },
    };
}

/**
 * The review preview of a stored process-map payload, with the server-computed
 * boxes, or the reason it cannot be rendered. The review diff marks the latter
 * `PAYLOAD_UNREADABLE`, which withdraws Approve.
 */
export function previewStoredProcessMap(
    payloadJson: string,
): { ok: true; preview: ProcessMapPreview } | { ok: false; reason: ProposedProcessMapUnreadable } {
    const stored = readStoredMap(payloadJson);
    if (!stored.ok) return stored;
    return { ok: true, preview: buildProcessMapPreview(stored.read.map, stored.read.boxes) };
}

/** What approval creates: the map's metadata and its PUT-ready graph. */
export interface PreparedProcessMap {
    name: string;
    description: string | null;
    graph: TemplateGraph;
}

/**
 * Re-validate a stored process map for approval. Pure: no read, no audit.
 *
 * Refuses an approval that carries edits (`PROCESS_MAP_PROPOSAL_NOT_EDITABLE`:
 * a shallow merge could swap the steps without the arrows, so the reviewed
 * graph would not be the created one; reject and propose again), and a
 * payload that no longer reads as a map (`PROCESS_MAP_PROPOSAL_UNREADABLE`).
 * Both are 400s, raised before the signature and the claim.
 */
export function prepareProcessMapApproval(input: {
    payloadJson: string;
    hasEdits: boolean;
}): PreparedProcessMap {
    if (input.hasEdits) {
        throw badRequest(
            'A process-map proposal is approved exactly as proposed. Reject it and propose the corrected map instead.',
            { reason: PROCESS_MAP_PROPOSAL_NOT_EDITABLE },
        );
    }
    const stored = readStoredMap(input.payloadJson);
    if (!stored.ok) {
        throw badRequest('This process-map proposal can no longer be read as a map. Reject it.', {
            reason: PROCESS_MAP_PROPOSAL_UNREADABLE,
            unreadable: stored.reason,
        });
    }
    const { map, boxes } = stored.read;
    const graph = buildTemplateGraph({
        nodes: map.nodes.map((n) => ({
            nodeKey: n.nodeKey,
            nodeType: n.nodeType,
            label: n.label,
            ...(n.subtitle !== undefined ? { subtitle: n.subtitle } : {}),
            posX: boxes[n.nodeKey].x,
            posY: boxes[n.nodeKey].y,
        })),
        edges: map.edges.map((e, i) => ({
            edgeKey: proposedEdgeKey(i),
            sourceKey: e.sourceKey,
            targetKey: e.targetKey,
            ...(e.labelOverride !== undefined ? { labelOverride: e.labelOverride } : {}),
        })),
    });
    return { name: map.name, description: map.description ?? null, graph };
}
