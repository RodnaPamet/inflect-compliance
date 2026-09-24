/**
 * A KILL SWITCH STOPS THE MODEL CALL, NOT ONLY THE TOOL CALLS.
 *
 * `assertNotKilled` is step 0 of `authorizeToolCall`, and that was the only
 * place the switch was consulted. On the Flue engine that is too late by one
 * model call: with a switch engaged the run still booted the runtime, assembled
 * the tenant's content into a prompt, sent it to the model provider and wrote
 * its EU AI Act Art 12 decision row. Only a TOOL call it subsequently tried to
 * make was refused — and a run that makes no tool call was never stopped.
 *
 * The platform refusal message promises an operator that "no agent is running
 * anywhere in this deployment". A model call is the agent running.
 */
const mockObservers: Array<(event: unknown, ctx: unknown) => void> = [];
let mockRead: () => Promise<{ text?: string; metadata?: Record<string, unknown> }>;
/** Set per test: what `resolveKillState` answers. */
let killState: { scope: string; switchId: string; engagedAt: Date } | null = null;
/** True once the mocked runtime was booted. */
let booted = false;
/** True once a dispatch actually happened — i.e. the prompt left for a model. */
let dispatched = false;

jest.mock(
    '@flue/runtime',
    () => ({
        init: () => ({
            dispatch: async () => {
                dispatched = true;
                return { submissionId: 'sub-1' };
            },
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

jest.mock('@/lib/agentic/kill-switch', () => ({
    ...jest.requireActual('@/lib/agentic/kill-switch'),
    resolveKillState: jest.fn(async () => killState),
}));
jest.mock('@/lib/agentic/flue/runtime-start', () => ({
    ensureFlueRuntime: jest.fn(async () => {
        booted = true;
        return [];
    }),
}));
jest.mock('@/lib/agentic/flue/providers', () => ({ flueModelIsRegistered: jest.fn(() => true) }));
jest.mock('@/lib/agentic/flue/tools-adapter', () => ({
    flueToolsFor: jest.fn(() => ({ tools: [], omitted: [] })),
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
    haltRunAtKill: jest.fn(async () => 'ABORTED'),
}));
jest.mock('@/lib/agentic/circuit-breaker-store', () => ({ latchOnGuardBlock: jest.fn(async () => null) }));
jest.mock('@/app-layer/ai/decision-log', () => ({
    logAiDecision: jest.fn(async () => 'decision-1'),
    computeInputDigest: (input: unknown) =>
        `sha256:${Buffer.from(JSON.stringify(input ?? null)).toString('hex').padEnd(64, '0').slice(0, 64)}`,
}));
jest.mock('@/lib/db/rls-middleware', () => ({
    // PARTIAL: `kill-switch.ts` imports the prisma client, whose extension
    // chain is built from this module. A wholesale replacement makes the suite
    // fail to LOAD, and `Tests: 0 total` reads as a pass in every aggregate.
    ...jest.requireActual('@/lib/db/rls-middleware'),
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ registeredAgent: { findFirst: async () => ({ aiSystemId: 'ai-system-1' }) } }),
    ),
}));

import { executeFlueRun } from '@/lib/agentic/flue/execute';
import { haltRunAtKill } from '@/lib/agentic/drivers/run-settlement';
import { logAiDecision } from '@/app-layer/ai/decision-log';
import { makeRequestContext } from '../helpers/make-context';

import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

const CTX: RequestContext = { ...makeRequestContext('ADMIN'), agentId: 'agent-1' };
const DEF = { key: 'k', label: 'K', steps: [{ kind: 'READ', tool: 'list_risks', label: 'read' }] } as unknown as WorkflowDefinition;

beforeEach(() => {
    jest.clearAllMocks();
    mockObservers.length = 0;
    killState = null;
    booted = false;
    dispatched = false;
    mockRead = async () => ({ text: 'done', metadata: {} });
});

describe('a run whose agent is killed never reaches the model', () => {
    for (const scope of ['PLATFORM', 'TENANT', 'AGENT'] as const) {
        it(`refuses under a ${scope} switch`, async () => {
            killState = { scope, switchId: 'sw-1', engagedAt: new Date('2026-01-01T00:00:00Z') };

            const out = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

            expect(out.status).toBe('ABORTED');
            // The prompt never left. This is the assertion the tool-boundary
            // gate could not make: it fires AFTER a model has already answered.
            expect(dispatched).toBe(false);
            // Nor was an Art 12 decision row written for a call never made.
            expect(logAiDecision).not.toHaveBeenCalled();
            expect(haltRunAtKill).toHaveBeenCalled();
        });
    }

    it('checks BEFORE booting the runtime', async () => {
        // Booting is work a killed run should not cause, and the boot is what
        // resolves providers and validates the model specifier.
        killState = { scope: 'TENANT', switchId: 'sw-1', engagedAt: new Date() };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(booted).toBe(false);
    });

    it('runs normally when no switch is engaged', async () => {
        // The positive control. Without it, every assertion above would pass
        // under an implementation that refused every run.
        killState = null;

        const out = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(booted).toBe(true);
        expect(dispatched).toBe(true);
        expect(out.status).toBe('COMPLETED');
        expect(haltRunAtKill).not.toHaveBeenCalled();
    });
});
