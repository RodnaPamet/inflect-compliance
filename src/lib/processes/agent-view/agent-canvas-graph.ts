/**
 * THE AGENT VIEW'S GRAPH: a projection turned into nodes and edges, and the
 * layout recomputed from them on every open (Phase 2.2 of
 * `docs/ai-architecture/langflow.md`).
 *
 * Pure and renderer-free. It names no tldraw type and no xyflow type, so it is
 * tested without an editor, and the eslint block over the agent-view files
 * refuses `@xyflow/*` here as everywhere else in the feature.
 *
 * ═══ NO INVENTED ORDER ═══
 *
 * A form-built agent has no sequence: neither the registration form nor the
 * profile form defines one. So its graph is hub and spoke — triggers into the
 * agent, the agent out to its tools, skills and output — and EVERY edge touches
 * the hub. Drawing a chain the forms never defined would show the reader a plan
 * nobody wrote. The only ordered edges are a code-registered workflow's own
 * steps, whose order the code does define; they are marked `ordered`, and
 * `advisory` when the workflow runs on a reasoning engine, which reads steps as
 * a specification rather than walking them.
 *
 * ═══ EVERY NARROWING IS LABELLED, NEVER HIDDEN ═══
 *
 * A tool the profile names that a run would not be offered is still drawn, with
 * the reason. Hiding it would make an under-provisioned agent look as though
 * its author chose less.
 *
 * ═══ LABELS ARE KEYS ═══
 *
 * Badges and reasons are message keys under `agentCanvas`, resolved by the
 * component; names (tools, skills, maps) are drawn verbatim. The graph carries
 * no English sentence a Bulgarian reader would then see.
 */
import type { AgentCanvasProjection } from '@/lib/agentic/agent-canvas-projection';
import { computeAutoLayout } from '@/lib/processes/canvas-auto-layout';

export type AgentViewNodeKind = 'hub' | 'trigger' | 'tool' | 'skill' | 'output' | 'step' | 'map';

/** A message key under `agentCanvas.badge`, with its ICU values. */
export interface AgentViewBadge {
    key: string;
    values?: Record<string, string | number>;
}

export interface AgentViewNode {
    id: string;
    kind: AgentViewNodeKind;
    /** Drawn verbatim: a name the tenant or the code chose. */
    label: string;
    badges: AgentViewBadge[];
    /** A message key under `agentCanvas.reason`, or null when nothing narrows it. */
    reason: string | null;
}

export interface AgentViewEdge {
    id: string;
    source: string;
    target: string;
    /** The edge is a step order (a code-registered workflow's), not a relation. */
    ordered: boolean;
    /** The order is advisory: the engine may deviate. Drawn dashed. */
    advisory: boolean;
}

export interface AgentViewGraph {
    nodes: AgentViewNode[];
    edges: AgentViewEdge[];
}

export const AGENT_VIEW_HUB_ID = 'hub';

function spoke(source: string, target: string): AgentViewEdge {
    return { id: `${source}->${target}`, source, target, ordered: false, advisory: false };
}

/** The agent node's facts, envelope first, then the profile's run settings. */
function hubBadges(p: AgentCanvasProjection): AgentViewBadge[] {
    const badges: AgentViewBadge[] = [
        { key: 'status', values: { status: p.agent.status } },
        { key: 'autonomy', values: { level: p.agent.autonomyLevel } },
        p.agent.riskTier === null
            ? { key: 'unscored' }
            : { key: 'ceiling', values: { ceiling: p.agent.effectiveCeiling, tier: p.agent.riskTier } },
    ];
    if (p.envelope.policyCardVersion !== null) badges.push({ key: 'policyCard', values: { version: p.envelope.policyCardVersion } });
    if (p.envelope.breakerState !== null) badges.push({ key: 'breaker', values: { state: p.envelope.breakerState } });
    if (p.envelope.killScope !== null) badges.push({ key: 'killed', values: { scope: p.envelope.killScope } });
    if (p.profile.state === 'SHOWN') {
        badges.push(
            { key: 'profileVersion', values: { version: p.profile.version, status: p.profile.status } },
            { key: 'model', values: { tier: p.profile.modelTier, effort: p.profile.effort, turns: p.profile.maxTurns } },
        );
    }
    return badges;
}

/**
 * One tool node per tool name, whichever layer names it: a grant, a profile
 * tool, or both. Its reason is the first that applies — what a run would be
 * refused for, then what the ceiling refuses — so the node says the binding
 * constraint, not every constraint.
 */
function toolNodes(p: AgentCanvasProjection): AgentViewNode[] {
    const grants = new Map((p.envelope.grants ?? []).map((g) => [g.name, g]));
    const profileTools = p.profile.state === 'SHOWN' ? new Map(p.profile.tools.map((t) => [t.name, t])) : null;
    const names = [...new Set([...grants.keys(), ...(profileTools ? profileTools.keys() : [])])].sort();
    return names.map((name) => {
        const grant = grants.get(name);
        const inProfile = profileTools?.get(name);
        const badges: AgentViewBadge[] = [];
        if (grant) badges.push({ key: grant.capability === 'propose' ? 'propose' : 'read' });
        if (profileTools) badges.push({ key: inProfile ? (inProfile.offered ? 'offered' : 'narrowed') : 'notInProfile' });
        let reason: string | null = null;
        if (inProfile && !inProfile.offered) reason = inProfile.reason;
        else if (grant && !grant.withinCeiling) reason = 'BEYOND_CEILING';
        return { id: `tool:${name}`, kind: 'tool', label: name, badges, reason };
    });
}

export function buildAgentViewGraph(p: AgentCanvasProjection): AgentViewGraph {
    const nodes: AgentViewNode[] = [
        { id: AGENT_VIEW_HUB_ID, kind: 'hub', label: p.agent.name, badges: hubBadges(p), reason: null },
    ];
    const edges: AgentViewEdge[] = [];

    for (const m of p.usedIn) {
        const id = `map:${m.mapId}:${m.nodeKey}`;
        nodes.push({ id, kind: 'map', label: m.mapName, badges: [{ key: 'invokes' }], reason: null });
        edges.push(spoke(id, AGENT_VIEW_HUB_ID));
    }

    if (p.profile.state === 'SHOWN') {
        for (const t of p.profile.allowedTriggers) {
            const id = `trigger:${t}`;
            nodes.push({ id, kind: 'trigger', label: t, badges: [], reason: null });
            edges.push(spoke(id, AGENT_VIEW_HUB_ID));
        }
    }

    for (const n of toolNodes(p)) {
        nodes.push(n);
        edges.push(spoke(AGENT_VIEW_HUB_ID, n.id));
    }

    if (p.profile.state === 'SHOWN') {
        for (const s of p.profile.skills) {
            const id = `skill:${s.origin}:${s.name}`;
            nodes.push({
                id,
                kind: 'skill',
                label: s.name,
                badges: [{ key: s.origin === 'tenant' ? 'tenantSkill' : 'shippedSkill' }],
                reason: s.mountable ? null : 'SKILL_NOT_MOUNTABLE',
            });
            edges.push(spoke(AGENT_VIEW_HUB_ID, id));
        }
        const out = 'output';
        nodes.push({
            id: out,
            kind: 'output',
            label: p.profile.outputKind,
            badges: p.profile.readOnly ? [{ key: 'readOnly' }] : [],
            reason: null,
        });
        edges.push(spoke(AGENT_VIEW_HUB_ID, out));
    }

    for (const wf of p.workflows) {
        let previous = AGENT_VIEW_HUB_ID;
        wf.steps.forEach((step, i) => {
            const id = `wf:${wf.key}:${i}`;
            nodes.push({
                id,
                kind: 'step',
                label: step.tool ? `${step.label} · ${step.tool}` : step.label,
                badges: [{ key: 'step', values: { workflow: wf.name, kind: step.kind, n: i + 1 } }],
                reason: null,
            });
            edges.push(
                previous === AGENT_VIEW_HUB_ID
                    ? spoke(AGENT_VIEW_HUB_ID, id)
                    : { id: `${previous}->${id}`, source: previous, target: id, ordered: true, advisory: !wf.orderEnforced },
            );
            previous = id;
        });
    }

    return { nodes, edges };
}

export const AGENT_VIEW_NODE_W = 220;
export const AGENT_VIEW_NODE_H = 80;

/**
 * Positions for every node, left to right, from the process canvas's own
 * layout engine. Recomputed from the graph on every open and never stored:
 * nothing to persist means nothing to write.
 */
export function layoutAgentViewGraph(graph: AgentViewGraph): Record<string, { x: number; y: number }> {
    const { positions } = computeAutoLayout(
        graph.nodes.map((n) => ({ id: n.id, position: { x: 0, y: 0 }, style: { width: AGENT_VIEW_NODE_W, height: AGENT_VIEW_NODE_H } })),
        graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
        'LR',
    );
    return positions;
}
