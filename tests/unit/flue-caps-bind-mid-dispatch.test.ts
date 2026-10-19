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
/** Set per test: whether the chosen model is one the runtime registered. */
let modelIsRegistered = true;
jest.mock('@/lib/agentic/flue/providers', () => ({
    flueModelIsRegistered: jest.fn(() => modelIsRegistered),
}));
jest.mock('@/lib/agentic/flue/tools-adapter', () => ({
    flueToolsFor: jest.fn(() => ({ tools: offeredTools, omitted: [] })),
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
        fn({
            registeredAgent: { findFirst: async () => ({ aiSystemId: 'ai-system-1' }) },
            // The tenant's own approved skills on the workflow (#3680): none.
            tenantSkillVersion: { findMany: async () => [] },
        }),
    ),
}));

import { executeFlueRun } from '@/lib/agentic/flue/execute';
import { haltRunAtCap, failRun } from '@/lib/agentic/drivers/run-settlement';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
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
    modelIsRegistered = true;
    toolIsPropose = false;
    itemsPerProposeCall = 0;
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

/**
 * THE REFUSALS THAT HAPPEN BEFORE ANY MODEL CALL (#3617).
 *
 * `executeFlueRun`'s two earliest exits were uncovered. Both matter for the same
 * reason the kill switch is checked first in this function: a refusal that
 * arrives after the prompt has been assembled and sent has already done the
 * thing it was meant to prevent.
 */
describe('a run refused before dispatch never reaches the model', () => {
    it('refuses an unregistered model, and does not dispatch', async () => {
        modelIsRegistered = false;
        let dispatched = false;
        mockRead = async () => {
            dispatched = true;
            return { text: 'should never happen', metadata: {} };
        };

        const out = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        // The named refusal `providers.ts` exists to make possible: asked BEFORE
        // dispatch so an unresolvable specifier is an operator-actionable
        // sentence rather than a stream error from inside pi, mid-run, with the
        // row already created.
        expect(failRun).toHaveBeenCalled();
        expect(dispatched).toBe(false);
        // Nothing ran, so nothing failed — a non-zero count here would make a
        // refusal indistinguishable from a run whose steps broke.
        expect(out.stepFailures).toBe(0);
    });

    it('halts on the wall clock at the preflight, and does not dispatch', async () => {
        // The run enters already past its budget: a resume of a run whose
        // earlier segment consumed the hour. The preflight charge is the only
        // thing between that and a fresh model call.
        let dispatched = false;
        mockRead = async () => {
            dispatched = true;
            return { text: 'should never happen', metadata: {} };
        };
        const t0 = 1_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(t0 + ENGINE_RUN_CAPS.RUNTIME_MS + 1);

        const out = await executeFlueRun(CTX, 'run-1', DEF, 0, t0, 'anthropic/claude');

        expect(haltRunAtCap).toHaveBeenCalled();
        expect(dispatched).toBe(false);
        expect(out.stepFailures).toBe(0);
    });

    it('dispatches when both checks pass — the positive control', () => {
        // Without this, the two assertions above are satisfied by an
        // implementation that never dispatches at all.
        return (async () => {
            let dispatched = false;
            mockRead = async () => {
                dispatched = true;
                return { text: 'done', metadata: {} };
            };
            const t0 = 1_000_000;
            jest.spyOn(Date, 'now').mockReturnValue(t0 + 1_000);

            await executeFlueRun(CTX, 'run-1', DEF, 0, t0, 'anthropic/claude');
            expect(dispatched).toBe(true);
        })();
    });
});

/**
 * A TOOL THAT THROWS IS COUNTED, RECORDED, AND RE-RAISED (#3617).
 *
 * `stepFailures` is what the driver returns to its caller, and the only signal
 * that a run which SETTLED nonetheless had steps break inside it. The
 * increment, the FAILED step row and the re-raise were all uncovered, so a
 * change that swallowed a tool error would have left every assertion green
 * while the run reported a clean settle.
 */
describe('a tool whose run throws', () => {
    it('counts the failure, records a FAILED step, and lets the error through', async () => {
        offeredTools = [
            {
                name: 'list_risks',
                description: 'List risks.',
                input: {},
                annotations: { readOnlyHint: true },
                run: async () => {
                    throw new Error('the tool exploded');
                },
            },
        ];

        const t0 = 1_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(t0 + 1_000);

        mockRead = async () => {
            // The error must reach the model as a failed tool call rather than
            // being absorbed by the wrapper.
            await expect(
                boundTools[0].run({ toolCallId: 't1', data: {} }),
            ).rejects.toThrow(/exploded/);
            return { text: 'carried on', metadata: {} };
        };

        const out = await executeFlueRun(CTX, 'run-1', DEF, 0, t0, 'anthropic/claude');

        // THE COUNT the caller acts on.
        expect(out.stepFailures).toBe(1);
        // AND the ledger row, marked FAILED rather than merely absent — an
        // absent row is indistinguishable from a call never made.
        const failedSteps = (recordStep as jest.Mock).mock.calls.filter(
            (c) => c[4] && (c[4] as { status?: string }).status === 'FAILED',
        );
        expect(failedSteps.length).toBeGreaterThanOrEqual(1);
    });

    it('reports zero failures when the tool succeeds — the positive control', async () => {
        offeredTools = [aTool(() => undefined)];
        const t0 = 1_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(t0 + 1_000);
        mockRead = async () => {
            await boundTools[0].run({ toolCallId: 't1', data: {} });
            return { text: 'done', metadata: {} };
        };

        const out = await executeFlueRun(CTX, 'run-1', DEF, 0, t0, 'anthropic/claude');
        expect(out.stepFailures).toBe(0);
    });
});

/**
 * THE REMAINING HARD CAPS LATCH AND REFUSE (#3617).
 *
 * `ENGINE_CAPS` calls these "hard per-run guardrails for an autonomous
 * multi-step agent", and the engine's own rule is that a breach HALTS rather
 * than trims — `haltRunAtCap`'s header spells out why a cap that trimmed would
 * leave a run that "LOOKS healthy and reasoned over a subset nobody chose".
 *
 * The STEPS/TOOL_CALLS and PROPOSALS arms set `latch.halt` and throw, which is
 * how a refusal inside a dispatch becomes a settled halt once the dispatch
 * unwinds. Both were uncovered, so a change that set the latch without throwing
 * — or threw without latching — would have left the suite green: the first
 * lets the model keep calling tools, the second settles the run on whatever the
 * dispatch returned instead of on the cap.
 */
describe('the step and proposal caps latch, and refuse before the tool runs', () => {
    it('refuses the call that would exceed STEPS, without entering the tool', async () => {
        let runs = 0;
        offeredTools = [aTool(() => { runs += 1; })];
        const t0 = 1_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(t0 + 1_000);

        mockRead = async () => {
            // Spend the whole budget, then ask for one more. Charged BEFORE the
            // call, so the refused one must not enter the tool function.
            for (let i = 0; i < ENGINE_RUN_CAPS.STEPS; i += 1) {
                await boundTools[0].run({ toolCallId: `t${i}`, data: {} });
            }
            const spent = runs;
            await expect(
                boundTools[0].run({ toolCallId: 'one-too-many', data: {} }),
            ).rejects.toThrow();
            // The refusal did not run the tool — the pre-execution property.
            expect(runs).toBe(spent);
            throw new Error('dispatch aborted by the cap');
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, t0, 'anthropic/claude');

        expect(runs).toBe(ENGINE_RUN_CAPS.STEPS);
        // LATCHED, so the unwound dispatch settles on the cap rather than on
        // whatever the dispatch happened to return.
        expect(haltRunAtCap).toHaveBeenCalled();
    });

    it('refuses a propose call that would exceed PROPOSALS', async () => {
        toolIsPropose = true;
        // One call proposes more items than the whole run may.
        itemsPerProposeCall = ENGINE_RUN_CAPS.PROPOSALS + 1;
        let runs = 0;
        offeredTools = [aTool(() => { runs += 1; })];
        const t0 = 1_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(t0 + 1_000);

        mockRead = async () => {
            await expect(
                boundTools[0].run({ toolCallId: 'p1', data: {} }),
            ).rejects.toThrow();
            throw new Error('dispatch aborted by the cap');
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, t0, 'anthropic/claude');

        expect(haltRunAtCap).toHaveBeenCalled();
    });

    it('allows a propose call that fits — the positive control', async () => {
        toolIsPropose = true;
        itemsPerProposeCall = 1;
        let runs = 0;
        offeredTools = [aTool(() => { runs += 1; })];
        const t0 = 1_000_000;
        jest.spyOn(Date, 'now').mockReturnValue(t0 + 1_000);
        mockRead = async () => {
            await boundTools[0].run({ toolCallId: 'p1', data: {} });
            return { text: 'done', metadata: {} };
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, t0, 'anthropic/claude');
        // Without this, the refusal above is satisfied by an implementation that
        // refuses every propose call.
        expect(runs).toBe(1);
    });
});
