/**
 * Process-map starter templates (DOCUMENT canvas).
 *
 * A small set of common compliance process shapes a user can clone into a
 * fresh DOCUMENT map instead of starting from a blank canvas. This is the
 * process-map counterpart to the AUTOMATION-only `TemplateLibraryModal`
 * (which imports pre-built automation RULES) — the two are deliberately
 * separate: one seeds a rule, this one seeds a whole map's nodes + edges.
 *
 * Scope (documented decision): rather than a full server-side template
 * system with tenant-authored/shareable templates, this ships a handful of
 * BUILT-IN starter maps defined in code. Cloning a starter is a plain
 * "create map + save graph" round-trip (mirrors the canvas Duplicate flow),
 * so there is no new API surface, no new table, and no migration. A richer
 * template system (custom + shared templates, a gallery) remains a separate,
 * larger piece; these built-ins close the "authoring a map always starts from
 * scratch" gap today.
 *
 * Each node/edge is emitted in the exact shape the save endpoint
 * (`SaveProcessMapSchema`) accepts, so `buildTemplateGraph` output is PUT-ready.
 * Nodes use only DOCUMENT node kinds (`processStep` / `decision`); edges are
 * plain `flow` edges with no edge-mounted controls (those need real Control FK
 * rows, which a generic starter can't reference).
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

export interface ProcessMapTemplate {
    /** Stable id used for selection + the clone call. */
    id: string;
    /** i18n key suffix under `processes.templates.items.<id>` for name + summary. */
    nameKey: string;
    summaryKey: string;
    /** Default name for the cloned map (localised name is applied at clone time). */
    defaultName: string;
    nodes: TemplateNode[];
    edges: TemplateEdge[];
}

// Layout helpers — a simple left-to-right lane. Keeping positions explicit
// (not auto-laid-out) means the clone lands looking intentional without
// running dagre on create.
const COL = 260;
const ROW = 150;
const x = (col: number) => 80 + col * COL;
const y = (row: number) => 120 + row * ROW;

export const PROCESS_MAP_TEMPLATES: ProcessMapTemplate[] = [
    {
        id: 'access-review',
        nameKey: 'accessReview.name',
        summaryKey: 'accessReview.summary',
        defaultName: 'Access provisioning & review',
        nodes: [
            { nodeKey: 'n1', nodeType: 'processStep', label: 'Access request', subtitle: 'Joiner / role change', posX: x(0), posY: y(0) },
            { nodeKey: 'n2', nodeType: 'decision', label: 'Manager approval?', posX: x(1), posY: y(0) },
            { nodeKey: 'n3', nodeType: 'processStep', label: 'Provision access', subtitle: 'Least privilege', posX: x(2), posY: y(0) },
            { nodeKey: 'n4', nodeType: 'processStep', label: 'Periodic access review', subtitle: 'Quarterly recert', posX: x(3), posY: y(0) },
            { nodeKey: 'n5', nodeType: 'processStep', label: 'Revoke on leaver', subtitle: 'Deprovision', posX: x(4), posY: y(0) },
            { nodeKey: 'n6', nodeType: 'processStep', label: 'Reject & notify', posX: x(2), posY: y(1) },
        ],
        edges: [
            { edgeKey: 'e1', sourceKey: 'n1', targetKey: 'n2' },
            { edgeKey: 'e2', sourceKey: 'n2', targetKey: 'n3', labelOverride: 'Approved' },
            { edgeKey: 'e3', sourceKey: 'n2', targetKey: 'n6', labelOverride: 'Denied' },
            { edgeKey: 'e4', sourceKey: 'n3', targetKey: 'n4' },
            { edgeKey: 'e5', sourceKey: 'n4', targetKey: 'n5' },
        ],
    },
    {
        id: 'vendor-onboarding',
        nameKey: 'vendorOnboarding.name',
        summaryKey: 'vendorOnboarding.summary',
        defaultName: 'Vendor onboarding & due diligence',
        nodes: [
            { nodeKey: 'n1', nodeType: 'processStep', label: 'Vendor intake', subtitle: 'Business request', posX: x(0), posY: y(0) },
            { nodeKey: 'n2', nodeType: 'decision', label: 'Risk tier?', subtitle: 'Data / criticality', posX: x(1), posY: y(0) },
            { nodeKey: 'n3', nodeType: 'processStep', label: 'Security review', subtitle: 'Questionnaire + evidence', posX: x(2), posY: y(0) },
            { nodeKey: 'n4', nodeType: 'processStep', label: 'Contract & DPA', subtitle: 'Legal + privacy', posX: x(3), posY: y(0) },
            { nodeKey: 'n5', nodeType: 'decision', label: 'Approved?', posX: x(4), posY: y(0) },
            { nodeKey: 'n6', nodeType: 'processStep', label: 'Onboard & monitor', subtitle: 'Add to register', posX: x(5), posY: y(0) },
            { nodeKey: 'n7', nodeType: 'processStep', label: 'Lightweight intake', subtitle: 'Low-risk fast path', posX: x(2), posY: y(1) },
        ],
        edges: [
            { edgeKey: 'e1', sourceKey: 'n1', targetKey: 'n2' },
            { edgeKey: 'e2', sourceKey: 'n2', targetKey: 'n3', labelOverride: 'High / medium' },
            { edgeKey: 'e3', sourceKey: 'n2', targetKey: 'n7', labelOverride: 'Low' },
            { edgeKey: 'e4', sourceKey: 'n3', targetKey: 'n4' },
            { edgeKey: 'e5', sourceKey: 'n4', targetKey: 'n5' },
            { edgeKey: 'e6', sourceKey: 'n5', targetKey: 'n6', labelOverride: 'Yes' },
            { edgeKey: 'e7', sourceKey: 'n7', targetKey: 'n6' },
        ],
    },
    {
        id: 'incident-response',
        nameKey: 'incidentResponse.name',
        summaryKey: 'incidentResponse.summary',
        defaultName: 'Incident response',
        nodes: [
            { nodeKey: 'n1', nodeType: 'processStep', label: 'Detect & report', subtitle: 'Alert / user report', posX: x(0), posY: y(0) },
            { nodeKey: 'n2', nodeType: 'decision', label: 'Severity triage', posX: x(1), posY: y(0) },
            { nodeKey: 'n3', nodeType: 'processStep', label: 'Contain', subtitle: 'Limit blast radius', posX: x(2), posY: y(0) },
            { nodeKey: 'n4', nodeType: 'processStep', label: 'Investigate', subtitle: 'Root cause + scope', posX: x(3), posY: y(0) },
            { nodeKey: 'n5', nodeType: 'processStep', label: 'Remediate & recover', posX: x(4), posY: y(0) },
            { nodeKey: 'n6', nodeType: 'processStep', label: 'Post-incident review', subtitle: 'Lessons + actions', posX: x(5), posY: y(0) },
            { nodeKey: 'n7', nodeType: 'processStep', label: 'Regulatory notification', subtitle: 'NIS2 / GDPR timelines', posX: x(3), posY: y(1) },
        ],
        edges: [
            { edgeKey: 'e1', sourceKey: 'n1', targetKey: 'n2' },
            { edgeKey: 'e2', sourceKey: 'n2', targetKey: 'n3' },
            { edgeKey: 'e3', sourceKey: 'n3', targetKey: 'n4' },
            { edgeKey: 'e4', sourceKey: 'n4', targetKey: 'n5' },
            { edgeKey: 'e5', sourceKey: 'n5', targetKey: 'n6' },
            { edgeKey: 'e6', sourceKey: 'n2', targetKey: 'n7', labelOverride: 'Reportable' },
        ],
    },
];

export function getProcessMapTemplate(id: string): ProcessMapTemplate | undefined {
    return PROCESS_MAP_TEMPLATES.find((tpl) => tpl.id === id);
}

/**
 * PUT-ready graph for a template — the `{ nodes, edges }` shape the save
 * endpoint accepts. Edges carry `edgeKind: 'flow'` + an empty `controls`
 * array; nodes carry `dataJson: null` (label/subtitle persist as columns).
 */
export function buildTemplateGraph(template: ProcessMapTemplate): {
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
} {
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
