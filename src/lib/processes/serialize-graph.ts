/**
 * THE projection of a live xyflow canvas graph into the SaveProcessMap PUT body.
 *
 * ── Why this module exists ──────────────────────────────────────────
 *
 * There were three hand-written copies of this projection inside
 * `PersistedProcessCanvas` — one per writer (save / rename / duplicate) — and
 * they had drifted:
 *
 *   - rename omitted `parentNodeKey` entirely, so blurring a renamed map PUT
 *     every node re-parented to root and **dissolved every group** server-side;
 *   - rename and duplicate hardcoded the label fallback `"Untitled step"`
 *     instead of `NODE_TAXONOMY[kind].defaultLabel`, so an unlabelled decision
 *     or terminator node silently became a "step" on save.
 *
 * Both are one class of bug: a second copy of a projection that has to agree
 * with the first. One exported function means a field added here reaches every
 * writer, and it is testable without mounting the canvas.
 *
 * `tests/guards/process-canvas-single-serializer.test.ts` fails if a fourth
 * copy appears in the component.
 */
import type { Node, Edge } from "@xyflow/react";
import {
    NODE_TAXONOMY,
    isProcessNodeKind,
    type ProcessNodeKind,
} from "@/components/processes/node-taxonomy";
import {
    PROCESS_STEP_NODE_TYPE,
    isProcessNodeSize,
} from "@/components/processes/ProcessTypedNode";
import { isProcessEdgeVariant } from "@/components/processes/ProcessEdge";
import { edgeControlsForSave } from "@/lib/processes/edge-controls";

export function nodeDataJson(n: Node): {
    size?: string;
    width?: number;
    height?: number;
    linkedEntityId?: string;
} | null {
    const size = (n.data as { size?: unknown } | undefined)?.size;
    // R30 — group nodes persist their explicit width / height
    // alongside the rest of `dataJson`. Reading from `data` and
    // `style` covers both freshly-created groups (whose width/
    // height start in `style`) and round-tripped groups (whose
    // width/height landed in `data` on rehydration).
    const styleW = (n.style as { width?: unknown } | undefined)?.width;
    const styleH = (n.style as { height?: unknown } | undefined)?.height;
    const dataW = (n.data as { width?: unknown } | undefined)?.width;
    const dataH = (n.data as { height?: unknown } | undefined)?.height;
    const width =
        typeof styleW === "number"
            ? styleW
            : typeof dataW === "number"
              ? dataW
              : null;
    const height =
        typeof styleH === "number"
            ? styleH
            : typeof dataH === "number"
              ? dataH
              : null;
    // Epic P2-PR-B — entity FK on risk / asset / control nodes.
    const linkedEntityId = (n.data as { linkedEntityId?: unknown } | undefined)
        ?.linkedEntityId;
    const out: {
        size?: string;
        width?: number;
        height?: number;
        linkedEntityId?: string;
    } = {};
    if (isProcessNodeSize(size)) out.size = size;
    if (width != null) out.width = width;
    if (height != null) out.height = height;
    if (typeof linkedEntityId === "string" && linkedEntityId.length > 0) {
        out.linkedEntityId = linkedEntityId;
    }
    return Object.keys(out).length === 0 ? null : out;
}

export function nodeParent(n: Node): string | null {
    const p = (n as { parentId?: unknown }).parentId;
    return typeof p === "string" && p.length > 0 ? p : null;
}

export function edgeKindOf(e: Edge): string {
    const v = (e.data as { variant?: unknown } | undefined)?.variant;
    return isProcessEdgeVariant(v) ? v : "flow";
}

/**
 * THE serialisation of the live xyflow graph into the SaveProcessMap PUT body.
 *
 * ── Why this is one function ────────────────────────────────────────
 *
 * There were three hand-written copies of this projection — one per writer
 * (save / rename / duplicate) — and they had drifted:
 *
 *   - rename omitted `parentNodeKey` entirely, so blurring a renamed map PUT
 *     every node re-parented to root and **dissolved every group** server-side;
 *   - rename and duplicate hardcoded the label fallback `"Untitled step"`
 *     instead of `NODE_TAXONOMY[kind].defaultLabel`, so an unlabelled decision
 *     or terminator node silently became a "step" on save.
 *
 * Both are the same class of bug: a second copy of a projection that has to
 * agree with the first. One function means a field added here reaches every
 * writer, and `tests/guards/process-canvas-single-serializer.test.ts` fails if
 * a fourth copy appears.
 */
export function serializeGraphForSave(nodes: Node[], edges: Edge[]) {
    return {
        nodes: nodes.map((n, idx) => {
            const kind: ProcessNodeKind = isProcessNodeKind(n.type)
                ? n.type
                : PROCESS_STEP_NODE_TYPE;
            const meta = NODE_TAXONOMY[kind];
            return {
                nodeKey: n.id || `node-${idx + 1}`,
                nodeType: kind,
                label:
                    n.data && typeof (n.data as { label?: unknown }).label === "string"
                        ? (n.data as { label: string }).label
                        : meta.defaultLabel,
                subtitle:
                    n.data &&
                    typeof (n.data as { subtitle?: unknown }).subtitle === "string"
                        ? (n.data as { subtitle: string }).subtitle
                        : null,
                posX: n.position.x,
                posY: n.position.y,
                // Load-bearing: omitting this re-parents every node to root,
                // which is what destroyed group containment on rename.
                parentNodeKey: nodeParent(n),
                dataJson: nodeDataJson(n),
            };
        }),
        edges: edges.map((e, idx) => ({
            edgeKey: e.id || `edge-${idx + 1}`,
            sourceKey: e.source,
            targetKey: e.target,
            edgeKind: edgeKindOf(e),
            labelOverride: typeof e.label === "string" ? e.label : null,
            controls: edgeControlsForSave(e),
        })),
    };
}

