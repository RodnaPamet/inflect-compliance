/**
 * The agent view mounted on a REAL tldraw editor (Phase 2.2,
 * docs/ai-architecture/langflow.md).
 *
 * The properties that matter are about the store, so the store is what is
 * read: one shape per graph node and one arrow per edge, a narrowing carried on
 * its node, an advisory order drawn dashed, and an editor in read-only mode
 * that refuses a shape a user tries to add. Nothing here is a snapshot of
 * markup; tldraw's own rendering is tldraw's to test.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

installTldrawJsdomShims();

jest.mock('next-intl', () => ({
    useTranslations: () => (key: string) => key,
    useLocale: () => 'en',
}));

import { act, render } from '@testing-library/react';
import { createShapeId, type Editor } from 'tldraw';

import { AgentCanvasView } from '@/components/processes/agent-view/AgentCanvasView';
import { AGENT_VIEW_NODE_SHAPE_TYPE } from '@/components/processes/agent-view/AgentViewNodeShapeUtil';
import type { AgentCanvasProjection } from '@/lib/agentic/agent-canvas-projection';
import { buildAgentViewGraph } from '@/lib/processes/agent-view/agent-canvas-graph';
import { buildAgentViewDiff, type AgentViewDiff } from '@/lib/processes/agent-view/agent-canvas-diff';

const PROJECTION: AgentCanvasProjection = {
    agent: { id: 'a1', name: 'Posture agent', status: 'ACTIVE', autonomyLevel: 2, riskTier: 'LOW', effectiveCeiling: 2 },
    envelope: {
        grants: [
            { name: 'get_compliance_posture', capability: 'read', requiredAutonomy: 1, withinCeiling: true },
            { name: 'propose_controls', capability: 'propose', requiredAutonomy: 2, withinCeiling: true },
        ],
        policyCardVersion: null,
        breakerState: null,
        killScope: null,
    },
    profile: {
        state: 'SHOWN',
        version: 1,
        status: 'APPROVED',
        inForce: true,
        runAs: 'RUN',
        modelTier: 'balanced',
        effort: 'medium',
        maxTurns: 8,
        outputKind: 'ANSWER_ONLY',
        readOnly: true,
        allowedTriggers: ['ASK'],
        tools: [
            { name: 'get_compliance_posture', offered: true },
            { name: 'propose_controls', offered: false, reason: 'READ_ONLY_WORKFLOW' },
        ],
        skills: [],
        instructions: 'x',
    },
    workflows: [
        {
            key: 'posture-review',
            name: 'Posture review',
            orderEnforced: false,
            steps: [
                { kind: 'READ', label: 'posture', tool: 'get_compliance_posture' },
                { kind: 'SYNTHESIS', label: 'summary', tool: null },
            ],
        },
    ],
    usedIn: [],
};

async function mount(diff: AgentViewDiff | null = null, projection: AgentCanvasProjection = PROJECTION): Promise<Editor> {
    let editor: Editor | undefined;
    await act(async () => {
        render(
            <div style={{ width: 800, height: 600 }}>
                <AgentCanvasView projection={projection} diff={diff} onEditorReady={(e) => (editor = e)} />
            </div>,
        );
    });
    if (!editor) throw new Error('the view did not finish mounting');
    return editor;
}

type Shape = { id: string; type: string; props: Record<string, unknown> };
const shapes = (editor: Editor) =>
    editor.store.allRecords().filter((r) => r.typeName === 'shape') as unknown as Shape[];

describe('the agent view on a live editor', () => {
    it('draws one node per graph node and one arrow per edge', async () => {
        const editor = await mount();
        const graph = buildAgentViewGraph(PROJECTION);
        expect(shapes(editor).filter((s) => s.type === AGENT_VIEW_NODE_SHAPE_TYPE)).toHaveLength(graph.nodes.length);
        expect(shapes(editor).filter((s) => s.type === 'arrow')).toHaveLength(graph.edges.length);
    });

    it('carries the narrowing on the node it narrows', async () => {
        const editor = await mount();
        const narrowed = editor.getShape(createShapeId('tool:propose_controls')) as unknown as Shape;
        expect(narrowed.props.reason).toBe('reason.READ_ONLY_WORKFLOW');
        const offered = editor.getShape(createShapeId('tool:get_compliance_posture')) as unknown as Shape;
        expect(offered.props.reason).toBeNull();
    });

    it('draws an advisory step order dashed, and a relation solid', async () => {
        const editor = await mount();
        const order = editor.getShape(createShapeId('edge:wf:posture-review:0->wf:posture-review:1')) as unknown as Shape;
        expect(order.props.dash).toBe('dashed');
        const spoke = editor.getShape(createShapeId('edge:hub->tool:get_compliance_posture')) as unknown as Shape;
        expect(spoke.props.dash).toBe('solid');
    });

    it('is read-only: a shape a user tries to add is refused, and nothing is drawn with', async () => {
        const editor = await mount();
        expect(editor.getInstanceState().isReadonly).toBe(true);
        const before = shapes(editor).length;
        act(() => {
            editor.createShapes([{ id: createShapeId('intruder'), type: 'geo', x: 0, y: 0 }]);
        });
        expect(shapes(editor)).toHaveLength(before);
    });
});

describe('the approver\'s diff on a live editor (Phase 2.4)', () => {
    if (PROJECTION.profile.state !== 'SHOWN') throw new Error('fixture');
    const UNDER_REVIEW: AgentCanvasProjection = {
        ...PROJECTION,
        profile: {
            ...PROJECTION.profile,
            version: 2,
            status: 'SUBMITTED',
            inForce: false,
            modelTier: 'deep',
            allowedTriggers: ['TEST_RUN'],
            tools: [{ name: 'get_compliance_posture', offered: true }],
        },
    };

    it('draws the version under review with what it removed, each change marked on its node', async () => {
        const diff = buildAgentViewDiff(PROJECTION, UNDER_REVIEW);
        if (!diff) throw new Error('expected a diff');
        const editor = await mount(diff, UNDER_REVIEW);
        expect(shapes(editor).filter((s) => s.type === AGENT_VIEW_NODE_SHAPE_TYPE)).toHaveLength(diff.graph.nodes.length);
        // The trigger the version removed is on the canvas, marked, with its change named first.
        const removed = editor.getShape(createShapeId('trigger:ASK')) as unknown as Shape;
        expect(removed.props.change).toBe('removed');
        expect((removed.props.badges as string[])[0]).toBe('diff.mark.removed');
        expect((editor.getShape(createShapeId('trigger:TEST_RUN')) as unknown as Shape).props.change).toBe('added');
        expect((editor.getShape(createShapeId('hub')) as unknown as Shape).props.change).toBe('changed');
        // Unchanged: no mark, and its badges untouched.
        const same = editor.getShape(createShapeId('tool:get_compliance_posture')) as unknown as Shape;
        expect(same.props.change).toBe('');
        expect(same.props.badges as string[]).not.toContain('diff.mark.removed');
        // A diff is drawn read-only, like the view.
        expect(editor.getInstanceState().isReadonly).toBe(true);
    });
});
