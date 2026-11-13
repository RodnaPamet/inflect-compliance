/**
 * The Tool Runner engine's request parameters are locked (Step 2b of
 * `docs/claude-tool-runner-design.md`, "The locked parameters").
 *
 * `lockedParams` is called with a real set of runnable tools and every value it
 * returns is pinned. The KEY SET is pinned too, so a parameter added to the
 * request (`mcp_servers`, `container`, `temperature`, a `thread` other than
 * false) fails here before it reaches the client, whose middleware would refuse
 * most of them at run time anyway. And only `tool-runner/execute.ts` may start
 * a runner, so these parameters are the only ones any runner is started with.
 */
jest.mock('@/env', () => ({ env: {} }));

import * as fs from 'fs';
import * as path from 'path';

import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';

import { resolveRunCaps } from '@/lib/agentic/run-caps';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';
import {
    COMPACTION_BUDGET_SHARE,
    COMPACTION_INSTRUCTION,
    COMPACTION_SUMMARY_MAX_TOKENS,
    COMPACTION_THRESHOLD_TOKENS,
    compactionParams,
    lockedParams,
    OPERATOR_INSTRUCTIONS_CLOSE,
    OPERATOR_INSTRUCTIONS_OPEN,
    SERVER_SIDE_FALLBACK_BETA,
    TOOL_RUNNER_PREAMBLE,
    DELEGATED_TASK_OPEN,
    subagentInstructionsOpen,
} from '@/lib/agentic/tool-runner/params';
import { repoFiles } from '../../helpers/repo-files';
import { codeOf } from '../../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../../..');

const tool = (name: string): BetaRunnableTool<Record<string, unknown>> => ({
    type: 'custom',
    name,
    description: `The ${name} tool.`,
    input_schema: { type: 'object', properties: {} },
    parse: (x: unknown) => x as Record<string, unknown>,
    run: async () => '{}',
});

const DEF = {
    key: 'locked',
    name: 'Locked',
    description: 'A definition.',
    driver: 'tool-runner',
    steps: [{ kind: 'READ', tool: 'list_risks', label: 'Read' }],
} as unknown as WorkflowDefinition;

const PROFILE_DEF = {
    ...DEF,
    profile: {
        profileId: 'p1',
        agentId: 'a1',
        versionId: 'v1',
        version: 1,
        instructions: 'Summarise the open risks.',
        instructionsHash: 'h',
        toolNames: ['list_risks'],
        skillRefs: [],
        modelTier: 'deep',
        effort: 'high',
        maxTurns: 7,
        outputKind: 'ANSWER_ONLY',
        allowedTriggers: ['TEST_RUN'],
    },
} as unknown as WorkflowDefinition;

describe('the Tool Runner engine\'s locked parameters', () => {
    const tools = [tool('list_risks'), tool('list_controls')];
    const caps = resolveRunCaps(null);
    const params = lockedParams({ def: DEF, tools, message: 'Go.', caps, fromSeq: 0, toolCallsPerTurn: 1 });

    it('sends no server-held thread, and does not stream', () => {
        expect(params.thread).toBe(false);
        expect(params.stream).toBe(false);
    });

    it('asks for one tool call per turn at a cap of one, byte for byte the request it always sent', () => {
        expect(params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
        // The serialised bytes, not only the value: the request on the wire is
        // what the org-level cap's default must leave unchanged (#4594).
        expect(JSON.stringify(params.tool_choice)).toBe('{"type":"auto","disable_parallel_tool_use":true}');
    });

    it('lets the model ask for several calls in one turn above a cap of one (#4594)', () => {
        for (const cap of [2, 10]) {
            const p = lockedParams({ def: DEF, tools, message: 'Go.', caps, fromSeq: 0, toolCallsPerTurn: cap });
            expect(JSON.stringify(p.tool_choice)).toBe('{"type":"auto","disable_parallel_tool_use":false}');
        }
        // Anything that is not a number above one reads as one: never parallel by accident.
        for (const cap of [0, -1, Number.NaN]) {
            const p = lockedParams({ def: DEF, tools, message: 'Go.', caps, fromSeq: 0, toolCallsPerTurn: cap });
            expect(p.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
        }
    });

    it('offers exactly the run\'s tools: no server tool, nothing added', () => {
        expect(params.tools).toEqual(tools);
        for (const t of params.tools) expect((t as { type?: string }).type).toBe('custom');
    });

    it('thinks adaptively and shows a summary, at an explicit effort, with the fallback beta', () => {
        expect(params.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(params.output_config).toEqual({ effort: 'medium' });
        expect(params.fallbacks).toBe('default');
        expect(params.betas).toEqual([SERVER_SIDE_FALLBACK_BETA]);
    });

    it('bounds iterations by the run\'s step cap', () => {
        expect(params.max_iterations).toBe(caps.STEPS.limit);
        expect(lockedParams({ def: DEF, tools, message: 'Go.', caps, fromSeq: 3, toolCallsPerTurn: 1 }).max_iterations).toBe(caps.STEPS.limit - 3);
    });

    it('opens the conversation with the run message alone', () => {
        expect(params.messages).toEqual([{ role: 'user', content: 'Go.' }]);
    });

    it('carries no other parameter: no sampling knob, no MCP connector, no container', () => {
        expect(Object.keys(params).sort()).toEqual(
            [
                'betas',
                'fallbacks',
                'max_iterations',
                'max_tokens',
                'messages',
                'model',
                'output_config',
                'stream',
                'system',
                'thinking',
                'thread',
                'tool_choice',
                'tools',
            ].sort(),
        );
    });

    it('a definition with no profile gets the fixed preamble, cached', () => {
        expect(params.system).toEqual([{ type: 'text', text: TOOL_RUNNER_PREAMBLE, cache_control: { type: 'ephemeral' } }]);
    });

    it('a profile\'s instructions follow the preamble, fenced as the operator\'s, and its tier, effort and turns apply', () => {
        const p = lockedParams({ def: PROFILE_DEF, tools, message: 'Go.', caps, fromSeq: 0, toolCallsPerTurn: 1 });
        const [block] = p.system as Array<{ text: string; cache_control: unknown }>;
        expect(block.text.startsWith(TOOL_RUNNER_PREAMBLE)).toBe(true);
        const open = block.text.indexOf(OPERATOR_INSTRUCTIONS_OPEN);
        const close = block.text.indexOf(OPERATOR_INSTRUCTIONS_CLOSE);
        expect(block.text.slice(open + OPERATOR_INSTRUCTIONS_OPEN.length, close).trim()).toBe('Summarise the open risks.');
        expect(block.cache_control).toEqual({ type: 'ephemeral' });
        expect(p.model).toBe('claude-opus-5-5');
        expect(p.output_config).toEqual({ effort: 'high' });
        expect(p.max_iterations).toBe(7);
    });
});

describe('a sub-agent\'s runner is shaped by the same function (Step 2e, #4594)', () => {
    const tools = [tool('list_risks')];
    const caps = resolveRunCaps(null);
    const SUB = { name: 'risk_reader', instructions: 'Read the risks and list them.', maxTurns: 3, task: 'List the open risks.' };

    it('a version with no sub-agents gets exactly the parameters it got before: no delegate, no sub-agent text', () => {
        const before = lockedParams({ def: PROFILE_DEF, tools, message: 'Go.', caps, fromSeq: 0, toolCallsPerTurn: 1 });
        const [block] = before.system as Array<{ text: string }>;
        expect(block.text).not.toContain('sub-agent');
        expect(before.tools.map((t) => (t as { name: string }).name)).toEqual(['list_risks']);
        expect(before.messages).toEqual([{ role: 'user', content: 'Go.' }]);
        expect(before.max_iterations).toBe(7);
    });

    it('pins the child\'s values: no thread, the parent\'s tier, effort, thinking, tool choice and fallbacks', () => {
        const parent = lockedParams({ def: PROFILE_DEF, tools, message: 'Go.', caps, fromSeq: 0, toolCallsPerTurn: 1 });
        const child = lockedParams({ def: PROFILE_DEF, tools, message: '', caps, fromSeq: 0, toolCallsPerTurn: 1, subagent: SUB });
        expect(Object.keys(child).sort()).toEqual(Object.keys(parent).sort());
        for (const key of ['thread', 'stream', 'model', 'max_tokens', 'tool_choice', 'thinking', 'output_config', 'fallbacks', 'betas'] as const) {
            expect({ key, value: child[key] }).toEqual({ key, value: parent[key] });
        }
    });

    it('runs the sub-agent\'s own instructions, fenced and named, and the task as its one message', () => {
        const child = lockedParams({ def: PROFILE_DEF, tools, message: 'the parent message', caps, fromSeq: 0, toolCallsPerTurn: 1, subagent: SUB });
        const [block] = child.system as Array<{ text: string }>;
        expect(block.text.startsWith(TOOL_RUNNER_PREAMBLE)).toBe(true);
        expect(block.text).toContain(subagentInstructionsOpen('risk_reader'));
        expect(block.text).toContain('Read the risks and list them.');
        expect(block.text).toContain('You cannot delegate.');
        // The parent's instructions are not the child's.
        expect(block.text).not.toContain('Summarise the open risks.');
        expect(child.messages).toHaveLength(1);
        const content = String(child.messages[0].content);
        expect(content).toContain(DELEGATED_TASK_OPEN);
        expect(content).toContain('List the open risks.');
        expect(content).not.toContain('the parent message');
    });

    it('bounds the child\'s iterations by the lower of its turns and the steps the run has left', () => {
        expect(lockedParams({ def: PROFILE_DEF, tools, message: '', caps, fromSeq: 0, toolCallsPerTurn: 1, subagent: SUB }).max_iterations).toBe(3);
        const nearlySpent = caps.STEPS.limit - 2;
        expect(
            lockedParams({ def: PROFILE_DEF, tools, message: '', caps, fromSeq: nearlySpent, toolCallsPerTurn: 1, subagent: SUB }).max_iterations,
        ).toBe(2);
    });
});

describe('the summary request of a compaction is shaped here too, and pinned (Step 2g, #5531)', () => {
    const tools = [tool('list_risks'), tool('activate_skill')];
    const caps = resolveRunCaps(null);
    const runner = lockedParams({ def: PROFILE_DEF, tools, message: 'Go.', caps, fromSeq: 0, toolCallsPerTurn: 1 });
    const history = [
        { role: 'user' as const, content: 'Go.' },
        { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id: 't1', name: 'list_risks', input: {} }] },
        { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't1', content: '{}' }] },
    ];
    const summary = compactionParams(runner, history);

    it('pins the threshold constants: 150,000 per tier, 15% of TOKENS, a 4,000-token summary', () => {
        expect(COMPACTION_THRESHOLD_TOKENS).toEqual({ balanced: 150_000, deep: 150_000 });
        expect(COMPACTION_BUDGET_SHARE).toBe(0.15);
        expect(COMPACTION_SUMMARY_MAX_TOKENS).toBe(4_000);
        expect(COMPACTION_INSTRUCTION.split('\n').at(-1)).toBe('Write the summary as plain text. Do not call a tool.');
    });

    it('keeps the run\'s system, tools, model, thinking, effort and fallbacks, so the cached prefix and every thinking block hold', () => {
        for (const key of ['model', 'system', 'thinking', 'output_config', 'fallbacks', 'betas', 'stream'] as const) {
            expect({ key, value: summary[key] }).toEqual({ key, value: runner[key] });
        }
        // The tools as the API receives them: every API field, no function.
        expect(JSON.stringify(summary.tools)).toBe(JSON.stringify(runner.tools));
        expect(summary.tools.every((t) => Object.values(t).every((v) => typeof v !== 'function'))).toBe(true);
    });

    it('calls no tool, holds no thread, and appends Inflect\'s instruction to the history unchanged', () => {
        expect(summary.tool_choice).toEqual({ type: 'none' });
        expect(summary.max_tokens).toBe(COMPACTION_SUMMARY_MAX_TOKENS);
        expect(summary.messages).toEqual([...history, { role: 'user', content: COMPACTION_INSTRUCTION }]);
        expect(Object.keys(summary).sort()).toEqual(
            ['betas', 'fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'stream', 'system', 'thinking', 'tool_choice', 'tools'].sort(),
        );
    });
});

describe('only the engine\'s loop starts a runner', () => {
    it('`toolRunner(` and `BetaToolRunner` appear in src/ only in tool-runner/execute.ts', () => {
        const files = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] });
        // Positive control: the population is the source tree, not nothing.
        expect(files.length).toBeGreaterThan(100);
        const starters = files
            .filter((f) => /\.toolRunner\(|\bnew BetaToolRunner\b/.test(codeOf(fs.readFileSync(f, 'utf8'))))
            .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
        expect(starters).toEqual(['src/lib/agentic/tool-runner/execute.ts']);
    });
});
