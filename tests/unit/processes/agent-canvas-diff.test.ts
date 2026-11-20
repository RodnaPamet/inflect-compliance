/**
 * The approver's diff on the agent canvas (Phase 2.4,
 * docs/ai-architecture/langflow.md): what a version under review changes from
 * the version in force, drawn on the agent view.
 *
 * The properties held here: every tool, skill and trigger the version adds or
 * removes is named; a changed model setting marks the agent itself; a removal
 * is DRAWN, not dropped, and joins the agent as a spoke like everything else;
 * an unchanged version reports no change; and with no profile layer to compare
 * there is no diff, never an empty one.
 */
import type { AgentCanvasProfileLayer, AgentCanvasProjection } from '@/lib/agentic/agent-canvas-projection';
import { AGENT_VIEW_HUB_ID } from '@/lib/processes/agent-view/agent-canvas-graph';
import { buildAgentViewDiff, diffAgentProfileLayers } from '@/lib/processes/agent-view/agent-canvas-diff';
import {
    agentCanvasHref,
    agentIdOfInvokeRule,
    withAgentCanvasVersions,
} from '@/lib/processes/agent-view/agent-canvas-link';

const IN_FORCE: AgentCanvasProfileLayer = {
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
        { name: 'list_risks', offered: true },
        { name: 'revoked_tool', offered: false, reason: 'PROFILE_TOOL_NOT_GRANTED' },
    ],
    skills: [{ origin: 'repository', name: 'posture-review', mountable: true }],
    instructions: 'Summarise the posture.',
};

const UNDER_REVIEW: AgentCanvasProfileLayer = {
    ...IN_FORCE,
    version: 3,
    status: 'SUBMITTED',
    inForce: false,
    runAs: 'TEST_RUN',
    modelTier: 'deep',
    allowedTriggers: ['ASK', 'TEST_RUN'],
    tools: [
        { name: 'get_compliance_posture', offered: true },
        { name: 'propose_controls', offered: false, reason: 'TEST_RUN_READ_ONLY' },
    ],
    skills: [{ origin: 'tenant', name: 'house-style', mountable: true }],
};

function projection(profile: AgentCanvasProjection['profile']): AgentCanvasProjection {
    return {
        agent: { id: 'a1', name: 'Posture agent', status: 'ACTIVE', autonomyLevel: 2, riskTier: 'LOW', effectiveCeiling: 2 },
        envelope: {
            grants: [
                { name: 'get_compliance_posture', capability: 'read', requiredAutonomy: 1, withinCeiling: true },
                { name: 'list_risks', capability: 'read', requiredAutonomy: 1, withinCeiling: true },
                { name: 'propose_controls', capability: 'propose', requiredAutonomy: 2, withinCeiling: true },
            ],
            policyCardVersion: 1,
            breakerState: null,
            killScope: null,
        },
        profile,
        workflows: [],
        usedIn: [],
    };
}

describe('what the profile form changed, in words', () => {
    it('names every trigger, tool and skill added or removed, and each model setting changed', () => {
        const changes = diffAgentProfileLayers(IN_FORCE, UNDER_REVIEW);
        expect(changes.map((c) => `${c.aspect}:${c.change}:${c.name ?? `${c.from}->${c.to}`}`)).toEqual([
            'trigger:added:TEST_RUN',
            'trigger:removed:AUTOMATION',
            'tool:added:propose_controls',
            'tool:removed:list_risks',
            'tool:removed:revoked_tool',
            'skill:added:house-style',
            'skill:removed:posture-review',
            'modelTier:changed:balanced->deep',
        ]);
    });

    it('a tool whose run state differs but the version still names is not a change the version made', () => {
        const after: AgentCanvasProfileLayer = {
            ...IN_FORCE,
            tools: IN_FORCE.tools.map((t) => ({ name: t.name, offered: false, reason: 'AGENT_NOT_ACTIVE' as const })),
        };
        expect(diffAgentProfileLayers(IN_FORCE, after)).toEqual([]);
    });

    it('effort, turns and output are compared too, and the output marks the output node', () => {
        const changes = diffAgentProfileLayers(IN_FORCE, { ...IN_FORCE, effort: 'high', maxTurns: 12, outputKind: 'PROPOSALS' });
        expect(changes).toEqual([
            { aspect: 'effort', change: 'changed', nodeId: AGENT_VIEW_HUB_ID, from: 'medium', to: 'high' },
            { aspect: 'maxTurns', change: 'changed', nodeId: AGENT_VIEW_HUB_ID, from: 8, to: 12 },
            { aspect: 'outputKind', change: 'changed', nodeId: 'output', from: 'ANSWER_ONLY', to: 'PROPOSALS' },
        ]);
    });
});

describe('the diff drawn on the canvas', () => {
    it('marks each changed node, and draws what the version removed beside what it keeps', () => {
        const diff = buildAgentViewDiff(projection(IN_FORCE), projection(UNDER_REVIEW));
        if (!diff) throw new Error('expected a diff');
        expect(diff.from).toEqual({ version: 2, status: 'APPROVED' });
        expect(diff.to).toEqual({ version: 3, status: 'SUBMITTED' });
        expect(diff.changeOf).toEqual({
            'trigger:TEST_RUN': 'added',
            'trigger:AUTOMATION': 'removed',
            'tool:propose_controls': 'added',
            'tool:list_risks': 'removed',
            'tool:revoked_tool': 'removed',
            'skill:tenant:house-style': 'added',
            'skill:repository:posture-review': 'removed',
            [AGENT_VIEW_HUB_ID]: 'changed',
        });
        const ids = new Set(diff.graph.nodes.map((n) => n.id));
        // Every marked node is on the drawing: a removal is drawn, not dropped.
        for (const id of Object.keys(diff.changeOf)) expect(ids.has(id)).toBe(true);
        // An unchanged element is drawn unmarked.
        expect(ids.has('tool:get_compliance_posture')).toBe(true);
        expect(diff.changeOf['tool:get_compliance_posture']).toBeUndefined();
    });

    it('a removed element joins as a spoke of the agent, with no order and no stale run state', () => {
        const diff = buildAgentViewDiff(projection(IN_FORCE), projection(UNDER_REVIEW));
        if (!diff) throw new Error('expected a diff');
        for (const e of diff.graph.edges) {
            expect(e.source === AGENT_VIEW_HUB_ID || e.target === AGENT_VIEW_HUB_ID).toBe(true);
            expect(e.ordered).toBe(false);
        }
        // A removed trigger points into the agent, as a trigger does.
        expect(diff.graph.edges).toContainEqual(expect.objectContaining({ source: 'trigger:AUTOMATION', target: AGENT_VIEW_HUB_ID }));
        // A removed tool the agent no longer holds was a narrowing in force; it
        // is drawn as removed, not as a reason a run would be refused.
        const revoked = diff.graph.nodes.find((n) => n.id === 'tool:revoked_tool');
        expect(revoked).toMatchObject({ badges: [], reason: null });
        // Each node is drawn once, so its edge ids are unique too.
        expect(new Set(diff.graph.nodes.map((n) => n.id)).size).toBe(diff.graph.nodes.length);
        expect(new Set(diff.graph.edges.map((e) => e.id)).size).toBe(diff.graph.edges.length);
    });

    it('a version that changes nothing the form sets reports no change', () => {
        const diff = buildAgentViewDiff(projection(IN_FORCE), projection({ ...IN_FORCE, version: 3, status: 'SUBMITTED' }));
        expect(diff?.changes).toEqual([]);
        expect(diff?.changeOf).toEqual({});
    });

    it('with no profile layer on either side there is no diff, never an empty one', () => {
        expect(buildAgentViewDiff(projection({ state: 'NOT_PERMITTED' }), projection({ state: 'NOT_PERMITTED' }))).toBeNull();
        expect(buildAgentViewDiff(projection({ state: 'NONE' }), projection(UNDER_REVIEW))).toBeNull();
    });
});

describe('the link into the canvas', () => {
    it('names the processes segment, and the versions asked for', () => {
        expect(agentCanvasHref('acme', 'agent-1')).toBe('/t/acme/processes/agents/agent-1');
        expect(agentCanvasHref('acme', 'agent-1', { version: 'v3' })).toBe('/t/acme/processes/agents/agent-1?version=v3');
        expect(withAgentCanvasVersions('/t/acme/processes/agents/agent-1', { version: 'v3', compare: 'v2' })).toBe(
            '/t/acme/processes/agents/agent-1?version=v3&compare=v2',
        );
    });

    it('reads the agent only from an INVOKE_AGENT rule that names one', () => {
        expect(agentIdOfInvokeRule({ actionType: 'INVOKE_AGENT', actionConfigJson: { agentId: 'agent-1' } })).toBe('agent-1');
        expect(agentIdOfInvokeRule({ actionType: 'WEBHOOK', actionConfigJson: { agentId: 'agent-1' } })).toBeNull();
        expect(agentIdOfInvokeRule({ actionType: 'INVOKE_AGENT', actionConfigJson: { agentId: 7 } })).toBeNull();
        expect(agentIdOfInvokeRule({ actionType: 'INVOKE_AGENT', actionConfigJson: ['agent-1'] })).toBeNull();
        expect(agentIdOfInvokeRule({ actionType: 'INVOKE_AGENT', actionConfigJson: null })).toBeNull();
        expect(agentIdOfInvokeRule(undefined)).toBeNull();
    });
});
