/**
 * The PUT-ready process-map graph: `{ nodes, edges }` in exactly the shape the
 * save endpoint (`SaveProcessMapSchema`) and `ProcessMapRepository.replaceGraph`
 * accept, built from a minimal description of DOCUMENT steps and flow arrows.
 *
 * Moved here from `components/processes/process-map-templates.ts` (#5053) so a
 * server usecase can build the same shape without a runtime import from
 * `@/components`: the starter templates clone through it, and so does an
 * approved process-map proposal. That file re-exports these names.
 *
 * Nodes are DOCUMENT kinds only (`processStep` / `decision`), with no parent and
 * `dataJson: null` (label and subtitle persist as columns). Edges are plain
 * `flow` edges with no edge-mounted controls, which need real Control rows.
 *
 * NO IMPORTS, so a client module and a server usecase both read it.
 */

export interface TemplateNode {
    nodeKey: string;
    nodeType: 'processStep' | 'decision';
    label: string;
    subtitle?: string;
    posX: number;
    posY: number;
}

export interface TemplateEdge {
    edgeKey: string;
    sourceKey: string;
    targetKey: string;
    labelOverride?: string;
}

/** The PUT-ready graph `buildTemplateGraph` returns. */
export interface TemplateGraph {
    nodes: Array<{
        nodeKey: string;
        nodeType: string;
        label: string;
        subtitle: string | null;
        posX: number;
        posY: number;
        parentNodeKey: null;
        dataJson: null;
    }>;
    edges: Array<{
        edgeKey: string;
        sourceKey: string;
        targetKey: string;
        edgeKind: 'flow';
        labelOverride: string | null;
        controls: [];
    }>;
}

/**
 * PUT-ready graph for a template, or anything carrying its nodes and edges.
 * Edges carry `edgeKind: 'flow'` + an empty `controls` array; nodes carry
 * `dataJson: null` and `parentNodeKey: null`.
 */
export function buildTemplateGraph(template: {
    nodes: readonly TemplateNode[];
    edges: readonly TemplateEdge[];
}): TemplateGraph {
    return {
        nodes: template.nodes.map((n) => ({
            nodeKey: n.nodeKey,
            nodeType: n.nodeType,
            label: n.label,
            subtitle: n.subtitle ?? null,
            posX: n.posX,
            posY: n.posY,
            parentNodeKey: null,
            dataJson: null,
        })),
        edges: template.edges.map((e) => ({
            edgeKey: e.edgeKey,
            sourceKey: e.sourceKey,
            targetKey: e.targetKey,
            edgeKind: 'flow',
            labelOverride: e.labelOverride ?? null,
            controls: [],
        })),
    };
}
