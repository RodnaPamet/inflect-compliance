/**
 * THE FLUE ENGINE BINDS THE RESOLVER'S DELEGATION VALUE (#4594).
 *
 * The delegation cap Flue's interceptor enforces is the delegations half of
 * the org-level turn caps: the lower of the organization's ceiling and the
 * workspace's narrowing, read through `readTurnCaps`, which replaced
 * `readFanOutCap`. The driver puts that value into the run binding where the
 * workspace column alone used to go; `delegation-gate.ts` is unchanged.
 *
 * `bindRun` is captured where the engine hands the binding over, as
 * `flue-caps-bind-mid-dispatch.test.ts` captures it.
 */
const mockObservers: Array<(event: unknown, ctx: unknown) => void> = [];
let mockRead: () => Promise<{ text?: string; metadata?: Record<string, unknown> }>;
/** The tools `flueToolsFor` offers — set per test. */
let offeredTools: unknown[] = [];
/** The WRAPPED tools the engine bound, captured from `bindRun`. */
let boundTools: Array<{ run: (c: unknown) => Promise<unknown> }> = [];
/** The delegation cap the engine bound. */
let boundFanOut: number | undefined;

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
    bindRun: jest.fn((_runId: string, binding: { tools: unknown[]; maxSubagentsPerTurn?: number }) => {
        boundTools = binding.tools as typeof boundTools;
        boundFanOut = binding.maxSubagentsPerTurn;
    }),
}));
/** What the turn caps' read answers, per test (#4594). */
let mockTurnCapsInput: unknown = null;
let mockTurnCapsThrows = false;
jest.mock('@/lib/agentic/turn-caps-policy', () => ({
    readTurnCaps: jest.fn(async () => {
        const { resolveTurnCaps, failedReadTurnCaps } = jest.requireActual('@/lib/agentic/turn-caps') as typeof import('@/lib/agentic/turn-caps');
        // The real reader's failure arm: it never throws, it answers this.
        if (mockTurnCapsThrows) return failedReadTurnCaps();
        return resolveTurnCaps(mockTurnCapsInput as Parameters<typeof resolveTurnCaps>[0]);
    }),
}));
jest.mock('@/lib/agentic/flue/runtime-start', () => ({ ensureFlueRuntime: jest.fn(async () => []) }));
/** Set per test: whether the chosen model is one the runtime registered. */
let modelIsRegistered = true;
jest.mock('@/lib/agentic/flue/providers', () => ({
    flueModelIsRegistered: jest.fn(() => modelIsRegistered),
}));
jest.mock('@/lib/agentic/flue/tools-adapter', () => ({
    // `externalConnections` — see #3872; no external tool in this suite.
    flueToolsFor: jest.fn(() => ({ tools: offeredTools, omitted: [], externalConnections: [] })),
}));
/** Set per test: whether the offered tool is treated as a propose tool, and
 *  how many items a call of it proposes. */
let toolIsPropose = false;
let itemsPerProposeCall = 0;
jest.mock('@/lib/mcp/tools/propose-tools', () => ({
    isProposeTool: () => toolIsPropose,
    proposedItemCount: () => itemsPerProposeCall,
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
    updateRun: jest.fn(async () => true),
    isRunAborted: jest.fn(async () => false),
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
        fn({
            registeredAgent: { findFirst: async () => ({ aiSystemId: 'ai-system-1' }) },
            // The tenant's own approved skills on the workflow (#3680): none.
            tenantSkillVersion: { findMany: async () => [] },
        }),
    ),
}));

import { executeFlueRun } from '@/lib/agentic/flue/execute';
import { readTurnCaps } from '@/lib/agentic/turn-caps-policy';
import { makeRequestContext } from '../helpers/make-context';

import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

const CTX: RequestContext = { ...makeRequestContext('ADMIN'), agentId: 'agent-1' };
const DEF = { key: 'k', label: 'K', steps: [{ kind: 'READ', tool: 'list_risks', label: 'read' }] } as unknown as WorkflowDefinition;

const aTool = {
    name: 'list_risks',
    description: 'List risks.',
    input: {},
    annotations: { readOnlyHint: true },
    run: async () => '{}',
};

beforeEach(() => {
    jest.clearAllMocks();
    mockObservers.length = 0;
    offeredTools = [aTool];
    boundTools = [];
    boundFanOut = undefined;
    modelIsRegistered = true;
    toolIsPropose = false;
    itemsPerProposeCall = 0;
    mockTurnCapsThrows = false;
    mockRead = async () => ({ text: 'done', metadata: {} });
});

async function bound(input: unknown): Promise<number | undefined> {
    mockTurnCapsInput = input;
    await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');
    return boundFanOut;
}

describe('the Flue run binding carries the resolver\'s delegation value', () => {
    it('reads the turn caps for the run\'s own tenant', async () => {
        await bound({ organization: null, workspace: null });
        expect(readTurnCaps).toHaveBeenCalledWith(CTX.tenantId, CTX.requestId);
    });

    it('the organization\'s ceiling, when the workspace has not narrowed', async () => {
        expect(await bound({ organization: { delegationsPerTurn: 5, toolCallsPerTurn: 1 }, workspace: null })).toBe(5);
    });

    it('the organization\'s LOWER ceiling over a workspace value above it', async () => {
        expect(
            await bound({
                organization: { delegationsPerTurn: 1, toolCallsPerTurn: 1 },
                workspace: { delegationsPerTurn: 3, toolCallsPerTurn: null },
            }),
        ).toBe(1);
    });

    it('the workspace\'s narrowing under the ceiling', async () => {
        expect(
            await bound({
                organization: { delegationsPerTurn: 5, toolCallsPerTurn: 1 },
                workspace: { delegationsPerTurn: 0, toolCallsPerTurn: null },
            }),
        ).toBe(0);
    });

    it('a failed read binds no delegation', async () => {
        mockTurnCapsThrows = true;
        expect(await bound(null)).toBe(0);
    });
});
