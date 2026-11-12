/**
 * THE AGENT-FLOW DOCUMENT — what the canvas editor holds, split into LOGIC and
 * LAYOUT (Phase 3 of `docs/ai-architecture/langflow.md`).
 *
 * The editor works on a `FlowDraft` (the steps and connections, which is the
 * flow) and a `FlowLayout` (where each step's box sits). They are two values,
 * never one record carrying both, for the reason the process canvas keeps
 * `ProcessNode` geometry apart from `AutomationRule` logic (VR-3):
 *
 *   • LOGIC is the version. It is saved only through the profile usecase, as a
 *     new DRAFT version a second person approves, and it is hashed. Nothing a
 *     layout carries can reach that request: `flowVersionBody` takes no layout.
 *   • LAYOUT is not the version. It is not hashed and not versioned, so moving
 *     a box creates no version. In this slice it is computed from the flow by
 *     the process canvas's own layout engine and held for the session; a
 *     stored layout record is open work (see the implementation note).
 *
 * ── THE ROUND-TRIP CONTRACT (#2963's, for this document) ────────────────────
 *
 * Loading a version and saving it with no edit must produce the same
 * `flowJson`, byte for byte, or every open would offer a "save" that writes a
 * spurious DRAFT. `draftFromFlow` → `flowFromDraft` is the identity on a
 * canonical flow, and `draftChangesFlow` is false for it, which is what the
 * Save button reads.
 *
 * ── DIAGNOSTICS ARE THE SERVER'S RULES ──────────────────────────────────────
 *
 * `diagnoseFlowDraft` asks `checkAgentFlow`, the function the writer asks, so
 * the editor and the server cannot disagree about a cycle, a duplicate
 * connection or the step bound. The three rules that need the server's data
 * (the agent's grants, the approved profiles, the version's output kind) are
 * asked against the lists the server sent, under the server's reason codes;
 * the server still asks them again at save and at approval.
 *
 * Pure: no React, no tldraw, no server import.
 */
import {
    checkAgentFlow,
    FLOW_LABEL_MAX_CHARS,
    FLOW_MAX_NODES,
    FLOW_NODE_KINDS,
    serializeAgentFlow,
    type AgentFlow,
    type AgentFlowEdge,
    type AgentFlowRefusal,
    type FlowNodeKind,
} from '@/lib/agentic/agent-flow';
import { mcpToolCapabilityClass } from '@/lib/mcp/tool-catalogue';
import { computeAutoLayout } from '@/lib/processes/canvas-auto-layout';

/** The palette: the flow kinds and no other. No `checkpoint` (D-L2-2). */
export const AGENT_FLOW_PALETTE: readonly FlowNodeKind[] = FLOW_NODE_KINDS;

/** One step as the editor holds it: the fields a step may have, none required yet. */
export interface FlowDraftNode {
    key: string;
    kind: FlowNodeKind;
    label: string;
    /** A read or propose step's tool; empty until chosen. */
    tool?: string;
    /** A subagent step's profile; empty until chosen. */
    profileRef?: string;
}

/** The LOGIC: steps and connections. Carries no position. */
export interface FlowDraft {
    nodes: FlowDraftNode[];
    edges: AgentFlowEdge[];
}

/** The LAYOUT: where each step's box sits, by step key. Carries no logic. */
export type FlowLayout = Record<string, { x: number; y: number }>;

export const AGENT_FLOW_NODE_W = 220;
export const AGENT_FLOW_NODE_H = 72;

/** A stored flow as the editor opens it. The identity on its logic. */
export function draftFromFlow(flow: AgentFlow | null): FlowDraft {
    if (!flow) return { nodes: [], edges: [] };
    return {
        nodes: flow.nodes.map((n) => {
            switch (n.kind) {
                case 'read':
                case 'propose':
                    return { key: n.key, kind: n.kind, label: n.label, tool: n.tool };
                case 'synthesis':
                    return { key: n.key, kind: n.kind, label: n.label };
                case 'subagent':
                    return { key: n.key, kind: n.kind, label: n.label, profileRef: n.profileRef };
            }
        }),
        edges: flow.edges.map((e) => ({ from: e.from, to: e.to })),
    };
}

/**
 * The draft as the flow a request carries: exactly the fields a flow node has
 * for its kind, and nothing a layout knows. Unchecked — `checkAgentFlow`
 * decides whether it is a flow at all.
 */
export function flowFromDraft(draft: FlowDraft): unknown {
    return {
        nodes: draft.nodes.map((n) => {
            switch (n.kind) {
                case 'read':
                case 'propose':
                    return { key: n.key, kind: n.kind, label: n.label, tool: n.tool ?? '' };
                case 'synthesis':
                    return { key: n.key, kind: n.kind, label: n.label };
                case 'subagent':
                    return { key: n.key, kind: n.kind, label: n.label, profileRef: n.profileRef ?? '' };
            }
        }),
        edges: draft.edges.map((e) => ({ from: e.from, to: e.to })),
    };
}

/**
 * Would saving this draft write a version whose flow differs from `saved`?
 * Compared as the stored text, canonical on both sides, so a draft that only
 * reordered connections (which carries no meaning) is no change. A draft that
 * is not yet a valid flow is a change: it is not the saved one.
 */
export function draftChangesFlow(saved: AgentFlow | null, draft: FlowDraft): boolean {
    if (draft.nodes.length === 0) return saved !== null;
    const checked = checkAgentFlow(flowFromDraft(draft));
    if (!checked.ok) return true;
    return saved === null || serializeAgentFlow(checked.flow) !== serializeAgentFlow(saved);
}

/** A free key for a new step of `kind`: `read-1`, `read-2`, … */
export function nextNodeKey(draft: FlowDraft, kind: FlowNodeKind): string {
    const used = new Set(draft.nodes.map((n) => n.key));
    for (let i = 1; ; i++) {
        const key = `${kind}-${i}`;
        if (!used.has(key)) return key;
    }
}

/**
 * Positions for every step, left to right, from the process canvas's own
 * layout engine. Deterministic for a given draft; positions in `held` (the
 * session's own moves) win for the steps they name.
 */
export function layoutForDraft(draft: FlowDraft, held: FlowLayout = {}): FlowLayout {
    const keys = new Set(draft.nodes.map((n) => n.key));
    const { positions } = computeAutoLayout(
        draft.nodes.map((n) => ({
            id: n.key,
            position: { x: 0, y: 0 },
            style: { width: AGENT_FLOW_NODE_W, height: AGENT_FLOW_NODE_H },
        })),
        draft.edges
            .filter((e) => keys.has(e.from) && keys.has(e.to))
            .map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to })),
        'LR',
    );
    const out: FlowLayout = {};
    for (const n of draft.nodes) out[n.key] = held[n.key] ?? positions[n.key] ?? { x: 0, y: 0 };
    return out;
}

// ─── Diagnostics ────────────────────────────────────────────────────

/** The reasons the editor names. Each is the server's code for the same refusal. */
export type FlowDiagnosticCode =
    | AgentFlowRefusal
    | 'FLOW_EMPTY'
    | 'FLOW_LABEL_EMPTY'
    | 'FLOW_STEP_NEEDS_TOOL'
    | 'FLOW_STEP_NEEDS_PROFILE'
    | 'TOOL_NOT_GRANTED'
    | 'FLOW_SUBAGENT_SELF'
    | 'FLOW_SUBAGENT_NOT_APPROVED'
    | 'FLOW_OUTPUT_KIND_CONFLICT';

export interface FlowDiagnostic {
    code: FlowDiagnosticCode;
    /** The step it is about, when it is about one. */
    nodeKey?: string;
}

export interface FlowDiagnosticContext {
    /** The agent's current grants: the only tools a step may name. */
    grants: readonly string[];
    /** Approved profiles in this workspace a subagent step may name. */
    approvedProfileIds: readonly string[];
    /** This agent's own profile, which a subagent step may not name. */
    selfProfileId: string | null;
    outputKind: 'ANSWER_ONLY' | 'ANSWER_AND_PROPOSALS';
}

/**
 * Everything that would stop this draft saving, before it is sent. Per-step
 * findings first (they say what to fix and where), then the server's own graph
 * check, then the rules that need the server's lists. An empty list means the
 * server's schema accepts the flow; the server still decides.
 */
export function diagnoseFlowDraft(draft: FlowDraft, ctx: FlowDiagnosticContext): FlowDiagnostic[] {
    if (draft.nodes.length === 0) return [{ code: 'FLOW_EMPTY' }];
    const out: FlowDiagnostic[] = [];
    if (draft.nodes.length > FLOW_MAX_NODES) out.push({ code: 'FLOW_TOO_MANY_NODES' });
    const granted = new Set(ctx.grants);
    const approved = new Set(ctx.approvedProfileIds);
    for (const n of draft.nodes) {
        if (n.label.trim().length === 0 || n.label.length > FLOW_LABEL_MAX_CHARS) {
            out.push({ code: 'FLOW_LABEL_EMPTY', nodeKey: n.key });
        }
        if (n.kind === 'read' || n.kind === 'propose') {
            if (!n.tool) out.push({ code: 'FLOW_STEP_NEEDS_TOOL', nodeKey: n.key });
            else if (!granted.has(n.tool)) out.push({ code: 'TOOL_NOT_GRANTED', nodeKey: n.key });
            else if (mcpToolCapabilityClass(n.tool) !== n.kind) out.push({ code: 'FLOW_TOOL_KIND_MISMATCH', nodeKey: n.key });
            if (n.kind === 'propose' && ctx.outputKind === 'ANSWER_ONLY') {
                out.push({ code: 'FLOW_OUTPUT_KIND_CONFLICT', nodeKey: n.key });
            }
        }
        if (n.kind === 'subagent') {
            if (!n.profileRef) out.push({ code: 'FLOW_STEP_NEEDS_PROFILE', nodeKey: n.key });
            else if (n.profileRef === ctx.selfProfileId) out.push({ code: 'FLOW_SUBAGENT_SELF', nodeKey: n.key });
            else if (!approved.has(n.profileRef)) out.push({ code: 'FLOW_SUBAGENT_NOT_APPROVED', nodeKey: n.key });
        }
    }
    if (out.length > 0) return out;
    // The step-level rules hold; now the graph, exactly as the writer checks it.
    const checked = checkAgentFlow(flowFromDraft(draft));
    if (!checked.ok) return [{ code: checked.reason }];
    return [];
}

// ─── The save body ──────────────────────────────────────────────────

/** The version fields a flow save carries over from the version it edits. */
export interface FlowVersionBase {
    instructions: string;
    skillRefs: ReadonlyArray<{ origin: 'repository' | 'tenant'; name: string }>;
    modelTier: string;
    effort: string;
    maxTurns: number;
    outputKind: string;
    allowedTriggers: readonly string[];
}

/**
 * The body of the EXISTING version route for a logic save: the version being
 * edited, whole (a version is immutable, so the next one is written whole),
 * with its flow replaced by the draft's. No `toolNames` (the server derives
 * them from the flow, and naming both is a 400) and no layout: this function
 * takes none, so a position cannot reach the governed write.
 */
export function flowVersionBody(base: FlowVersionBase, draft: FlowDraft): Record<string, unknown> {
    return {
        instructions: base.instructions,
        flow: flowFromDraft(draft),
        skillRefs: base.skillRefs.map((r) => ({ origin: r.origin, name: r.name })),
        modelTier: base.modelTier,
        effort: base.effort,
        maxTurns: base.maxTurns,
        outputKind: base.outputKind,
        allowedTriggers: [...base.allowedTriggers],
    };
}

// ─── The approver's diff (Phase 4.3) ────────────────────────────────

export type FlowNodeChange = 'added' | 'removed' | 'changed' | 'unchanged';

export interface FlowDiff {
    /** Every step of either flow, by key, with what happened to it. */
    nodes: Record<string, FlowNodeChange>;
    edgesAdded: string[];
    edgesRemoved: string[];
    /** Nothing differs. */
    same: boolean;
}

/**
 * What changed from the version in force (`before`) to the one under review
 * (`after`), step by step. A step is matched by key; it is `changed` when its
 * kind, label, tool or profile differs. Connections are compared as a set.
 */
export function diffFlows(before: AgentFlow | null, after: AgentFlow | null): FlowDiff {
    const b = new Map((before?.nodes ?? []).map((n) => [n.key, JSON.stringify(n)]));
    const a = new Map((after?.nodes ?? []).map((n) => [n.key, JSON.stringify(n)]));
    const nodes: Record<string, FlowNodeChange> = {};
    for (const [k, v] of a) nodes[k] = !b.has(k) ? 'added' : b.get(k) === v ? 'unchanged' : 'changed';
    for (const k of b.keys()) if (!a.has(k)) nodes[k] = 'removed';
    const be = new Set((before?.edges ?? []).map((e) => `${e.from}->${e.to}`));
    const ae = new Set((after?.edges ?? []).map((e) => `${e.from}->${e.to}`));
    const edgesAdded = [...ae].filter((e) => !be.has(e)).sort();
    const edgesRemoved = [...be].filter((e) => !ae.has(e)).sort();
    const same = edgesAdded.length === 0 && edgesRemoved.length === 0 && Object.values(nodes).every((c) => c === 'unchanged');
    return { nodes, edgesAdded, edgesRemoved, same };
}
