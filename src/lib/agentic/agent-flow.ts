/**
 * AN AGENT FLOW — what a person draws an agent doing, as DATA on its profile
 * version (Phase 1 of `docs/ai-architecture/langflow.md`).
 *
 * A flow is a small directed acyclic graph of steps: read with a tool, propose
 * with a tool, synthesise an answer, or hand a part of the work to another
 * approved profile. It is stored on an `AgentProfileVersion` beside the
 * instructions, hashed with them, frozen with them, and compiled into the step
 * SPECIFICATION a reasoning engine receives. It is never executable: static
 * workflow steps carry functions, so a drawn flow can only ever be a
 * specification, and a reasoning engine reads its order as advice while the
 * funnel enforces its tools.
 *
 * ── WHAT THE SCHEMA REFUSES, AND WHY ────────────────────────────────────────
 *
 *   • A `checkpoint` kind. No reasoning engine parks a run at a human
 *     checkpoint yet (owner decision D-L2-2: enforcement lands BEFORE any
 *     checkpoint node, Phase 5.1). A node the engine would ignore is a node
 *     that looks enforced and is not, so the schema has no such kind and a save
 *     naming one is refused (`FLOW_CHECKPOINT_UNENFORCED`).
 *   • More nodes than `ENGINE_CAPS.MAX_STEPS`. A flow can only describe work a
 *     run could do within the engine's own step bound.
 *   • A cycle. A specification that loops has no order to hand the model, the
 *     way the process canvas refuses a cyclic rule chain.
 *   • A tool on a node whose kind it is not: a read node names a read tool, a
 *     propose node a propose tool. Otherwise "no propose node, so read-only"
 *     would be a claim the stored tools contradict.
 *   • Anything it does not name (`.strict()` throughout), so a field a flow
 *     does not have — a grant, a scope, a model id — is a 400, never dropped.
 *
 * ── ONE SOURCE OF TRUTH FOR TOOLS ───────────────────────────────────────────
 *
 * With a flow, a version's `toolNames` is DERIVED from the flow's nodes
 * (`flowToolNames`) and never entered beside it: two lists that must agree,
 * maintained by hand, are the drift this phase exists to prevent. The writer
 * derives it, the resolver re-derives it and refuses a stored list that
 * disagrees.
 *
 * Pure: zod and the leaf tool catalogue only, no server import and no Node
 * built-in, so the canvas (Phase 3) can hold the same schema the server
 * enforces. Labels are sanitised by the writer (`sanitizePlainText` is a
 * server module); this module re-validates whatever it is given.
 */
import { z } from 'zod';

import { mcpToolCapabilityClass } from '@/lib/mcp/tool-catalogue';
import { ENGINE_CAPS } from './workflow-types';

/** The node kinds a flow may hold. No `checkpoint` until Phase 5.1 (D-L2-2). */
export const FLOW_NODE_KINDS = ['read', 'propose', 'synthesis', 'subagent'] as const;
export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number];

/** At most as many nodes as a run may take steps. */
export const FLOW_MAX_NODES: number = ENGINE_CAPS.MAX_STEPS;
/** Edges are bounded too, so a stored flow has a known worst-case size. */
export const FLOW_MAX_EDGES = 4 * ENGINE_CAPS.MAX_STEPS;
/** A node label's size cap, after sanitising. */
export const FLOW_LABEL_MAX_CHARS = 200;
/** A node key: a short slug, unique within the flow. */
export const FLOW_NODE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A subagent's reference: the id of an `AgentProfile` in the same tenant. */
const PROFILE_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const key = z.string().regex(FLOW_NODE_KEY_PATTERN);
const label = z.string().min(1).max(FLOW_LABEL_MAX_CHARS);
const tool = z.string().min(1).max(100);

const ReadNode = z.object({ key, kind: z.literal('read'), label, tool }).strict();
const ProposeNode = z.object({ key, kind: z.literal('propose'), label, tool }).strict();
const SynthesisNode = z.object({ key, kind: z.literal('synthesis'), label }).strict();
const SubagentNode = z
    .object({ key, kind: z.literal('subagent'), label, profileRef: z.string().regex(PROFILE_REF_PATTERN) })
    .strict();

export const AgentFlowNodeSchema = z.discriminatedUnion('kind', [ReadNode, ProposeNode, SynthesisNode, SubagentNode]);
export type AgentFlowNode = z.infer<typeof AgentFlowNodeSchema>;

export const AgentFlowEdgeSchema = z.object({ from: key, to: key }).strict();
export type AgentFlowEdge = z.infer<typeof AgentFlowEdgeSchema>;

/**
 * The flow as a request body carries it, and as it is stored. The SHAPE only:
 * the graph rules (unique keys, edges between known nodes, acyclic, tools of
 * the right kind) are `checkAgentFlow`, which names each refusal.
 */
export const AgentFlowSchema = z
    .object({
        nodes: z.array(AgentFlowNodeSchema).min(1).max(FLOW_MAX_NODES),
        edges: z.array(AgentFlowEdgeSchema).max(FLOW_MAX_EDGES),
    })
    .strict();
export type AgentFlow = z.infer<typeof AgentFlowSchema>;

/** Why a flow is refused. Each is a `details.reason` the writer returns. */
export type AgentFlowRefusal =
    | 'FLOW_INVALID'
    | 'FLOW_CHECKPOINT_UNENFORCED'
    | 'FLOW_TOO_MANY_NODES'
    | 'FLOW_DUPLICATE_KEY'
    | 'FLOW_UNKNOWN_EDGE_END'
    | 'FLOW_SELF_EDGE'
    | 'FLOW_DUPLICATE_EDGE'
    | 'FLOW_CYCLE'
    | 'FLOW_TOOL_KIND_MISMATCH'
    | 'FLOW_NAMES_NO_TOOL';

export type AgentFlowCheck =
    | { readonly ok: true; readonly flow: AgentFlow }
    | { readonly ok: false; readonly reason: AgentFlowRefusal; readonly message: string; readonly detail?: readonly string[] };

function fail(reason: AgentFlowRefusal, message: string, detail?: readonly string[]): AgentFlowCheck {
    return detail ? { ok: false, reason, message, detail } : { ok: false, reason, message };
}

/** Does any node in a raw value claim the `checkpoint` kind? Asked before the shape, to name it. */
function namesCheckpoint(raw: unknown): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const nodes = (raw as { nodes?: unknown }).nodes;
    return Array.isArray(nodes) && nodes.some((n) => !!n && typeof n === 'object' && (n as { kind?: unknown }).kind === 'checkpoint');
}

/**
 * The order the nodes are covered in: Kahn's algorithm, taking among the nodes
 * that are ready the one declared first, so the same flow always yields the
 * same order. `null` when the graph has a cycle.
 */
export function topologicalOrder(flow: Pick<AgentFlow, 'nodes' | 'edges'>): AgentFlowNode[] | null {
    const index = new Map(flow.nodes.map((n, i) => [n.key, i]));
    const indegree = flow.nodes.map(() => 0);
    const out = flow.nodes.map(() => [] as number[]);
    for (const e of flow.edges) {
        const from = index.get(e.from);
        const to = index.get(e.to);
        if (from === undefined || to === undefined) return null;
        out[from].push(to);
        indegree[to] += 1;
    }
    const done = flow.nodes.map(() => false);
    const order: AgentFlowNode[] = [];
    for (let placed = 0; placed < flow.nodes.length; placed++) {
        const next = indegree.findIndex((d, i) => d === 0 && !done[i]);
        if (next === -1) return null;
        done[next] = true;
        order.push(flow.nodes[next]);
        for (const t of out[next]) indegree[t] -= 1;
    }
    return order;
}

/**
 * Check a flow, raw from a request body or a stored row. Every graph rule, each
 * refused with its own reason; the first one broken is reported. A flow that
 * passes is returned in its CANONICAL form (`canonicalFlow`), the form that is
 * stored and hashed.
 */
export function checkAgentFlow(raw: unknown): AgentFlowCheck {
    if (namesCheckpoint(raw)) {
        return fail(
            'FLOW_CHECKPOINT_UNENFORCED',
            'A checkpoint step cannot be drawn yet: no reasoning engine stops a run at one, so it would look ' +
                'enforced and not be. It is offered once checkpoints are enforced.',
        );
    }
    if (raw && typeof raw === 'object' && Array.isArray((raw as { nodes?: unknown }).nodes)
        && ((raw as { nodes: unknown[] }).nodes.length > FLOW_MAX_NODES)) {
        return fail('FLOW_TOO_MANY_NODES', `A flow has at most ${FLOW_MAX_NODES} steps, the most a run may take.`);
    }
    const parsed = AgentFlowSchema.safeParse(raw);
    if (!parsed.success) {
        return fail('FLOW_INVALID', 'The flow is not one this version of the product can read.', parsed.error.issues.map((i) => i.path.join('.')));
    }
    const flow = parsed.data;

    const keys = new Set<string>();
    const duplicates = new Set<string>();
    for (const n of flow.nodes) (keys.has(n.key) ? duplicates : keys).add(n.key);
    if (duplicates.size > 0) return fail('FLOW_DUPLICATE_KEY', 'Two steps share a key.', [...duplicates]);

    const edgeKeys = new Set<string>();
    for (const e of flow.edges) {
        if (!keys.has(e.from) || !keys.has(e.to)) {
            return fail('FLOW_UNKNOWN_EDGE_END', 'A connection names a step the flow does not have.', [`${e.from}->${e.to}`]);
        }
        if (e.from === e.to) return fail('FLOW_SELF_EDGE', 'A step cannot follow itself.', [e.from]);
        const k = `${e.from}->${e.to}`;
        if (edgeKeys.has(k)) return fail('FLOW_DUPLICATE_EDGE', 'Two connections join the same steps.', [k]);
        edgeKeys.add(k);
    }
    if (topologicalOrder(flow) === null) {
        return fail('FLOW_CYCLE', 'The flow loops back on itself, so it has no order to follow.');
    }

    const mismatched = flow.nodes
        .filter((n): n is Extract<AgentFlowNode, { tool: string }> => n.kind === 'read' || n.kind === 'propose')
        .filter((n) => mcpToolCapabilityClass(n.tool) !== n.kind)
        .map((n) => `${n.key}:${n.tool}`);
    if (mismatched.length > 0) {
        return fail(
            'FLOW_TOOL_KIND_MISMATCH',
            'A read step names a tool that is not a read tool, or a propose step one that is not a propose tool.',
            mismatched,
        );
    }
    if (flowToolNames(flow).length === 0) {
        return fail('FLOW_NAMES_NO_TOOL', 'A flow uses at least one tool: a run that can read nothing would answer anyway.');
    }
    return { ok: true, flow: canonicalFlow(flow) };
}

/**
 * The flow with every object's keys in one fixed order, nodes in declaration
 * order (which breaks ties in the topological order, so it is meaning) and
 * edges sorted (which carries none). Two requests describing the same flow
 * store the same text and the same hash.
 */
export function canonicalFlow(flow: AgentFlow): AgentFlow {
    const nodes = flow.nodes.map((n): AgentFlowNode => {
        switch (n.kind) {
            case 'read':
            case 'propose':
                return { key: n.key, kind: n.kind, label: n.label, tool: n.tool };
            case 'synthesis':
                return { key: n.key, kind: n.kind, label: n.label };
            case 'subagent':
                return { key: n.key, kind: n.kind, label: n.label, profileRef: n.profileRef };
        }
    });
    const edges = [...flow.edges]
        .map((e) => ({ from: e.from, to: e.to }))
        .sort((a, b) => (a.from === b.from ? cmp(a.to, b.to) : cmp(a.from, b.from)));
    return { nodes, edges };
}

function cmp(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

/** The stored text of a canonical flow. What is encrypted at rest and hashed. */
export function serializeAgentFlow(flow: AgentFlow): string {
    return JSON.stringify(canonicalFlow(flow));
}

/**
 * Read a stored flow back. `null` for text that does not parse or no longer
 * passes `checkAgentFlow`, so a run executes what was approved or nothing.
 */
export function parseStoredAgentFlow(text: string): AgentFlow | null {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    const checked = checkAgentFlow(raw);
    return checked.ok ? checked.flow : null;
}

/** The tools a flow uses, deduplicated and sorted: the version's `toolNames`. */
export function flowToolNames(flow: Pick<AgentFlow, 'nodes'>): string[] {
    const tools = new Set<string>();
    for (const n of flow.nodes) if (n.kind === 'read' || n.kind === 'propose') tools.add(n.tool);
    return [...tools].sort();
}

/**
 * Is a stored `toolNames` exactly what the flow derives? The writer stores the
 * derived list, so a row where the two disagree was not written by it: the
 * approval and the resolver both refuse one.
 */
export function flowToolsAgree(flow: Pick<AgentFlow, 'nodes'>, toolNames: readonly string[]): boolean {
    const derived = flowToolNames(flow);
    const stored = [...toolNames].sort();
    return derived.length === stored.length && derived.every((t, i) => t === stored[i]);
}

/** The profiles a flow hands work to, deduplicated and sorted. */
export function flowSubagentRefs(flow: Pick<AgentFlow, 'nodes'>): string[] {
    return [...new Set(flow.nodes.flatMap((n) => (n.kind === 'subagent' ? [n.profileRef] : [])))].sort();
}

/** Every node label, in declaration order: what the writer sanitises and scans. */
export function flowLabels(flow: Pick<AgentFlow, 'nodes'>): string[] {
    return flow.nodes.map((n) => n.label);
}

/** One step of the specification a reasoning engine receives. */
export interface FlowStepSpec {
    readonly kind: 'READ' | 'PROPOSE' | 'SYNTHESIS' | 'SUBAGENT';
    readonly label: string;
    /** The tool a read or propose step uses. */
    readonly tool?: string;
}

export interface CompiledFlow {
    /** The nodes in topological order, as the run message lists them. */
    readonly stepsSpec: readonly FlowStepSpec[];
    /** No propose node anywhere: the run is offered the read surface only. */
    readonly readOnly: boolean;
}

const SPEC_KIND: Record<FlowNodeKind, FlowStepSpec['kind']> = {
    read: 'READ',
    propose: 'PROPOSE',
    synthesis: 'SYNTHESIS',
    subagent: 'SUBAGENT',
};

/**
 * Compile a checked flow into the specification a reasoning engine receives:
 * its nodes in topological order, and whether it is read-only. Pure, no I/O.
 * Throws on a cyclic flow, which `checkAgentFlow` has already refused, so a
 * throw here is a caller that skipped the check.
 */
export function compileFlow(flow: AgentFlow): CompiledFlow {
    const order = topologicalOrder(flow);
    if (order === null) throw new Error('compileFlow: the flow has a cycle; checkAgentFlow refuses it first.');
    return {
        stepsSpec: order.map((n) =>
            n.kind === 'read' || n.kind === 'propose'
                ? { kind: SPEC_KIND[n.kind], label: n.label, tool: n.tool }
                : { kind: SPEC_KIND[n.kind], label: n.label },
        ),
        readOnly: !flow.nodes.some((n) => n.kind === 'propose'),
    };
}

/** One spec step as the run message lists it. */
export function renderFlowStep(step: FlowStepSpec, position: number): string {
    return `${position}. [${step.kind}] ${step.label}${step.tool ? ` (tool: ${step.tool})` : ''}`;
}

/**
 * THE FLOW AS THE APPROVER READS IT: every fact the content hash covers, as
 * plain text, so a second person never approves a flow they were not shown.
 *
 * The steps come first, in the order the run message would list them
 * (`renderFlowStep`, so the reviewer reads the model's own lines), each with
 * its key and, for a `subagent` step, the profile it names; then every
 * connection. Nothing the stored flow carries is left out: a change to a
 * label, a tool, a profile reference, the order or a connection changes this
 * text, which is why the Behaviour tab renders it and diffs it beside the
 * instructions. Language-neutral on purpose, because it is the specification,
 * not a translation of it. Pure, so the client renders what the server hashed.
 */
export function describeFlowForReview(flow: AgentFlow): string {
    const order = topologicalOrder(flow) ?? flow.nodes;
    const steps = order.map((n, i) => {
        const line = renderFlowStep(
            n.kind === 'read' || n.kind === 'propose'
                ? { kind: SPEC_KIND[n.kind], label: n.label, tool: n.tool }
                : { kind: SPEC_KIND[n.kind], label: n.label },
            i + 1,
        );
        return `${line} {${n.key}}${n.kind === 'subagent' ? ` (profile: ${n.profileRef})` : ''}`;
    });
    const edges = canonicalFlow(flow).edges.map((e) => `${e.from} -> ${e.to}`);
    return [...steps, '', ...(edges.length > 0 ? edges : ['(no connections)'])].join('\n');
}
