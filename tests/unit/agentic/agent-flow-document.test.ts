/**
 * The agent-flow editor's document (Phase 3 of docs/ai-architecture/langflow.md):
 * logic and layout kept apart, the round-trip contract, and diagnostics that
 * are the server's own rules.
 */
import {
    checkAgentFlow,
    FLOW_MAX_NODES,
    serializeAgentFlow,
    type AgentFlow,
} from '@/lib/agentic/agent-flow';
import {
    AGENT_FLOW_PALETTE,
    diagnoseFlowDraft,
    diffFlows,
    draftChangesFlow,
    draftFromFlow,
    flowFromDraft,
    flowVersionBody,
    layoutForDraft,
    nextNodeKey,
    type FlowDraft,
} from '@/lib/processes/agent-flow/agent-flow-document';

const FLOW: AgentFlow = {
    nodes: [
        { key: 'read-1', kind: 'read', label: 'Read posture', tool: 'get_compliance_posture' },
        { key: 'synthesis-1', kind: 'synthesis', label: 'Answer' },
    ],
    edges: [{ from: 'read-1', to: 'synthesis-1' }],
};

const CTX = {
    grants: ['get_compliance_posture', 'list_risks', 'propose_finding'],
    approvedProfileIds: ['prof-other'],
    selfProfileId: 'prof-self',
    outputKind: 'ANSWER_AND_PROPOSALS' as const,
};

const BASE = {
    instructions: 'Review the posture.',
    skillRefs: [{ origin: 'repository' as const, name: 'posture' }],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 8,
    outputKind: 'ANSWER_AND_PROPOSALS',
    allowedTriggers: ['ASK'],
};

describe('the round-trip contract (#2963, for an agent flow)', () => {
    it('loading a version and saving it with no edit produces the same flowJson, byte for byte', () => {
        const stored = serializeAgentFlow(FLOW);
        const checked = checkAgentFlow(flowFromDraft(draftFromFlow(FLOW)));
        expect(checked.ok).toBe(true);
        if (checked.ok) expect(serializeAgentFlow(checked.flow)).toBe(stored);
    });

    it('an unedited draft is no change, so the editor offers no save and writes no spurious DRAFT', () => {
        expect(draftChangesFlow(FLOW, draftFromFlow(FLOW))).toBe(false);
    });

    it('reordering connections, which carries no meaning, is no change', () => {
        const flow: AgentFlow = {
            nodes: [...FLOW.nodes, { key: 'read-2', kind: 'read', label: 'Read risks', tool: 'list_risks' }],
            edges: [
                { from: 'read-1', to: 'synthesis-1' },
                { from: 'read-2', to: 'synthesis-1' },
            ],
        };
        const draft = draftFromFlow(flow);
        draft.edges.reverse();
        expect(draftChangesFlow(flow, draft)).toBe(false);
    });

    it('a changed label, tool or connection is a change', () => {
        const relabelled = draftFromFlow(FLOW);
        relabelled.nodes[0].label = 'Read the posture';
        expect(draftChangesFlow(FLOW, relabelled)).toBe(true);
        const unconnected = draftFromFlow(FLOW);
        unconnected.edges = [];
        expect(draftChangesFlow(FLOW, unconnected)).toBe(true);
    });
});

describe('layout and logic kept apart', () => {
    it('moving a step changes the layout and never the flow', () => {
        const draft = draftFromFlow(FLOW);
        const before = layoutForDraft(draft);
        const after = layoutForDraft(draft, { 'read-1': { x: before['read-1'].x + 400, y: 900 } });
        expect(after['read-1']).toEqual({ x: before['read-1'].x + 400, y: 900 });
        expect(after['synthesis-1']).toEqual(before['synthesis-1']);
        // The flow the save would send is untouched by any layout.
        expect(draftChangesFlow(FLOW, draft)).toBe(false);
    });

    it('the save body carries the flow and no position, and the layout carries no logic', () => {
        const draft = draftFromFlow(FLOW);
        const layout = layoutForDraft(draft, { 'read-1': { x: 1, y: 2 } });
        const body = flowVersionBody(BASE, draft);
        const text = JSON.stringify(body);
        expect(text).not.toMatch(/"(x|y|position|positions|layout)":/);
        expect(body).not.toHaveProperty('toolNames');
        for (const at of Object.values(layout)) expect(Object.keys(at).sort()).toEqual(['x', 'y']);
    });

    it('the save body is the edited version whole, with only the flow replaced', () => {
        const body = flowVersionBody(BASE, draftFromFlow(FLOW));
        expect(body).toEqual({ ...BASE, flow: FLOW });
    });

    it('the layout is deterministic for a draft', () => {
        expect(layoutForDraft(draftFromFlow(FLOW))).toEqual(layoutForDraft(draftFromFlow(FLOW)));
    });
});

describe('the palette offers the flow kinds and no checkpoint', () => {
    it('is exactly read, propose, synthesis and subagent', () => {
        expect([...AGENT_FLOW_PALETTE]).toEqual(['read', 'propose', 'synthesis', 'subagent']);
        expect(AGENT_FLOW_PALETTE).not.toContain('checkpoint');
    });

    it('a new step gets a free key the server accepts', () => {
        const draft = draftFromFlow(FLOW);
        expect(nextNodeKey(draft, 'read')).toBe('read-2');
        expect(nextNodeKey(draft, 'propose')).toBe('propose-1');
    });
});

describe('diagnostics are the server rules, shown before save', () => {
    const codes = (draft: FlowDraft, ctx = CTX) => diagnoseFlowDraft(draft, ctx).map((d) => d.code);

    it('a valid draft has none, and the server schema accepts it', () => {
        expect(codes(draftFromFlow(FLOW))).toEqual([]);
        expect(checkAgentFlow(flowFromDraft(draftFromFlow(FLOW))).ok).toBe(true);
    });

    it('a cycle is named with the writer’s own reason', () => {
        const draft = draftFromFlow(FLOW);
        draft.edges.push({ from: 'synthesis-1', to: 'read-1' });
        const server = checkAgentFlow(flowFromDraft(draft));
        expect(server.ok).toBe(false);
        expect(codes(draft)).toEqual([server.ok ? 'none' : server.reason]);
        expect(codes(draft)).toEqual(['FLOW_CYCLE']);
    });

    it('a tool the agent is not granted is refused by name, on its step', () => {
        const draft = draftFromFlow(FLOW);
        draft.nodes[0].tool = 'list_vendors';
        expect(diagnoseFlowDraft(draft, CTX)).toEqual([{ code: 'TOOL_NOT_GRANTED', nodeKey: 'read-1' }]);
    });

    it('too many steps is refused', () => {
        const nodes = Array.from({ length: FLOW_MAX_NODES + 1 }, (_, i) => ({
            key: `read-${i + 1}`,
            kind: 'read' as const,
            label: 'Read',
            tool: 'get_compliance_posture',
        }));
        expect(codes({ nodes, edges: [] })).toContain('FLOW_TOO_MANY_NODES');
    });

    it('a subagent must name another approved profile, never its own', () => {
        const sub = (profileRef: string): FlowDraft => ({
            nodes: [...draftFromFlow(FLOW).nodes, { key: 'subagent-1', kind: 'subagent', label: 'Delegate', profileRef }],
            edges: [],
        });
        expect(codes(sub('prof-self'))).toEqual(['FLOW_SUBAGENT_SELF']);
        expect(codes(sub('prof-unknown'))).toEqual(['FLOW_SUBAGENT_NOT_APPROVED']);
        expect(codes(sub('prof-other'))).toEqual([]);
    });

    it('a propose step in an answer-only version is refused', () => {
        const draft: FlowDraft = {
            nodes: [{ key: 'propose-1', kind: 'propose', label: 'Propose', tool: 'propose_finding' }],
            edges: [],
        };
        expect(codes(draft, { ...CTX, outputKind: 'ANSWER_ONLY' })).toEqual(['FLOW_OUTPUT_KIND_CONFLICT']);
        expect(codes(draft)).toEqual([]);
    });

    it('a step with no tool or no label says so', () => {
        const draft: FlowDraft = { nodes: [{ key: 'read-1', kind: 'read', label: ' ' }], edges: [] };
        expect(codes(draft).sort()).toEqual(['FLOW_LABEL_EMPTY', 'FLOW_STEP_NEEDS_TOOL']);
    });

    it('an empty draft is not a flow', () => {
        expect(codes({ nodes: [], edges: [] })).toEqual(['FLOW_EMPTY']);
    });
});

describe('the approver’s diff', () => {
    it('names every step added, removed and changed, and every connection', () => {
        const after: AgentFlow = {
            nodes: [
                { key: 'read-1', kind: 'read', label: 'Read the posture', tool: 'get_compliance_posture' },
                { key: 'read-2', kind: 'read', label: 'Read risks', tool: 'list_risks' },
            ],
            edges: [{ from: 'read-1', to: 'read-2' }],
        };
        const diff = diffFlows(FLOW, after);
        expect(diff.nodes).toEqual({ 'read-1': 'changed', 'read-2': 'added', 'synthesis-1': 'removed' });
        expect(diff.edgesAdded).toEqual(['read-1->read-2']);
        expect(diff.edgesRemoved).toEqual(['read-1->synthesis-1']);
        expect(diff.same).toBe(false);
    });

    it('the same flow is no change', () => {
        expect(diffFlows(FLOW, FLOW).same).toBe(true);
    });
});
