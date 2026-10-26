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
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordAgentKillRefusal: jest.fn(),
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
import { readRunBinding } from '@/lib/agentic/flue/run-binding';
import { failRun, haltRunAtCap, haltRunAtKill } from '@/lib/agentic/drivers/run-settlement';
import { getRunRow } from '@/lib/agentic/drivers/run-store';
import { killRefusalMessage, resolveKillState } from '@/lib/agentic/kill-switch';
import { recordAgentKillRefusal } from '@/lib/observability/integration-metrics';
import { logAiDecision } from '@/app-layer/ai/decision-log';
import { ENGINE_CAPS } from '@/lib/agentic/workflow-types';
import { ENGINE_RUN_CAPS } from '@/lib/agentic/run-caps';
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

/**
 * ═══ AND A KILL ENGAGED MID-RUN STOPS THE NEXT MODEL CALL (#4196) ═══
 *
 * The check above runs once, before boot. Engaged after that, the switch was
 * asked only at the tool boundary: each tool call was refused, the refusal
 * reached the model as a tool error, the model was called again, and the run
 * settled COMPLETED.
 *
 * The production interceptor (`flue/telemetry.ts`) awaits the binding's
 * `beforeModelCall` before every model operation. The mocked `read` below
 * plays that part: it asks before each scripted model call, as the runtime
 * would, and counts the calls that were allowed through.
 */
describe('a kill switch engaged mid-run stops the next model call', () => {
    const KILL = { scope: 'AGENT', switchId: 'sw-2', engagedAt: new Date('2026-10-25T00:00:00Z') };

    /** How many model calls were let through, and the hook each one asked. */
    let modelCalls = 0;

    /**
     * Script a dispatch of `calls` model calls. `between(i)` runs after call i
     * is made, which is when a kill or a turn event lands.
     */
    function scriptModelCalls(calls: number, between: (i: number) => void, swallow = false): void {
        mockRead = async () => {
            const binding = readRunBinding('run-1');
            if (!binding?.beforeModelCall) throw new Error('harness: the run was bound without beforeModelCall');
            for (let i = 0; i < calls; i += 1) {
                try {
                    await binding.beforeModelCall();
                } catch (err) {
                    // The runtime may turn a refused call into a tidy finish.
                    if (swallow) return { text: 'finished', metadata: {} };
                    throw err;
                }
                modelCalls += 1;
                between(modelCalls);
            }
            return { text: 'done', metadata: {} };
        };
    }

    /** One model call's usage, as the runtime's `turn` event reports it. */
    function emitTurn(totalTokens: number): void {
        for (const fn of mockObservers) {
            fn(
                { type: 'turn', response: { usage: { totalTokens, input: totalTokens, output: 0 } }, durationMs: 1 },
                { id: 'run-1' },
            );
        }
    }

    beforeEach(() => {
        modelCalls = 0;
    });

    it('halts before the second model call, with the kill reason', async () => {
        scriptModelCalls(3, (i) => {
            if (i === 1) killState = KILL;
        });

        const out = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(modelCalls).toBe(1);
        expect(out.status).toBe('ABORTED');
        expect(haltRunAtKill).toHaveBeenCalledWith(
            CTX,
            'run-1',
            KILL,
            killRefusalMessage('AGENT'),
            // No cap latched, so none is carried beside the kill (#4230).
            null,
        );
        expect(recordAgentKillRefusal).toHaveBeenCalledWith({ scope: 'AGENT', drill: false });
        // Not reported as a cap or as a crash.
        expect(haltRunAtCap).not.toHaveBeenCalled();
        expect(failRun).not.toHaveBeenCalled();
    });

    it('still settles ABORTED when the runtime turns the refusal into a tidy finish', async () => {
        scriptModelCalls(3, (i) => {
            if (i === 1) killState = KILL;
        }, true);

        const out = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(modelCalls).toBe(1);
        expect(out.status).toBe('ABORTED');
        expect(haltRunAtKill).toHaveBeenCalled();
    });

    it('asks the switch before every model call, uncached', async () => {
        // The positive control: no switch, every call goes through, and the
        // switch was asked once at boot and once per call.
        scriptModelCalls(3, () => undefined);

        const out = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(modelCalls).toBe(3);
        expect(out.status).toBe('COMPLETED');
        expect(resolveKillState).toHaveBeenCalledTimes(1 + 3);
        expect(haltRunAtKill).not.toHaveBeenCalled();
    });

    it('refuses the call when the kill read itself fails, rather than proceeding', async () => {
        // Fail closed, as `assertNotKilled` does: a switch nobody could read is
        // not a switch that is off.
        scriptModelCalls(3, (i) => {
            if (i === 1) {
                (resolveKillState as jest.Mock).mockRejectedValueOnce(new Error('kill read unavailable'));
            }
        });

        const out = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(modelCalls).toBe(1);
        expect(out.status).toBe('FAILED');
        expect(failRun).toHaveBeenCalledWith(CTX, 'run-1', expect.stringContaining('kill read unavailable'));
    });

    it('halts at the TOKENS cap before a call, once the calls so far have spent it', async () => {
        // Charged only after the dispatch before #4196, so a long dispatch could
        // run as far past the cap as the model liked.
        (getRunRow as jest.Mock).mockResolvedValueOnce({ costTokens: ENGINE_CAPS.MAX_TOKENS - 50 });
        scriptModelCalls(3, () => emitTurn(100));

        const out = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(modelCalls).toBe(1);
        expect(out.status).toBe('FAILED');
        expect(haltRunAtCap).toHaveBeenCalledWith(CTX, 'run-1', expect.objectContaining({ kind: 'TOKENS' }), null);
        expect(haltRunAtKill).not.toHaveBeenCalled();
    });

    it('halts at the RUNTIME_MS cap before a call, once the wall clock has run out', async () => {
        const start = Date.now();
        const clock = jest.spyOn(Date, 'now');
        try {
            // Inside the clock at the preflight, outside it after the first call.
            scriptModelCalls(3, () => clock.mockReturnValue(start + ENGINE_CAPS.WALL_CLOCK_MS + 1));

            const out = await executeFlueRun(CTX, 'run-1', DEF, 0, start, 'anthropic/claude');

            expect(modelCalls).toBe(1);
            expect(out.status).toBe('FAILED');
            expect(haltRunAtCap).toHaveBeenCalledWith(
                CTX,
                'run-1',
                expect.objectContaining({ kind: 'RUNTIME_MS' }),
                null,
            );
        } finally {
            clock.mockRestore();
        }
    });
});

/**
 * ═══ A KILL IS STILL OBSERVED AFTER A CAP HAS LATCHED (#4230) ═══
 *
 * `beforeModelCall` read the cap latch before the kill switch. Once a cap had
 * latched, every later model call threw the cap's message and the switch was
 * never read again. The run stopped, but no kill refusal was counted, no
 * `WORKFLOW_RUN_AGENT_KILLED` row was written, and the run settled at the cap
 * as if only the budget had stopped it.
 *
 * The cap latches here at a TOOL call, as it does in a real run. The run starts
 * with its STEPS budget already spent by earlier segments, so the first tool
 * call is refused by the engine's own wrapper before the tool runs. The status
 * names the kill, and the cap travels beside it with the order this process
 * saw the two in (#4209).
 */
describe('a kill engaged after a cap has latched is still observed', () => {
    const KILL = { scope: 'TENANT', switchId: 'sw-3', engagedAt: new Date('2026-10-25T12:00:00Z') };
    /** What earlier segments spent: all of the STEPS budget. */
    const STEPS_SPENT = ENGINE_RUN_CAPS.STEPS;

    /** The bound run, as the interceptor and the runtime reach it. */
    function bound() {
        const binding = readRunBinding('run-1');
        if (!binding?.beforeModelCall) throw new Error('harness: the run was bound without beforeModelCall');
        return { binding, beforeModelCall: binding.beforeModelCall };
    }

    /** One tool call through the engine's wrapper, which must refuse it at the cap. */
    async function toolCallRefusedAtTheCap(): Promise<void> {
        const { binding } = bound();
        await expect(binding.tools[0].run({ toolCallId: 't1', data: {} })).rejects.toThrow(/STEPS/);
    }

    it('reads the switch on the next model call, and settles at the kill with the cap beside it', async () => {
        mockRead = async () => {
            const { beforeModelCall } = bound();
            await beforeModelCall();
            await toolCallRefusedAtTheCap();
            // The operator presses stop after the cap has latched.
            killState = KILL;
            await beforeModelCall();
            return { text: 'unreachable', metadata: {} };
        };

        const out = await executeFlueRun(CTX, 'run-1', DEF, STEPS_SPENT, Date.now(), 'anthropic/claude');

        expect(out.status).toBe('ABORTED');
        // The kill was read and counted, not shadowed by the latch.
        expect(recordAgentKillRefusal).toHaveBeenCalledWith({ scope: 'TENANT', drill: false });
        expect(haltRunAtKill).toHaveBeenCalledWith(CTX, 'run-1', KILL, killRefusalMessage('TENANT'), {
            halt: expect.objectContaining({ kind: 'STEPS', source: 'ENGINE' }),
            observedFirst: 'CAP',
        });
        // One settlement. The cap is carried by the kill's, not written as a
        // second terminal state.
        expect(haltRunAtCap).not.toHaveBeenCalled();
        expect(failRun).not.toHaveBeenCalled();
    });

    it('does the same when the runtime turns the refusal into a tidy finish', async () => {
        // The success path settles separately from the catch, so it is driven
        // separately.
        mockRead = async () => {
            const { beforeModelCall } = bound();
            await beforeModelCall();
            await toolCallRefusedAtTheCap();
            killState = KILL;
            await beforeModelCall().catch(() => undefined);
            return { text: 'finished', metadata: {} };
        };

        const out = await executeFlueRun(CTX, 'run-1', DEF, STEPS_SPENT, Date.now(), 'anthropic/claude');

        expect(out.status).toBe('ABORTED');
        expect(haltRunAtKill).toHaveBeenCalledWith(CTX, 'run-1', KILL, killRefusalMessage('TENANT'), {
            halt: expect.objectContaining({ kind: 'STEPS' }),
            observedFirst: 'CAP',
        });
        expect(haltRunAtCap).not.toHaveBeenCalled();
    });

    it('records the kill as first when a cap latches after it', async () => {
        // A tool call still in flight can latch a cap after the kill was found.
        // The order is the one this process saw, so it must not read as CAP.
        mockRead = async () => {
            const { beforeModelCall } = bound();
            await beforeModelCall();
            killState = KILL;
            await expect(beforeModelCall()).rejects.toThrow();
            await toolCallRefusedAtTheCap();
            // And a later kill finding does not rewrite the order.
            await beforeModelCall();
            return { text: 'unreachable', metadata: {} };
        };

        const out = await executeFlueRun(CTX, 'run-1', DEF, STEPS_SPENT, Date.now(), 'anthropic/claude');

        expect(out.status).toBe('ABORTED');
        expect(haltRunAtKill).toHaveBeenCalledWith(CTX, 'run-1', KILL, killRefusalMessage('TENANT'), {
            halt: expect.objectContaining({ kind: 'STEPS' }),
            observedFirst: 'KILL',
        });
    });

    it('still settles at the cap when no switch is engaged', async () => {
        // The control. Reading the switch first must change nothing for a run
        // that was only capped: it settles at the cap, and is not reported as
        // a kill.
        mockRead = async () => {
            const { beforeModelCall } = bound();
            await beforeModelCall();
            await toolCallRefusedAtTheCap();
            await beforeModelCall();
            return { text: 'unreachable', metadata: {} };
        };

        const out = await executeFlueRun(CTX, 'run-1', DEF, STEPS_SPENT, Date.now(), 'anthropic/claude');

        expect(out.status).toBe('FAILED');
        expect(haltRunAtCap).toHaveBeenCalledWith(CTX, 'run-1', expect.objectContaining({ kind: 'STEPS' }), null);
        expect(haltRunAtKill).not.toHaveBeenCalled();
        // Asked at boot and before both model calls, the second one included.
        expect(resolveKillState).toHaveBeenCalledTimes(1 + 2);
    });
});
