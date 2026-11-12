/**
 * The agent view's graph (Phase 2.2, docs/ai-architecture/langflow.md): what is
 * drawn for an agent, and the two honesty rules the view holds — no order the
 * forms never defined, and no narrowing hidden.
 */
import type { AgentCanvasProjection } from '@/lib/agentic/agent-canvas-projection';
import {
    AGENT_VIEW_HUB_ID,
    buildAgentViewGraph,
    layoutAgentViewGraph,
} from '@/lib/processes/agent-view/agent-canvas-graph';

function projection(overrides: Partial<AgentCanvasProjection> = {}): AgentCanvasProjection {
    return {
        agent: { id: 'a1', name: 'Posture agent', status: 'ACTIVE', autonomyLevel: 2, riskTier: 'LOW', effectiveCeiling: 2 },
        envelope: {
            grants: [
                { name: 'get_compliance_posture', capability: 'read', requiredAutonomy: 1, withinCeiling: true },
                { name: 'propose_controls', capability: 'propose', requiredAutonomy: 2, withinCeiling: true },
                { name: 'list_risks', capability: 'read', requiredAutonomy: 1, withinCeiling: true },
            ],
            policyCardVersion: 3,
            breakerState: 'CLOSED',
            killScope: null,
        },
        profile: { state: 'NONE' },
        workflows: [],
        usedIn: [],
        ...overrides,
    };
}

const formBuiltProfile: AgentCanvasProjection['profile'] = {
    state: 'SHOWN',
    version: 2,
    status: 'APPROVED',
    inForce: true,
    runAs: 'RUN',
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 8,
    outputKind: 'ANSWER_ONLY',
    readOnly: true,
    allowedTriggers: ['ASK', 'AUTOMATION'],
    tools: [
        { name: 'get_compliance_posture', offered: true },
        { name: 'propose_controls', offered: false, reason: 'READ_ONLY_WORKFLOW' },
        { name: 'revoked_tool', offered: false, reason: 'PROFILE_TOOL_NOT_GRANTED' },
    ],
    skills: [
        { origin: 'repository', name: 'posture-review', mountable: true },
        { origin: 'tenant', name: 'house-style', mountable: false },
    ],
    instructions: 'Summarise the posture.',
};

describe('the agent view graph', () => {
    it('a form-built agent is drawn with no order: hub and spoke, every edge touches the agent', () => {
        const g = buildAgentViewGraph(projection({ profile: formBuiltProfile }));
        // Non-vacuous: triggers, tools, skills and the output are all there.
        expect(g.edges.length).toBeGreaterThanOrEqual(9);
        for (const e of g.edges) {
            expect(e.source === AGENT_VIEW_HUB_ID || e.target === AGENT_VIEW_HUB_ID).toBe(true);
            expect(e.ordered).toBe(false);
            expect(e.advisory).toBe(false);
        }
    });

    it('an agent with only a register entry is still drawn, as its authority envelope', () => {
        const g = buildAgentViewGraph(projection());
        expect(g.nodes.map((n) => n.kind).sort()).toEqual(['hub', 'tool', 'tool', 'tool']);
        expect(g.nodes.find((n) => n.id === AGENT_VIEW_HUB_ID)?.badges.map((b) => b.key)).toEqual([
            'status',
            'autonomy',
            'ceiling',
            'policyCard',
            'breaker',
        ]);
    });

    it('every narrowing is labelled with its reason, never hidden', () => {
        const g = buildAgentViewGraph(projection({ profile: formBuiltProfile }));
        const byId = new Map(g.nodes.map((n) => [n.id, n]));
        expect(byId.get('tool:get_compliance_posture')?.reason).toBeNull();
        expect(byId.get('tool:propose_controls')?.reason).toBe('READ_ONLY_WORKFLOW');
        // A profile tool the agent no longer holds is drawn, not dropped.
        expect(byId.get('tool:revoked_tool')?.reason).toBe('PROFILE_TOOL_NOT_GRANTED');
        // A grant the profile does not name says so.
        expect(byId.get('tool:list_risks')?.badges.map((b) => b.key)).toEqual(['read', 'notInProfile']);
        expect(byId.get('skill:tenant:house-style')?.reason).toBe('SKILL_NOT_MOUNTABLE');
        expect(byId.get('skill:repository:posture-review')?.reason).toBeNull();
    });

    it('an external tool the view did not check is drawn as not checked, never as narrowed or offered', () => {
        if (formBuiltProfile.state !== 'SHOWN') throw new Error('fixture');
        const ext = 'mcp__cmconn__list_alerts';
        const g = buildAgentViewGraph(
            projection({
                profile: { ...formBuiltProfile, tools: [{ name: ext, offered: false, reason: 'EXTERNAL_NOT_PROBED' }] },
            }),
        );
        const node = g.nodes.find((n) => n.id === `tool:${ext}`);
        expect(node?.reason).toBe('EXTERNAL_NOT_PROBED');
        expect(node?.badges.map((b) => b.key)).toEqual(['notProbed']);
    });

    it('a grant the ceiling cannot reach is drawn as unreachable, and an unscored agent says so', () => {
        const g = buildAgentViewGraph(
            projection({
                agent: { id: 'a1', name: 'Draft', status: 'DRAFT', autonomyLevel: 2, riskTier: null, effectiveCeiling: -1 },
                envelope: {
                    grants: [{ name: 'get_compliance_posture', capability: 'read', requiredAutonomy: 1, withinCeiling: false }],
                    policyCardVersion: null,
                    breakerState: null,
                    killScope: 'TENANT',
                },
            }),
        );
        expect(g.nodes.find((n) => n.id === 'tool:get_compliance_posture')?.reason).toBe('BEYOND_CEILING');
        const hub = g.nodes.find((n) => n.id === AGENT_VIEW_HUB_ID);
        expect(hub?.badges.map((b) => b.key)).toEqual(['status', 'autonomy', 'unscored', 'killed']);
    });

    it('a registry workflow is drawn in the order its code defines, dashed only where the order is advisory', () => {
        const steps = [
            { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
            { kind: 'SYNTHESIS', label: 'summary', tool: null },
            { kind: 'PROPOSE', label: 'controls', tool: 'propose_controls' },
        ];
        const g = buildAgentViewGraph(
            projection({
                workflows: [
                    { key: 'static-one', name: 'Static', orderEnforced: true, steps },
                    { key: 'flue-one', name: 'Reasoning', orderEnforced: false, steps },
                ],
            }),
        );
        const ordered = g.edges.filter((e) => e.ordered);
        expect(ordered.map((e) => `${e.source}->${e.target}:${e.advisory}`)).toEqual([
            'wf:static-one:0->wf:static-one:1:false',
            'wf:static-one:1->wf:static-one:2:false',
            'wf:flue-one:0->wf:flue-one:1:true',
            'wf:flue-one:1->wf:flue-one:2:true',
        ]);
        // Each chain hangs off the agent by its first step only.
        expect(g.edges.filter((e) => e.source === AGENT_VIEW_HUB_ID && e.target.startsWith('wf:')).map((e) => e.target)).toEqual([
            'wf:static-one:0',
            'wf:flue-one:0',
        ]);
    });

    it('the process maps that invoke the agent point into it', () => {
        const g = buildAgentViewGraph(projection({ usedIn: [{ mapId: 'm1', mapName: 'Onboarding', nodeKey: 'n-4' }] }));
        expect(g.edges).toContainEqual(expect.objectContaining({ source: 'map:m1:n-4', target: AGENT_VIEW_HUB_ID }));
    });

    it('positions every node, left to right, and the same projection always lays out the same way', () => {
        const p = projection({ profile: formBuiltProfile });
        const g = buildAgentViewGraph(p);
        const first = layoutAgentViewGraph(g);
        expect(Object.keys(first).sort()).toEqual(g.nodes.map((n) => n.id).sort());
        // Triggers sit left of the agent, its tools right of it.
        expect(first['trigger:ASK'].x).toBeLessThan(first[AGENT_VIEW_HUB_ID].x);
        expect(first['tool:get_compliance_posture'].x).toBeGreaterThan(first[AGENT_VIEW_HUB_ID].x);
        expect(layoutAgentViewGraph(buildAgentViewGraph(p))).toEqual(first);
    });
});
