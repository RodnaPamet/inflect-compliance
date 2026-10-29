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
    lockedParams,
    OPERATOR_INSTRUCTIONS_CLOSE,
    OPERATOR_INSTRUCTIONS_OPEN,
    SERVER_SIDE_FALLBACK_BETA,
    TOOL_RUNNER_PREAMBLE,
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
    const params = lockedParams({ def: DEF, tools, message: 'Go.', caps, fromSeq: 0 });

    it('sends no server-held thread, and does not stream', () => {
        expect(params.thread).toBe(false);
        expect(params.stream).toBe(false);
    });

    it('asks for one tool call per turn', () => {
        expect(params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
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
        expect(lockedParams({ def: DEF, tools, message: 'Go.', caps, fromSeq: 3 }).max_iterations).toBe(caps.STEPS.limit - 3);
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
        const p = lockedParams({ def: PROFILE_DEF, tools, message: 'Go.', caps, fromSeq: 0 });
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
