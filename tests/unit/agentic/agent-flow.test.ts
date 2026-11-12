/**
 * THE AGENT FLOW AS DATA (Phase 1 of `docs/ai-architecture/langflow.md`).
 *
 * `src/lib/agentic/agent-flow.ts` is pure, so each graph rule is proved here
 * against the checker itself; the writer, the hash and the database are proved
 * in `tests/integration/agent-profile-flow.test.ts`.
 */
import {
    checkAgentFlow,
    compileFlow,
    describeFlowForReview,
    flowToolNames,
    flowToolsAgree,
    FLOW_MAX_NODES,
    parseStoredAgentFlow,
    serializeAgentFlow,
    topologicalOrder,
    type AgentFlow,
} from '@/lib/agentic/agent-flow';
import { runMessage } from '@/lib/agentic/flue/run-message';
import { AgentProfileVersionSchema } from '@/app-layer/schemas/agent-profile.schemas';
import type { WorkflowDefinition, ProfileRunSpec } from '@/lib/agentic/workflow-types';
import { assertEngineRunsProfiles } from '@/app-layer/usecases/agent-profile-runs';

const READ = (key: string, tool = 'list_risks') => ({ key, kind: 'read' as const, label: `read ${key}`, tool });
const PROPOSE = (key: string, tool = 'propose_risks') => ({ key, kind: 'propose' as const, label: `propose ${key}`, tool });
const SYNTH = (key: string) => ({ key, kind: 'synthesis' as const, label: `answer ${key}` });

function ok(raw: unknown): AgentFlow {
    const r = checkAgentFlow(raw);
    if (!r.ok) throw new Error(`expected a valid flow, got ${r.reason}`);
    return r.flow;
}
function reason(raw: unknown): string {
    const r = checkAgentFlow(raw);
    return r.ok ? 'OK' : r.reason;
}

describe('a flow is a bounded acyclic graph', () => {
    it('a cycle is refused', () => {
        const nodes = [READ('a'), READ('b'), SYNTH('c')];
        expect(reason({ nodes, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] })).toBe('OK');
        expect(reason({ nodes, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }] })).toBe('FLOW_CYCLE');
        expect(topologicalOrder({ nodes, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] })).toBeNull();
    });

    it('a step cannot follow itself, and a connection names steps the flow has', () => {
        expect(reason({ nodes: [READ('a')], edges: [{ from: 'a', to: 'a' }] })).toBe('FLOW_SELF_EDGE');
        expect(reason({ nodes: [READ('a')], edges: [{ from: 'a', to: 'ghost' }] })).toBe('FLOW_UNKNOWN_EDGE_END');
        expect(reason({ nodes: [READ('a'), READ('a')], edges: [] })).toBe('FLOW_DUPLICATE_KEY');
        expect(reason({ nodes: [READ('a'), SYNTH('b')], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }] })).toBe(
            'FLOW_DUPLICATE_EDGE',
        );
    });

    it('a flow has at most as many steps as a run may take', () => {
        const at = Array.from({ length: FLOW_MAX_NODES }, (_, i) => READ(`n${i}`));
        expect(reason({ nodes: at, edges: [] })).toBe('OK');
        expect(reason({ nodes: [...at, READ('one-more')], edges: [] })).toBe('FLOW_TOO_MANY_NODES');
    });

    it('offers no checkpoint kind until an engine enforces one (D-L2-2)', () => {
        expect(reason({ nodes: [READ('a'), { key: 'gate', kind: 'checkpoint', label: 'a human approves' }], edges: [] })).toBe(
            'FLOW_CHECKPOINT_UNENFORCED',
        );
    });

    it('anything the flow does not name is refused, never dropped', () => {
        expect(reason({ nodes: [{ ...READ('a'), scope: 'admin:*' }], edges: [] })).toBe('FLOW_INVALID');
        expect(reason({ nodes: [READ('a')], edges: [], grants: ['propose_risks'] })).toBe('FLOW_INVALID');
        expect(reason({ nodes: [{ key: 'a', kind: 'synthesis', label: 'x', tool: 'list_risks' }], edges: [] })).toBe('FLOW_INVALID');
        expect(reason({ nodes: [{ key: 'a', kind: 'subagent', label: 'x' }], edges: [] })).toBe('FLOW_INVALID');
    });
});

describe('tools only narrow, and are one list', () => {
    it("a step's tool is of the step's kind", () => {
        expect(reason({ nodes: [READ('a', 'propose_risks')], edges: [] })).toBe('FLOW_TOOL_KIND_MISMATCH');
        expect(reason({ nodes: [READ('a'), PROPOSE('b', 'list_controls')], edges: [] })).toBe('FLOW_TOOL_KIND_MISMATCH');
        // An unknown name is never waved through as a read.
        expect(reason({ nodes: [READ('a', 'not_a_tool')], edges: [] })).toBe('FLOW_TOOL_KIND_MISMATCH');
    });

    it('a flow that names no tool is refused', () => {
        expect(reason({ nodes: [SYNTH('a')], edges: [] })).toBe('FLOW_NAMES_NO_TOOL');
    });

    it("the version's tools are derived from the flow, deduplicated and sorted", () => {
        const flow = ok({ nodes: [READ('a', 'list_risks'), READ('b', 'list_controls'), READ('c', 'list_risks'), SYNTH('d')], edges: [] });
        expect(flowToolNames(flow)).toEqual(['list_controls', 'list_risks']);
        expect(flowToolsAgree(flow, ['list_risks', 'list_controls'])).toBe(true);
        expect(flowToolsAgree(flow, ['list_risks'])).toBe(false);
        expect(flowToolsAgree(flow, ['list_risks', 'list_controls', 'list_findings'])).toBe(false);
    });
});

describe('compileFlow', () => {
    it('a flow with no propose node runs read-only', () => {
        expect(compileFlow(ok({ nodes: [READ('a'), SYNTH('b')], edges: [{ from: 'a', to: 'b' }] })).readOnly).toBe(true);
        expect(compileFlow(ok({ nodes: [READ('a'), PROPOSE('b')], edges: [{ from: 'a', to: 'b' }] })).readOnly).toBe(false);
    });

    it('lists the steps in topological order, ties broken by declaration order', () => {
        const flow = ok({
            nodes: [SYNTH('answer'), READ('risks'), READ('controls', 'list_controls')],
            edges: [
                { from: 'risks', to: 'answer' },
                { from: 'controls', to: 'answer' },
            ],
        });
        expect(compileFlow(flow).stepsSpec).toEqual([
            { kind: 'READ', label: 'read risks', tool: 'list_risks' },
            { kind: 'READ', label: 'read controls', tool: 'list_controls' },
            { kind: 'SYNTHESIS', label: 'answer answer' },
        ]);
    });

    it('two requests describing the same flow store the same text', () => {
        const a = ok({ nodes: [READ('a'), SYNTH('b'), SYNTH('c')], edges: [{ from: 'a', to: 'c' }, { from: 'a', to: 'b' }] });
        const b = ok({ nodes: [{ label: 'read a', tool: 'list_risks', kind: 'read', key: 'a' }, SYNTH('b'), SYNTH('c')], edges: [{ to: 'b', from: 'a' }, { from: 'a', to: 'c' }] });
        expect(serializeAgentFlow(a)).toBe(serializeAgentFlow(b));
        expect(parseStoredAgentFlow(serializeAgentFlow(a))).toEqual(a);
    });

    it('a stored flow this build cannot read is null, never "no flow"', () => {
        expect(parseStoredAgentFlow('not json')).toBeNull();
        expect(parseStoredAgentFlow(JSON.stringify({ nodes: [READ('a'), READ('b')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }))).toBeNull();
    });

    it('the run message lists a flow whole, in order, and every other definition exactly as before', () => {
        const flow = compileFlow(ok({ nodes: [SYNTH('b'), READ('a')], edges: [{ from: 'a', to: 'b' }] }));
        const def = {
            description: 'Run an agent profile.',
            steps: [{ kind: 'SYNTHESIS', label: 'answer', synthesize: () => ({ text: '' }) }],
        } as Pick<WorkflowDefinition, 'description' | 'steps'>;
        const withFlow = runMessage({ ...def, profile: { flow } as WorkflowDefinition['profile'] });
        expect(withFlow).toContain('1. [READ] read a (tool: list_risks)\n2. [SYNTHESIS] answer b');
        expect(withFlow).not.toContain('[SYNTHESIS] answer\n');
        expect(runMessage(def)).toBe(
            'Run an agent profile.\n\nCover the following, in order. Use the tools you have been given; do not assume.\n1. [SYNTHESIS] answer',
        );
    });
});

describe('the request body', () => {
    const base = {
        instructions: 'Summarise the open risks.',
        skillRefs: [],
        modelTier: 'balanced',
        effort: 'medium',
        maxTurns: 5,
        outputKind: 'ANSWER_ONLY',
        allowedTriggers: ['TEST_RUN'],
    };
    const flow = { nodes: [READ('a')], edges: [] };

    it('a version with a flow does not list its tools beside it: they are derived', () => {
        expect(AgentProfileVersionSchema.safeParse({ ...base, flow }).success).toBe(true);
        expect(AgentProfileVersionSchema.safeParse({ ...base, toolNames: ['list_risks'] }).success).toBe(true);
        const both = AgentProfileVersionSchema.safeParse({ ...base, flow, toolNames: ['list_risks'] });
        expect(both.success).toBe(false);
        expect(JSON.stringify(both.error?.issues)).toContain('FLOW_TOOLS_ARE_DERIVED');
        expect(AgentProfileVersionSchema.safeParse(base).success).toBe(false);
    });
});

describe('what the approver is shown is everything the hash covers', () => {
    const SUB = (key: string, profileRef = 'prof-rater') => ({ key, kind: 'subagent' as const, label: `delegate ${key}`, profileRef });
    const base = ok({
        nodes: [READ('a'), SUB('b'), SYNTH('c')],
        edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
    });
    const text = describeFlowForReview(base);

    it('lists every step in run order with its key, tool and profile reference, then every connection', () => {
        expect(text.split('\n')).toEqual([
            '1. [READ] read a (tool: list_risks) {a}',
            '2. [SUBAGENT] delegate b {b} (profile: prof-rater)',
            '3. [SYNTHESIS] answer c {c}',
            '',
            'a -> b',
            'b -> c',
        ]);
    });

    it('a change to any stored fact of the flow changes the text the reviewer reads', () => {
        const variants: AgentFlow[] = [
            ok({ nodes: [{ ...READ('a'), label: 'read a, and every owner email' }, SUB('b'), SYNTH('c')], edges: base.edges }),
            ok({ nodes: [READ('a', 'list_controls'), SUB('b'), SYNTH('c')], edges: base.edges }),
            ok({ nodes: [READ('a'), SUB('b', 'prof-other'), SYNTH('c')], edges: base.edges }),
            ok({ nodes: [READ('a'), SUB('b'), SYNTH('c')], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] }),
            ok({ nodes: [READ('a'), SUB('b'), SYNTH('c')], edges: [{ from: 'b', to: 'c' }] }),
        ];
        for (const v of variants) {
            expect(serializeAgentFlow(v)).not.toBe(serializeAgentFlow(base));
            expect(describeFlowForReview(v)).not.toBe(text);
        }
    });

    it('a flow with no connections says so rather than showing nothing', () => {
        expect(describeFlowForReview(ok({ nodes: [READ('a')], edges: [] })).split('\n').at(-1)).toBe('(no connections)');
    });
});

describe('admission: a drawn flow runs on no engine before Phase 5', () => {
    const spec = (flow?: ProfileRunSpec['flow']): ProfileRunSpec =>
        ({ ...(flow ? { flow } : {}) }) as unknown as ProfileRunSpec;
    const reasonOfCall = (fn: () => void): string => {
        try {
            fn();
        } catch (err) {
            return String((err as { details?: { reason?: unknown } }).details?.reason);
        }
        return 'NO_REFUSAL';
    };

    it('a subagent step is never handed to an engine that cannot delegate: every engine refuses the flow', () => {
        const compiled = compileFlow(ok({ nodes: [READ('a'), { key: 'b', kind: 'subagent', label: 'rate', profileRef: 'p' }], edges: [] }));
        expect(reasonOfCall(() => assertEngineRunsProfiles('tool-runner', spec(compiled)))).toBe('PROFILE_FLOW_NOT_RUNNABLE');
        expect(reasonOfCall(() => assertEngineRunsProfiles('tool-runner', spec()))).toBe('NO_REFUSAL');
        expect(reasonOfCall(() => assertEngineRunsProfiles('static', spec(compiled)))).toBe('PROFILE_NEEDS_REASONING_ENGINE');
    });
});
