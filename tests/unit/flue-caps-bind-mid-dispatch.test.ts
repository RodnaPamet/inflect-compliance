/**
 * THE PER-RUN CAPS BIND *INSIDE* A DISPATCH, NOT ONLY BEFORE IT.
 *
 * `executeFlueRun` charges RUNTIME_MS once, before `agent.dispatch()`, and the
 * comment above that charge claims the rest is covered: "the per-tool charge
 * below bounds how far past, since every subsequent tool call re-checks."
 *
 * No subsequent call re-checked the clock. The per-tool charge covered STEPS
 * and TOOL_CALLS only, so a run that entered inside its wall clock could sit
 * in a tool-calling loop for as long as the model kept calling tools: the
 * STEPS cap bounded how MANY calls it made, never how long they took. A
 * submission is one call and nothing can interrupt a model mid-turn, so the
 * tool boundary is the only place this engine gets to look at the clock at
 * all — and it was not looking.
 *
 * ── HOW THIS DRIVES A REAL TOOL ─────────────────────────────────────────────
 *
 * `wrapForLedger` is internal, so the wrapped tool is captured where the
 * engine hands it over: `bindRun`. `mockRead` then invokes it, which is
 * exactly when the runtime would — `agent.read` is the dispatch, and a tool
 * call happens inside it. Moving `Date.now` before that call is what separates
 * a preflight-only check from a real one.
 */
const mockObservers: Array<(event: unknown, ctx: unknown) => void> = [];
let mockRead: () => Promise<{ text?: string; metadata?: Record<string, unknown> }>;
/** The tools `flueToolsFor` offers — set per test. */
let offeredTools: unknown[] = [];
/** The WRAPPED tools the engine bound, captured from `bindRun`. */
let boundTools: Array<{ run: (c: unknown) => Promise<unknown> }> = [];

jest.mock(
    '@flue/runtime',
    () => ({
        init: () => ({
            dispatch: async () => ({ submissionId: 'sub-1' }),
            read: async () => mockRead(),
        }),
        observe: (fn: (event: unknown, ctx: unknown) => void) => {
            mockObservers.push(fn);
            return () => undefined;
        },
        useInitialData: () => ({ runId: 'unused' }),
        useInstruction: () => undefined,
        useModel: () => undefined,
        useResponseFinish: () => undefined,
        useTool: () => undefined,
    }),
    { virtual: true },
);

jest.mock('@/lib/agentic/flue/run-binding', () => ({
    ...jest.requireActual('@/lib/agentic/flue/run-binding'),
    bindRun: jest.fn((_runId: string, binding: { tools: unknown[] }) => {
        boundTools = binding.tools as typeof boundTools;
    }),
}));
jest.mock('@/lib/agentic/flue/runtime-start', () => ({ ensureFlueRuntime: jest.fn(async () => []) }));
jest.mock('@/lib/agentic/flue/providers', () => ({ flueModelIsRegistered: jest.fn(() => true) }));
jest.mock('@/lib/agentic/flue/tools-adapter', () => ({
    flueToolsFor: jest.fn(() => ({ tools: offeredTools, omitted: [] })),
}));
jest.mock('@/lib/mcp/tools/propose-tools', () => ({
    isProposeTool: () => false,
    proposedItemCount: () => 0,
}));
jest.mock('@/lib/mcp/auth', () => ({
    resolveMcpInvocation: jest.fn(async () => ({ policyCard: null })),
}));
jest.mock('@/lib/agentic/drivers/run-store', () => ({
    getRunRow: jest.fn(async () => ({ costTokens: 0 })),
    proposedItemsSoFar: jest.fn(async () => 0),
}));
jest.mock('@/lib/agentic/drivers/step-recorder', () => ({ recordStep: jest.fn(async () => undefined) }));
jest.mock('@/lib/agentic/drivers/run-settlement', () => ({
    updateRun: jest.fn(async () => undefined),
    failRun: jest.fn(async () => 'FAILED'),
    haltRunAtCap: jest.fn(async () => 'FAILED'),
    haltRunAtGuard: jest.fn(async () => 'ABORTED'),
}));
jest.mock('@/lib/agentic/circuit-breaker-store', () => ({ latchOnGuardBlock: jest.fn(async () => null) }));
jest.mock('@/app-layer/ai/decision-log', () => ({
    logAiDecision: jest.fn(async () => 'decision-1'),
    computeInputDigest: (input: unknown) =>
        `sha256:${Buffer.from(JSON.stringify(input ?? null)).toString('hex').padEnd(64, '0').slice(0, 64)}`,
}));
jest.mock('@/lib/db/rls-middleware', () => ({
    // PARTIAL: `execute.ts` reaches `kill-switch.ts`, which imports the prisma
    // client, whose extension chain is built from this module. A wholesale
    // replacement makes the suite fail to LOAD — and `Tests: 0 total` reads as
    // a pass in every aggregate.
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ registeredAgent: { findFirst: async () => ({ aiSystemId: 'ai-system-1' }) } }),
    ),
}));

import { executeFlueRun } from '@/lib/agentic/flue/execute';
import { haltRunAtCap } from '@/lib/agentic/drivers/run-settlement';
import { ENGINE_RUN_CAPS } from '@/lib/agentic/run-caps';
import { makeRequestContext } from '../helpers/make-context';

import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

const CTX: RequestContext = { ...makeRequestContext('ADMIN'), agentId: 'agent-1' };
const DEF = { key: 'k', label: 'K', steps: [{ kind: 'READ', tool: 'list_risks', label: 'read' }] } as unknown as WorkflowDefinition;

/** A tool shaped as the adapter emits one. */
const aTool = (onRun: () => void) => ({
    name: 'list_risks',
    description: 'List risks.',
    input: {},
    annotations: { readOnlyHint: true },
    run: async () => {
        onRun();
        return '{}';
    },
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    mockObservers.length = 0;
    offeredTools = [];
    boundTools = [];
});

describe('the wall clock is re-checked at the tool boundary', () => {
    it('refuses a tool call made after the run has run out of wall clock', async () => {
        let ran = false;
        offeredTools = [aTool(() => { ran = true; })];
        const t0 = 1_000_000;
        const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);

        mockRead = async () => {
            // The dispatch is under way. Time passes — more than the whole
            // wall-clock budget — and then the model calls a tool.
            clock.mockReturnValue(t0 + ENGINE_RUN_CAPS.RUNTIME_MS + 1);
            await expect(boundTools[0].run({ toolCallId: 't1', data: {} })).rejects.toThrow();
            throw new Error('dispatch aborted by the cap');
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, t0, 'anthropic/claude');

        // The tool function was never entered — a pre-execution refusal, the
        // same property the policy card has at the tool boundary.
        expect(ran).toBe(false);
        expect(haltRunAtCap).toHaveBeenCalled();
    });

    it('allows a tool call made while the run is still inside its wall clock', async () => {
        // The positive control. Without it the test above passes under an
        // implementation that refuses every tool call.
        let ran = false;
        offeredTools = [aTool(() => { ran = true; })];
        const t0 = 1_000_000;
        const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);

        mockRead = async () => {
            clock.mockReturnValue(t0 + 1_000); // a second in, well inside
            await boundTools[0].run({ toolCallId: 't1', data: {} });
            return { text: 'done', metadata: {} };
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, t0, 'anthropic/claude');

        expect(ran).toBe(true);
    });
});
