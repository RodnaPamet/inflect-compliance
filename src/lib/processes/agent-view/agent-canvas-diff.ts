/**
 * THE APPROVER'S DIFF, ON THE CANVAS (Phase 2.4 of
 * `docs/ai-architecture/langflow.md`).
 *
 * A version written in the profile form has no drawing of its own, so its diff
 * is a diff of two PROJECTIONS: the version under review against the version in
 * force, each projected by `projectAgentForCanvas` exactly as the view draws it
 * alone. What a reviewer is shown is what the profile form changes and the
 * approval puts in force: tools, skills and triggers added or removed, and the
 * model tier, effort, turn limit and output kind changed.
 *
 * ═══ WHY NOT `canvas-changes-tldraw.ts` AND `CanvasDiffOverlay` ═══
 *
 * The roadmap named both, and neither fits, for the reason Phase 4.3 found:
 * `canvas-changes-tldraw.ts` classifies a live editor's store events for
 * autosave (was this edit worth saving?), not two versions of a document, and
 * `CanvasDiffOverlay` fetches a process MAP's stored snapshot by map id and
 * lists row keys. An agent's versions are neither tldraw stores nor map
 * snapshots. So the comparison is here, pure, over the projection the view
 * already draws, and the agent view's own canvas draws it — the same split the
 * agent-flow editor's `diffFlows` makes.
 *
 * ═══ WHAT IS DRAWN ═══
 *
 * The graph of the version under review, with every element marked added,
 * removed or changed, PLUS each element the version removed that would
 * otherwise have nothing to draw (a trigger, a skill, a tool the agent is no
 * longer granted). A removal is drawn, not dropped: a reviewer who cannot see
 * what went away is approving half a change. Nothing is ordered that the forms
 * did not order: removed elements join as spokes of the agent, like the rest.
 *
 * Pure and renderer-free, like the graph builder it extends: no tldraw, no
 * xyflow, no React.
 */
import type { AgentCanvasProfileLayer, AgentCanvasProjection } from '@/lib/agentic/agent-canvas-projection';

import { AGENT_VIEW_HUB_ID, buildAgentViewGraph, type AgentViewGraph, type AgentViewNode } from './agent-canvas-graph';

export type AgentViewChange = 'added' | 'removed' | 'changed';

/** What one change is about. Read in this order by the list. */
export const AGENT_PROFILE_ASPECTS = ['trigger', 'tool', 'skill', 'modelTier', 'effort', 'maxTurns', 'outputKind'] as const;
export type AgentProfileAspect = (typeof AGENT_PROFILE_ASPECTS)[number];

export interface AgentProfileChange {
    aspect: AgentProfileAspect;
    change: AgentViewChange;
    /** The graph node the change is drawn on. */
    nodeId: string;
    /** The element's name, for a set aspect (trigger, tool, skill). */
    name?: string;
    /** Before and after, for a setting (model tier, effort, turns, output). */
    from?: string | number;
    to?: string | number;
}

export interface AgentViewDiff {
    /** The version the changes are drawn FROM (normally the version in force). */
    from: { version: number; status: string };
    /** The version under review. */
    to: { version: number; status: string };
    /** What is drawn: the version under review, plus what it removed. */
    graph: AgentViewGraph;
    /** Each changed node's mark; an unchanged node has none. */
    changeOf: Record<string, AgentViewChange>;
    /** Every change, in words, in `AGENT_PROFILE_ASPECTS` order. */
    changes: AgentProfileChange[];
}

/** The node a set element is drawn as, by `buildAgentViewGraph`'s ids. */
function nodeIdOf(aspect: 'trigger' | 'tool' | 'skill', key: string): string {
    return `${aspect}:${key}`;
}

function setChanges(
    aspect: 'trigger' | 'tool' | 'skill',
    before: ReadonlyMap<string, string>,
    after: ReadonlyMap<string, string>,
): AgentProfileChange[] {
    const added = [...after.keys()].filter((k) => !before.has(k)).sort();
    const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
    return [
        ...added.map((k): AgentProfileChange => ({ aspect, change: 'added', nodeId: nodeIdOf(aspect, k), name: after.get(k) ?? k })),
        ...removed.map((k): AgentProfileChange => ({ aspect, change: 'removed', nodeId: nodeIdOf(aspect, k), name: before.get(k) ?? k })),
    ];
}

function settingChange(
    aspect: 'modelTier' | 'effort' | 'maxTurns' | 'outputKind',
    nodeId: string,
    from: string | number,
    to: string | number,
): AgentProfileChange[] {
    return from === to ? [] : [{ aspect, change: 'changed', nodeId, from, to }];
}

/**
 * What the profile form changed from `before` to `after`.
 *
 * Tools are compared by name and skills by origin and name: the version names
 * them, and their offered or mountable STATE is the run's, drawn on the node
 * already. A tool the version still names but a run is no longer offered is not
 * a change the version made.
 */
export function diffAgentProfileLayers(before: AgentCanvasProfileLayer, after: AgentCanvasProfileLayer): AgentProfileChange[] {
    const triggers = (p: AgentCanvasProfileLayer) => new Map(p.allowedTriggers.map((x) => [x, x]));
    const tools = (p: AgentCanvasProfileLayer) => new Map(p.tools.map((x) => [x.name, x.name]));
    const skills = (p: AgentCanvasProfileLayer) => new Map(p.skills.map((s) => [`${s.origin}:${s.name}`, s.name]));
    const byAspect: Record<AgentProfileAspect, AgentProfileChange[]> = {
        trigger: setChanges('trigger', triggers(before), triggers(after)),
        tool: setChanges('tool', tools(before), tools(after)),
        skill: setChanges('skill', skills(before), skills(after)),
        modelTier: settingChange('modelTier', AGENT_VIEW_HUB_ID, before.modelTier, after.modelTier),
        effort: settingChange('effort', AGENT_VIEW_HUB_ID, before.effort, after.effort),
        maxTurns: settingChange('maxTurns', AGENT_VIEW_HUB_ID, before.maxTurns, after.maxTurns),
        outputKind: settingChange('outputKind', 'output', before.outputKind, after.outputKind),
    };
    return AGENT_PROFILE_ASPECTS.flatMap((a) => byAspect[a]);
}

/** A removed element as drawn beside the version that removed it: its name, no run state. */
function removedNode(n: AgentViewNode): AgentViewNode {
    return { ...n, badges: [], reason: null };
}

/**
 * The diff of two projections of one agent, or null when either has no profile
 * layer to compare (profiles off, the reader may not read a profile, or the
 * version asked for is not the agent's).
 */
export function buildAgentViewDiff(before: AgentCanvasProjection, after: AgentCanvasProjection): AgentViewDiff | null {
    if (before.profile.state !== 'SHOWN' || after.profile.state !== 'SHOWN') return null;
    const changes = diffAgentProfileLayers(before.profile, after.profile);

    const drawn = buildAgentViewGraph(after);
    const nodes = [...drawn.nodes];
    const edges = [...drawn.edges];
    const present = new Set(nodes.map((n) => n.id));
    const beforeNodes = new Map(buildAgentViewGraph(before).nodes.map((n) => [n.id, n]));

    const changeOf: Record<string, AgentViewChange> = {};
    for (const c of changes) {
        // The agent node carries several settings: any of them changes it.
        changeOf[c.nodeId] = c.change;
        if (c.change !== 'removed' || present.has(c.nodeId)) continue;
        const gone = beforeNodes.get(c.nodeId);
        if (!gone) continue;
        nodes.push(removedNode(gone));
        present.add(gone.id);
        const [source, target] = gone.kind === 'trigger' ? [gone.id, AGENT_VIEW_HUB_ID] : [AGENT_VIEW_HUB_ID, gone.id];
        edges.push({ id: `${source}->${target}`, source, target, ordered: false, advisory: false });
    }

    return {
        from: { version: before.profile.version, status: before.profile.status },
        to: { version: after.profile.version, status: after.profile.status },
        graph: { nodes, edges },
        changeOf,
        changes,
    };
}
