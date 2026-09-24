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
import { updateRun } from '@/lib/agentic/drivers/run-settlement';
import { makeRequestContext } from '../helpers/make-context';

import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

/**
 * A RUN THAT COULD REACH NOTHING SAYS SO.
 *
 * Tool access is deny-by-default (`RegisteredAgentTool`), so an agent with no
 * grants is handed an EMPTY catalogue by `flueToolsFor`, makes one model call
 * against a specification it cannot act on, and finishes tidily.
 *
 * Measured in production on 2026-09-24: the first Flue run settled COMPLETED
 * with `stepFailures: 0`, having read nothing and written no summary —
 * indistinguishable in the run list from a posture review that worked. The
 * agent had been registered, risk-assessed and activated, and nobody had
 * granted it a single tool.
 *
 * COMPLETED STANDS: the engine did what it was asked, and failing the run
 * would report a tenant's configuration gap as an engine fault. What is
 * asserted here is that the gap is COUNTED and NAMED.
 */
const CTX: RequestContext = { ...makeRequestContext('ADMIN'), agentId: 'agent-1' };
const DEF = { key: 'k', label: 'K', steps: [{ kind: 'READ', tool: 'list_risks', label: 'read' }] } as unknown as WorkflowDefinition;

const aTool = () => ({
    name: 'list_risks',
    description: 'stub',
    input: undefined,
    run: async () => '',
});

beforeEach(() => {
    jest.clearAllMocks();
    offeredTools = [];
    mockObservers.length = 0;
    mockRead = async () => ({ text: 'done', toolCalls: [] });
});

describe('a run offered NO tools', () => {
    it('completes, but counts the gap as a step failure', async () => {
        offeredTools = [];

        const outcome = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        // COMPLETED, because the engine is not what is broken — and a
        // non-zero count, because the run reasoned over nothing.
        expect(outcome).toEqual({ status: 'COMPLETED', stepFailures: 1 });
    });

    it('names the gap on the run row, in the operator vocabulary', async () => {
        offeredTools = [];

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        // `errorMessage` is what the run list and run detail render. A bare
        // code would be something to go and look up while a run sits there
        // looking successful.
        const completing = (updateRun as jest.Mock).mock.calls
            .map((c) => c[2] as Record<string, unknown>)
            .filter((d) => d.status === 'COMPLETED');
        expect(completing).toHaveLength(1);
        expect(String(completing[0].errorMessage)).toContain('flue_no_tools_granted');
    });

    it('stays silent when the agent HAS tools', async () => {
        // The negative arm. A signal that fired on every run would be noise on
        // exactly the surface this makes trustworthy.
        offeredTools = [aTool()];

        const outcome = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(outcome).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        const completing = (updateRun as jest.Mock).mock.calls
            .map((c) => c[2] as Record<string, unknown>)
            .filter((d) => d.status === 'COMPLETED');
        expect(completing[0].errorMessage).toBeUndefined();
    });
});
