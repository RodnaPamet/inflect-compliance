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
/**
 * Engage the switch AFTER the first model call, as an operator does mid-run
 * (#4196), and ask the gate the real interceptor asks.
 *
 * The mocked runtime cannot run the production interceptor, so the dispatch
 * stands in for it: it reads the run binding and calls `assertMayCallModel`
 * exactly where `telemetry.ts` does — before the next model call — then throws
 * what the REAL runtime throws, which is its own wrapper and not our message.
 * That wrapping is the point of the test: it is why `executeFlueRun` settles
 * from a latched verdict rather than by reading the error.
 */
let killMidDispatch = false;

jest.mock(
    '@flue/runtime',
    () => ({
        init: () => ({
            dispatch: async () => {
                dispatched = true;
                if (killMidDispatch) {
                    killState = { scope: 'TENANT', switchId: 'sw-mid', engagedAt: new Date() };
                     
                    const { readRunBinding } = require('@/lib/agentic/flue/run-binding');
                    await readRunBinding('run-1')?.assertMayCallModel?.();
                    throw new Error('[flue] Agent run failed (submission sub-1).');
                }
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
    // ONE tool, not an empty list (#3869 deploy 2). An empty catalogue now
    // settles EMPTY_CATALOGUE rather than COMPLETED, so an empty fixture here
    // made this file's positive control assert the DEGENERATE outcome — a
    // "runs normally" case that would have passed even if normal runs broke.
    // A kill-switch test should not depend on the no-tools state at all.
    flueToolsFor: jest.fn(() => ({
        tools: [{ name: 'list_risks', description: 'stub', input: undefined, run: async () => '' }],
        omitted: [],
    })),
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
        fn({
            registeredAgent: { findFirst: async () => ({ aiSystemId: 'ai-system-1' }) },
            // The tenant's own approved skills on the workflow (#3680): none.
            tenantSkillVersion: { findMany: async () => [] },
        }),
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
    killMidDispatch = false;
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

    it('a switch engaged MID-RUN aborts the run, and is reported as a kill', async () => {
        // The gap this closes. The switch was asked once before boot and then
        // only at the TOOL boundary, where a refusal becomes an `isError` tool
        // result — so the model was called again and the run settled COMPLETED.
        // Measured by the driver conformance suite at 3 model calls for a
        // switch engaged after the first.
        //
        // The run starts clean, so the pre-boot check passes and this can only
        // be the per-turn one firing.
        killState = null;
        killMidDispatch = true;

        const out = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        // ABORTED, not COMPLETED and not FAILED. `FAILED` is what a
        // message-reading arm would have produced, because the runtime wraps
        // our error and the kill reason never reaches the catch.
        expect(out.status).toBe('ABORTED');
        expect(haltRunAtKill).toHaveBeenCalled();
        // And it really did get past the pre-boot gate — otherwise this would
        // pass for the reason the tests above already cover.
        expect(booted).toBe(true);
        expect(dispatched).toBe(true);
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
