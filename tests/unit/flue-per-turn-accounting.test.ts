/**
 * A FLUE DISPATCH ACCOUNTS PER MODEL CALL, AND PAYS ON EVERY EXIT.
 *
 * ── THE TWO DEFECTS THIS IS THE REGRESSION TEST FOR ─────────────────────────
 *
 * 1. THE ART 12 ROW WAS WRITTEN PER DISPATCH. `recordModelDecision` ran once,
 *    after `agent.read(receipt)`, off the response aggregate — so a six-turn
 *    run left ONE `AiDecisionLog` row carrying six calls' summed tokens. EU AI
 *    Act Art 12 record-keeping is per model call, and the per-call numbers are
 *    not recoverable from that sum: 6 calls at 100 and 1 call at 600 produced
 *    the same row.
 *
 * 2. TOKEN ACCOUNTING WAS LOST ON EVERY THROW. `usage` was read inside the
 *    `try`, after `read`, so every settle reached from the `catch` persisted a
 *    `costTokens` that EXCLUDED the segment just executed. The catch is the
 *    NORMAL exit for a guard outcome — `review.check` leaves by throwing on
 *    both of its refusal paths — so every guard-blocked and every flagged run
 *    recorded zero tokens for the dispatch that spent them. The tenant's
 *    monthly budget is `_sum: { costTokens }` over `WorkflowRun`, so those
 *    tokens were free.
 *
 * ── WHY THIS FILE IS BEHAVIOURAL AND THE REST OF THE ENGINE IS STRUCTURAL ───
 *
 * The rest of this engine is guarded by source-contract tests, on the argument
 * that a behavioural test "would need the whole ESM runtime plus a model". It
 * does not: `@flue/runtime` is the only ESM-only module `execute.ts` reaches
 * directly, and `jest.mock(…, { virtual: true })` supplies it — which also
 * lets `agent.ts` load for real, so `FLUE_USAGE_KEY` below is the shipped
 * constant rather than a copy of it.
 *
 * What that buys is the assertion the old protection could not make. The
 * previous guard asserted the file CONTAINS `costTokens += usage.totalTokens`
 * — a line that exists, not a value that is ever written down — and stayed
 * green with every persist deleted. Here the charge is read back off the
 * `updateRun` the run row actually received.
 */
import { makeRequestContext } from '../helpers/make-context';

import type { RequestContext } from '@/app-layer/types';
import type { WorkflowDefinition } from '@/lib/agentic/workflow-types';

/** Every live `observe()` subscriber, so a test can emit into the run. */
const mockObservers: Array<(event: unknown, ctx: unknown) => void> = [];
/** What `agent.read(receipt)` does — set per test. */
let mockRead: () => Promise<{ text?: string; metadata?: Record<string, unknown> }>;
/** The guard observer `flueToolsFor` was handed, so a test can fire a verdict. */
let mockGuardObserver: ((o: unknown) => void) | undefined;

jest.mock(
    '@flue/runtime',
    () => ({
        init: () => ({
            dispatch: async () => ({ submissionId: 'sub-1' }),
            read: async () => mockRead(),
        }),
        observe: (fn: (event: unknown, ctx: unknown) => void) => {
            mockObservers.push(fn);
            return () => {
                const at = mockObservers.indexOf(fn);
                if (at >= 0) mockObservers.splice(at, 1);
            };
        },
        // The render hooks `agent.ts` declares. `InflectAgent` is passed to the
        // mocked `init` and never rendered here, so none of these is called —
        // they exist so the module loads.
        useInitialData: () => ({ runId: 'unused' }),
        useInstruction: () => undefined,
        useModel: () => undefined,
        useResponseFinish: () => undefined,
        useTool: () => undefined,
    }),
    { virtual: true },
);

jest.mock('@/lib/agentic/flue/runtime-start', () => ({
    ensureFlueRuntime: jest.fn(async () => []),
}));
jest.mock('@/lib/agentic/flue/providers', () => ({
    flueModelIsRegistered: jest.fn(() => true),
}));
jest.mock('@/lib/agentic/flue/tools-adapter', () => ({
    flueToolsFor: jest.fn((_inv: unknown, observer: (o: unknown) => void) => {
        mockGuardObserver = observer;
        return { tools: [], omitted: [] };
    }),
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
jest.mock('@/lib/agentic/drivers/step-recorder', () => ({
    recordStep: jest.fn(async () => undefined),
}));
jest.mock('@/lib/agentic/drivers/run-settlement', () => ({
    updateRun: jest.fn(async () => undefined),
    failRun: jest.fn(async () => 'FAILED'),
    haltRunAtCap: jest.fn(async () => 'FAILED'),
    haltRunAtGuard: jest.fn(async () => 'ABORTED'),
}));
jest.mock('@/lib/agentic/circuit-breaker-store', () => ({
    latchOnGuardBlock: jest.fn(async () => null),
}));
jest.mock('@/app-layer/ai/decision-log', () => ({
    logAiDecision: jest.fn(async () => 'decision-1'),
    // REAL-SHAPED, not a stub returning a constant. `execute.ts` records this
    // digest on the MODEL_CALL step so the run timeline can link to the Art 12
    // rows (#2786), and the link is only correct if the step and the rows
    // digest the SAME value — so a mock that collapsed every input to one
    // string would make a broken link look fine here.
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
import { FLUE_USAGE_KEY } from '@/lib/agentic/flue/agent';
import { logAiDecision } from '@/app-layer/ai/decision-log';
import { recordStep } from '@/lib/agentic/drivers/step-recorder';
import { updateRun, failRun, haltRunAtGuard } from '@/lib/agentic/drivers/run-settlement';

const logged = logAiDecision as jest.Mock;
const stepped = recordStep as jest.Mock;
const updated = updateRun as jest.Mock;
const failed = failRun as jest.Mock;
const haltedAtGuard = haltRunAtGuard as jest.Mock;

const DEF: WorkflowDefinition = {
    driver: 'flue',
    key: 'posture-review',
    name: 'Posture review',
    description: 'Review the tenant posture.',
    steps: [
        { kind: 'READ', label: 'read posture', tool: 'get_compliance_posture' },
        { kind: 'SYNTHESIS', label: 'summarise', synthesize: () => ({ text: '' }) },
    ],
};

const CTX: RequestContext = makeRequestContext('ADMIN', { agentId: 'agent-1' });

/**
 * Emit one `turn` event — the runtime's per-model-call event — into every live
 * subscriber, shaped as `@flue/runtime`'s `FlueEvent` variant of that type.
 *
 * `instanceId` is carried on the CONTEXT, which is where `execute.ts` reads it:
 * `FlueEventContext.id` is documented as "the agent instance id; equals the
 * `instanceId` stamped on the context's events".
 */
function emitTurn(
    runId: string,
    usage: { input: number; output: number } | null,
    durationMs = 0,
): void {
    const event = {
        type: 'turn',
        turnId: `turn-${Math.random()}`,
        purpose: 'agent',
        durationMs,
        request: {},
        isError: false,
        response: usage
            ? {
                  usage: {
                      input: usage.input,
                      output: usage.output,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: usage.input + usage.output,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                  },
              }
            : {},
    };
    for (const fn of [...mockObservers]) fn(event, { id: runId, agentName: 'inflect' });
}

/** The `{ tokensIn, tokensOut, latencyMs, outputSummary }` of each decision row. */
function decisionRows(): Array<Record<string, unknown>> {
    return logged.mock.calls.map(([, , input]) => input as Record<string, unknown>);
}

/** The `stepCount` of the last `updateRun` that carried one. */
function persistedStepCount(): number | undefined {
    const carrying = updated.mock.calls.filter(([, , data]) => 'stepCount' in (data as object));
    const last = carrying.at(-1);
    return last ? ((last[2] as { stepCount: number }).stepCount) : undefined;
}

/** The `costTokens` of the last `updateRun` that carried one. */
function persistedCostTokens(): number | undefined {
    const carrying = updated.mock.calls.filter(([, , data]) => 'costTokens' in (data as object));
    const last = carrying.at(-1);
    return last ? ((last[2] as { costTokens: number }).costTokens) : undefined;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockObservers.length = 0;
    mockGuardObserver = undefined;
});

describe('one decision row per MODEL CALL, carrying that call’s own tokens', () => {
    it('writes three rows for a three-turn dispatch, none of them the sum', async () => {
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 }, 11);
            emitTurn('run-1', { input: 200, output: 20 }, 22);
            emitTurn('run-1', { input: 300, output: 30 }, 33);
            return {
                text: 'Posture reviewed.',
                metadata: {
                    [FLUE_USAGE_KEY]: {
                        totalTokens: 660,
                        tokensIn: 600,
                        tokensOut: 60,
                        toolCalls: 2,
                        failedToolCalls: 0,
                    },
                },
            };
        };

        const outcome = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(outcome).toEqual({ status: 'COMPLETED', stepFailures: 0 });
        // THE ASSERTION THE AGGREGATE FAILS. One row carrying 600/60 is what
        // shipped; three rows carrying the calls are what Art 12 asks for, and
        // the sum cannot be taken apart into them afterwards.
        expect(decisionRows().map((r) => [r.tokensIn, r.tokensOut])).toEqual([
            [100, 10],
            [200, 20],
            [300, 30],
        ]);
    });

    it('stamps each call’s own latency, which the aggregate never carried', async () => {
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 }, 11);
            emitTurn('run-1', { input: 200, output: 20 }, 22);
            return { text: 'done', metadata: {} };
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(decisionRows().map((r) => r.latencyMs)).toEqual([11, 22]);
    });

    it('gives the settled text to the LAST call and to no other', async () => {
        // A response settles when the model stops calling tools, so its text is
        // the last turn's output. Attaching it to every row would claim each
        // call produced the whole answer.
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            emitTurn('run-1', { input: 200, output: 20 });
            return { text: 'Posture reviewed.', metadata: {} };
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(decisionRows().map((r) => r.outputSummary)).toEqual([null, 'Posture reviewed.']);
    });

    it('links every row to the registered agent’s AI system, not just the last', async () => {
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            emitTurn('run-1', { input: 200, output: 20 });
            return { text: 'done', metadata: {} };
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(decisionRows().map((r) => r.aiSystemId)).toEqual(['ai-system-1', 'ai-system-1']);
    });

    it('ignores turns belonging to another instance, so runs cannot cross-charge', async () => {
        // `observe()` is isolate-global — "the subscription covers all agents,
        // harnesses, sessions" — so two concurrent runs see each other's
        // events. Without the `ctx.id` filter this run bills the other's.
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            emitTurn('some-other-run', { input: 9000, output: 900 });
            return { text: 'done', metadata: {} };
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(decisionRows().map((r) => r.tokensIn)).toEqual([100]);
        expect(persistedCostTokens()).toBe(110);
    });

    it('claims nothing for a turn the provider reported no usage for', async () => {
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            emitTurn('run-1', null);
            return { text: 'done', metadata: {} };
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(logged).toHaveBeenCalledTimes(1);
    });

    it('records the model-call step with the summed spend and the call COUNT', async () => {
        // One ledger row still covers the dispatch — its seq feeds the step
        // caps — but a reader must not have to assume that meant one call.
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            emitTurn('run-1', { input: 200, output: 20 });
            emitTurn('run-1', { input: 300, output: 30 });
            return { text: 'done', metadata: {} };
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        const modelStep = stepped.mock.calls.find((c) => c[3] === 'MODEL_CALL');
        expect(modelStep?.[4]).toMatchObject({
            tokens: 660,
            input: expect.objectContaining({ modelCalls: 3 }),
        });
    });
});

describe('the charge survives the throw that a guard outcome arrives as', () => {
    it('persists what a GUARD-BLOCKED dispatch spent, before it settles the run', async () => {
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            emitTurn('run-1', { input: 200, output: 20 });
            // What `review.check` does on its refusal path: it throws. Before
            // this fix every token above was recorded as zero.
            mockGuardObserver?.({ toolCallId: 't1', verdict: 'QUARANTINED', ruleIds: ['pii.email'] });
            throw new Error('guard refused the call');
        };

        const outcome = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(outcome.status).toBe('ABORTED');
        expect(persistedCostTokens()).toBe(330);
        // BEFORE the settle, not after: `haltRunAtGuard` writes the terminal
        // row, and a charge written afterwards is a charge a crash between the
        // two loses.
        expect(updated.mock.invocationCallOrder[0]).toBeLessThan(
            haltedAtGuard.mock.invocationCallOrder[0],
        );
    });

    it('still writes the Art 12 rows for the calls a blocked run made', async () => {
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            emitTurn('run-1', { input: 200, output: 20 });
            mockGuardObserver?.({ toolCallId: 't1', verdict: 'FLAGGED', ruleIds: ['pii.email'] });
            throw new Error('guard flagged the call');
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        // No reply, so no call gets an output summary: the response never
        // settled and there is no text to attribute.
        expect(decisionRows().map((r) => [r.tokensIn, r.outputSummary])).toEqual([
            [100, null],
            [200, null],
        ]);
    });

    it('persists what a FAILED dispatch spent — `failRun` carries no tokens of its own', async () => {
        mockRead = async () => {
            emitTurn('run-1', { input: 400, output: 40 });
            throw new Error('the provider hung up');
        };

        const outcome = await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(outcome.status).toBe('FAILED');
        expect(failed).toHaveBeenCalled();
        expect(persistedCostTokens()).toBe(440);
    });

    it('adds the segment to what earlier segments already spent', async () => {
        // A resumed run seeds `costTokens` from the row. Charging the segment
        // alone would hand a three-checkpoint run its budget back twice.
        const { getRunRow } = jest.requireMock('@/lib/agentic/drivers/run-store') as {
            getRunRow: jest.Mock;
        };
        getRunRow.mockResolvedValueOnce({ costTokens: 5_000 });
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            throw new Error('guard refused the call');
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(persistedCostTokens()).toBe(5_110);
    });

    it('does not double-charge when the success path already recorded the turns', async () => {
        // `recordStep` throwing after the flush lands in the catch, where the
        // drain must make the second settle a no-op.
        stepped.mockRejectedValueOnce(new Error('ledger write failed'));
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            return { text: 'done', metadata: {} };
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(logged).toHaveBeenCalledTimes(1);
        expect(persistedCostTokens()).toBe(110);
    });
});

describe('a settled response that reported tokens is never free', () => {
    it('charges the response aggregate when no per-call usage was observed', async () => {
        // The fail-safe. If the event stream ever stops carrying per-call
        // usage, the per-turn charge silently becomes zero — which is worse
        // than the aggregate it replaced, because it is a hole in the tenant's
        // monthly budget rather than a coarser record.
        mockRead = async () => ({
            text: 'done',
            metadata: {
                [FLUE_USAGE_KEY]: {
                    totalTokens: 770,
                    tokensIn: 700,
                    tokensOut: 70,
                    toolCalls: 1,
                    failedToolCalls: 0,
                },
            },
        });

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(persistedCostTokens()).toBe(770);
        expect(decisionRows().map((r) => [r.tokensIn, r.tokensOut, r.latencyMs])).toEqual([
            // `latencyMs` null, because an aggregate has no call duration to
            // report and inventing one would make the row read as a measurement.
            [700, 70, null],
        ]);
    });

    it('writes nothing at all when there were no calls and no aggregate', async () => {
        mockRead = async () => ({ text: 'done', metadata: {} });

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        expect(logged).not.toHaveBeenCalled();
        expect(persistedCostTokens()).toBe(0);
    });
});

describe('a halted run records where it got to, so a resume does not redo it', () => {
    // `resumeWorkflowRun` re-enters the definition at `run.stepCount`. The
    // engine wrote that column on its two TERMINAL exits only — COMPLETED and
    // the TOKENS cap — so a run stopped by a guard FLAG persisted NO progress
    // at all. A flagged run is `AWAITING_APPROVAL`, which is exactly the state
    // a human resumes.
    //
    // It bites on a RESUMED segment. `seq` starts at `fromSeq` and advances
    // per TOOL_CALL the ledger numbers, so a segment that began at step 3 and
    // made two tool calls before being flagged had earned stepCount 5. Writing
    // nothing left the column at 3, and approving the run re-issued those two
    // tool calls and re-charged their tokens.

    it('persists progress when a guard FLAG halts a RESUMED segment', async () => {
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            // `review.check` leaves by throwing on its refusal path, so this is
            // the normal exit for a flag — not an error path.
            mockGuardObserver?.({ toolCallId: 't1', verdict: 'FLAGGED', ruleIds: ['pii.email'] });
            throw new Error('guard flagged the call');
        };

        // fromSeq 3: the run is resuming, and the column must not go backwards.
        await executeFlueRun(CTX, 'run-1', DEF, 3, Date.now(), 'anthropic/claude');

        // Before the fix this was `undefined` — the exit wrote no stepCount at
        // all, so whatever the column held survived the segment.
        expect(persistedStepCount()).toBe(3);
    });

    it('persists progress on a plain failure too', async () => {
        mockRead = async () => {
            emitTurn('run-1', { input: 400, output: 40 });
            throw new Error('the provider hung up');
        };

        await executeFlueRun(CTX, 'run-1', DEF, 2, Date.now(), 'anthropic/claude');

        expect(persistedStepCount()).toBe(2);
    });

    it('counts the MODEL_CALL step a completed dispatch recorded', async () => {
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            return { text: 'done', metadata: {} };
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        // One MODEL_CALL step was recorded, so the ledger advanced past it.
        expect(persistedStepCount()).toBe(1);
    });

    it('writes progress in the SAME update as the charge', async () => {
        // One writer, for the reason `settleAtGuard`'s comment gives about
        // `costTokens`: two writers for one run's progress is how the two
        // drift, and a resume reading a stale stepCount redoes paid work.
        mockRead = async () => {
            emitTurn('run-1', { input: 100, output: 10 });
            return { text: 'done', metadata: {} };
        };

        await executeFlueRun(CTX, 'run-1', DEF, 0, Date.now(), 'anthropic/claude');

        const carrying = updated.mock.calls.filter(([, , d]) => 'costTokens' in (d as object));
        expect(carrying.length).toBeGreaterThan(0);
        for (const [, , d] of carrying) expect(d).toHaveProperty('stepCount');
    });
});
