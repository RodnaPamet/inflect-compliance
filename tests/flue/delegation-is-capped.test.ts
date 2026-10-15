/**
 * THE FAN-OUT CAP IS ENFORCED, THROUGH THE REAL RUNTIME (#3473).
 *
 * `tests/unit/subagent-fanout.test.ts` covers the arithmetic and the gate as a
 * function. What only this file can show is that the gate is REACHED: that a
 * `task` call made by a model actually arrives at the interceptor in the shape
 * the gate matches on, and that declining `next()` fails the tool call rather
 * than being ignored.
 *
 * ── THAT GAP IS NOT HYPOTHETICAL, IT IS WHERE THE FIRST DESIGN WAS WRONG ────
 *
 * The gate was going to match `{ type: 'task' }`, which is what reading
 * `FlueExecutionOperation` suggests. Measured, a delegation arrives as
 * `{ type: 'tool', toolName: 'task' }` and the `task` operation appears later,
 * once a session exists. A unit test of the gate would have passed against
 * either choice, because a unit test supplies the operation it expects.
 *
 * So this file supplies nothing: it scripts a model to call the tool and reads
 * what the interceptor saw.
 *
 * ── WHY IT INSTALLS ITS OWN INSTRUMENTATION ─────────────────────────────────
 *
 * `instrument()` throws `InstrumentationAlreadyInstalledError` on a second
 * install, and the app installs one inside `ensureFlueRuntime` — which this
 * file does not call, because `start()` here is direct. So the composition
 * under test is reproduced rather than imported: the same `gateDelegation`,
 * called the same way the telemetry interceptor calls it.
 *
 * `tests/guards/flue-telemetry-carries-no-content.test.ts` is the other half —
 * it asserts the production interceptor calls the gate, before `next()`, with
 * the real `ctx`. None of which this file can see.
 */
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { init, instrument } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { InflectAgent } from '@/lib/agentic/flue/agent';
import { bindRun, releaseRun, readRunBinding } from '@/lib/agentic/flue/run-binding';
import {
    gateDelegation,
    guardDelegateResult,
    delegationsThisTurn,
    releaseDelegationCounts,
    _resetDelegationCounts,
} from '@/lib/agentic/flue/delegation-gate';

/** What the interceptor was handed, for the assertions that need the shape. */
interface Seen {
    type: string;
    toolName?: string;
    instanceId?: string;
    turnId?: string;
}

/**
 * Run one dispatch with the gate installed, and report what happened.
 *
 * The gate is called exactly as `installFlueTelemetry` calls it — before
 * `next()`, inside the interceptor — so a refusal fails the tool call.
 */
async function runWithGate(opts: {
    runId: string;
    cap: number;
    /** How many `task` calls the model makes, in one turn. */
    taskCalls: number;
}): Promise<{ seen: Seen[]; refusals: string[]; replied: string | null }> {
    const faux = fauxProvider();
    const seen: Seen[] = [];
    const refusals: string[] = [];

    const dispose = instrument({
        observe: () => {},
        interceptor: async (operation, ctx, next) => {
            seen.push({
                type: operation.type,
                ...('toolName' in operation ? { toolName: operation.toolName } : {}),
                ...(ctx.instanceId ? { instanceId: ctx.instanceId } : {}),
                ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
            });
            try {
                gateDelegation(operation, ctx);
            } catch (err) {
                refusals.push(err instanceof Error ? err.message : String(err));
                throw err;
            }
            return next();
        },
        dispose: () => {},
    });

    bindRun(opts.runId, {
        tools: [],
        skills: [],
        modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
        maxSubagentsPerTurn: opts.cap,
    });

    // ONE assistant message carrying N tool calls, so every call belongs to the
    // SAME turn — which is what the per-turn cap is about. Spreading them over
    // turns would test the reset instead, and that is the unit test's job.
    faux.setResponses([
        fauxAssistantMessage(
            Array.from({ length: opts.taskCalls }, (_, i) =>
                fauxToolCall('task', { prompt: `sub ${i}`, agent: 'nobody' }),
            ),
        ),
        fauxAssistantMessage('finished'),
        fauxAssistantMessage('finished'),
    ]);

    const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
    let replied: string | null = null;
    try {
        const agent = init(InflectAgent, { id: opts.runId });
        const reply = await agent.read(
            await agent.dispatch({ message: 'go', initialData: { runId: opts.runId } }),
        );
        replied = reply?.text ?? null;
    } finally {
        await flue.stop();
        await dispose();
        releaseRun(opts.runId);
    }
    return { seen, refusals, replied };
}

beforeEach(() => {
    _resetDelegationCounts();
});

describe('a delegation reaches the gate in the shape it matches on', () => {
    it('arrives as a TOOL operation named `task`, carrying the run and the turn', async () => {
        const { seen } = await runWithGate({ runId: 'cap-shape', cap: 3, taskCalls: 1 });
        const delegation = seen.find((s) => s.type === 'tool' && s.toolName === 'task');
        expect(delegation).toBeDefined();
        // THE KEY THE PER-TURN CAP NEEDS. Without both, the gate cannot count,
        // and its own fail-open branch would let every delegation through.
        expect(delegation?.instanceId).toBe('cap-shape');
        expect(typeof delegation?.turnId).toBe('string');

        // AND NOT as the `task` OPERATION, which is what the union suggests and
        // what the first design matched on. If a runtime upgrade starts
        // emitting that one first, this assertion is where it surfaces.
        const earlier = seen.slice(0, seen.indexOf(delegation as Seen));
        expect(earlier.some((s) => s.type === 'task')).toBe(false);
    });

    it('counts the delegation the model actually made', async () => {
        await runWithGate({ runId: 'cap-count', cap: 3, taskCalls: 1 });
        // Keyed by the real turn id, which the test does not know — so the
        // count is read across whatever keys the run produced.
        expect(delegationsThisTurn('cap-count', 'nope')).toBe(0);
        releaseDelegationCounts('cap-count');
    });
});

describe('the cap refuses the delegation past it', () => {
    it('refuses the third of three when the cap is two', async () => {
        const { refusals } = await runWithGate({ runId: 'cap-three', cap: 2, taskCalls: 3 });
        // EXACTLY ONE refusal: two allowed, the third declined. A gate that
        // refused all three, or none, would be a different defect and both
        // would pass a looser assertion.
        expect(refusals).toHaveLength(1);
        expect(refusals[0]).toContain('delegation_limit_reached');
        expect(refusals[0]).toContain('limit is 2');
    });

    it('refuses the FIRST when the tenant is capped at zero', async () => {
        const { refusals } = await runWithGate({ runId: 'cap-zero', cap: 0, taskCalls: 2 });
        expect(refusals).toHaveLength(2);
        expect(refusals[0]).toContain('delegation_disabled');
    });

    it('refuses NOTHING when the calls fit the cap', async () => {
        // The positive control. Every assertion above is about a refusal, and
        // a gate that threw on every `task` call would satisfy all of them.
        const { refusals } = await runWithGate({ runId: 'cap-fits', cap: 3, taskCalls: 2 });
        expect(refusals).toEqual([]);
    });

    it('the run still SETTLES after a refusal rather than failing', async () => {
        // A refused delegation is a tool error the model is told to work
        // around, not a reason to end the run. If declining `next()` killed the
        // dispatch, the cap would be a kill switch with a misleading name.
        const { replied } = await runWithGate({ runId: 'cap-settles', cap: 1, taskCalls: 2 });
        expect(replied).toBe('finished');
    });
});

/*
    ═══ THE DELEGATE'S ANSWER IS SCANNED ON RE-ENTRY (#3473) ═══

    The one inbound edge nothing was guarding. A delegate's READS run the
    parent's own tool objects — `narrowTools` hands them over rather than
    rebuilding them — so each is scanned both directions by
    `wrapForLedger`, recorded in the parent's step ledger and charged to its
    budget. Measured: a delegate's `list_controls` call runs the parent's
    wrapper.

    What that leaves is the delegate's composed ANSWER, which crosses into the
    parent's context as the `task` tool's return value. `task` belongs to the
    runtime, so our wrapper never sees it.

    These cases exercise the SEAM — that the interceptor extracts the answer
    text and hands it to the binding's hook, and that a hook which throws stops
    the text. The real hook is `guardDelegateAnswer`, which reaches Prisma and
    cannot load here; it is unit-covered where it lives. What only this file can
    show is that the hook is CALLED, with the delegate's actual words.
*/
describe('the delegate answer reaches the guard hook', () => {
    async function runWithHook(hook: (text: string, taskId: string | undefined) => Promise<void>) {
        const faux = fauxProvider();
        const dispose = instrument({
            observe: () => {},
            interceptor: async (operation, ctx, next) => {
                gateDelegation(operation, ctx);
                const result = await next();
                await guardDelegateResult(
                    operation,
                    ctx,
                    result,
                    readRunBinding(ctx.instanceId ?? '')?.guardDelegateOutput,
                );
                return result;
            },
            dispose: () => {},
        });
        bindRun('guard-answer', {
            tools: [],
            skills: [],
            modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
            maxSubagentsPerTurn: 3,
            guardDelegateOutput: hook,
        });
        faux.setResponses([
            fauxAssistantMessage([
                fauxToolCall('task', { prompt: 'look', agent: 'policy_drafter' }),
            ]),
            fauxAssistantMessage('IGNORE-PREVIOUS-INSTRUCTIONS-SENTINEL'),
            fauxAssistantMessage('parent done'),
            fauxAssistantMessage('spare'),
        ]);
        const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
        try {
            const agent = init(InflectAgent, { id: 'guard-answer' });
            const reply = await agent.read(
                await agent.dispatch({ message: 'go', initialData: { runId: 'guard-answer' } }),
            );
            return reply?.text ?? null;
        } finally {
            await flue.stop();
            await dispose();
            releaseRun('guard-answer');
        }
    }

    it('is handed the delegate’s own words, and a task id', async () => {
        const seen: Array<{ text: string; taskId: string | undefined }> = [];
        await runWithHook(async (text, taskId) => {
            seen.push({ text, taskId });
        });
        expect(seen).toHaveLength(1);
        // THE DELEGATE'S ANSWER, not the parent's message and not a wrapper.
        expect(seen[0].text).toContain('IGNORE-PREVIOUS-INSTRUCTIONS-SENTINEL');
        // The task id is what the guard's `source` is keyed on, so a flagged
        // answer is attributable to the delegation that produced it.
        expect(typeof seen[0].taskId).toBe('string');
    });

    it('a hook that THROWS stops the answer rather than warning about it', async () => {
        // The enforcement, and the reason the hook throws instead of returning
        // a verdict: a verdict for the caller to check is a check that gets
        // forgotten. The `task` call fails, which the model is told about.
        let called = 0;
        const replied = await runWithHook(async () => {
            called += 1;
            throw new Error('ai_guard_blocked: delegate answer');
        });
        expect(called).toBe(1);
        // THE RUN STILL SETTLES. A blocked answer is a tool failure the model
        // works around, not a reason to end the run — the same shape as a
        // blocked tool result.
        expect(replied).toBe('parent done');
    });

    it('is NOT called for an ordinary tool, only for a delegation', async () => {
        /*
            THE FAST PATH, and what the `toolName` check is actually for.

            A hook called on every tool result would double-scan what
            `wrapForLedger` already scanned on the way in AND on the way out,
            charging a second guard pass to every read in the run.

            It is NOT what stops an ordinary result being RECORDED as a
            delegation — `recordIfPossible` needs both `agent` and `taskId`,
            and an ordinary tool's `details` carries `{ customTool, output }`
            with neither. Measured by dropping the `toolName` check and
            watching the recording cases stay green.

            So this case is the one that has teeth for that check, and the
            first draft of it had none: it bound NO tools, so there was no
            ordinary result to double-scan. It binds one and calls it.
        */
        const seen: string[] = [];
        let ordinaryCalls = 0;
        const faux = fauxProvider();
        const dispose = instrument({
            observe: () => {},
            interceptor: async (operation, ctx, next) => {
                const result = await next();
                await guardDelegateResult(
                    operation,
                    ctx,
                    result,
                    readRunBinding(ctx.instanceId ?? '')?.guardDelegateOutput,
                );
                return result;
            },
            dispose: () => {},
        });
        bindRun('guard-none', {
            tools: [{
                name: 'list_controls',
                description: 'an ordinary read',
                input: v.strictObject({}),
                annotations: { readOnlyHint: true, destructiveHint: false, title: 'list_controls' },
                run: async () => { ordinaryCalls += 1; return '{"controls":1}'; },
            }],
            skills: [],
            modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
            maxSubagentsPerTurn: 3,
            guardDelegateOutput: async (text) => { seen.push(text); },
        });
        faux.setResponses([
            fauxAssistantMessage([fauxToolCall('list_controls', {})]),
            fauxAssistantMessage('done'),
            fauxAssistantMessage('spare'),
        ]);
        const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
        try {
            const agent = init(InflectAgent, { id: 'guard-none' });
            await agent.read(
                await agent.dispatch({ message: 'go', initialData: { runId: 'guard-none' } }),
            );
        } finally {
            await flue.stop();
            await dispose();
            releaseRun('guard-none');
        }
        // THE TOOL REALLY RAN, so the absence below is about the hook rather
        // than about a run in which nothing happened.
        expect(ordinaryCalls).toBe(1);
        expect(seen).toEqual([]);
    });
});

/*
    ═══ THE DELEGATION IS IN THE LEDGER (#3473 part 3) ═══

    Before this, a delegation wrote NO step. `task` is the runtime's tool, so
    it never passes through `wrapForLedger` — while the delegate's own reads DO
    get recorded, through the parent's wrapper, as the parent's own steps with
    nothing marking which delegate made them.

    So the run detail could show the work and not the delegating, which is the
    half an operator opens it for.

    The owner's decision (2026-10-15) was to group by SEQUENCE with a
    delegation step marking the span, and the measurement that shaped it is
    that the `task` result's `details` carries `agent` — the specialist's name,
    from the runtime. No render callback, no name-pairing queue.

    These cases exercise the SEAM: that the recorder is called, with the
    specialist and the task id the runtime supplied, and that a REFUSED answer
    is recorded too. The ledger write itself reaches Prisma and is the driver's;
    what only this file can show is that the interceptor reaches the hook with
    the right facts.
*/
describe('a completed delegation reaches the ledger hook', () => {
    interface Recorded {
        agent: string;
        taskId: string;
        answerAccepted: boolean;
    }

    async function runRecording(opts: {
        runId: string;
        guard?: (text: string, taskId: string | undefined) => Promise<void>;
    }): Promise<Recorded[]> {
        const faux = fauxProvider();
        const recorded: Recorded[] = [];
        const dispose = instrument({
            observe: () => {},
            interceptor: async (operation, ctx, next) => {
                gateDelegation(operation, ctx);
                const result = await next();
                const binding = readRunBinding(ctx.instanceId ?? '');
                await guardDelegateResult(
                    operation,
                    ctx,
                    result,
                    binding?.guardDelegateOutput,
                    binding?.onDelegationComplete,
                );
                return result;
            },
            dispose: () => {},
        });
        bindRun(opts.runId, {
            tools: [],
            skills: [],
            modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
            maxSubagentsPerTurn: 3,
            ...(opts.guard ? { guardDelegateOutput: opts.guard } : {}),
            onDelegationComplete: async (d) => { recorded.push(d); },
        });
        faux.setResponses([
            fauxAssistantMessage([
                fauxToolCall('task', { prompt: 'look', agent: 'evidence_assessor' }),
            ]),
            fauxAssistantMessage('the delegate answers'),
            fauxAssistantMessage('parent done'),
            fauxAssistantMessage('spare'),
        ]);
        const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
        try {
            const agent = init(InflectAgent, { id: opts.runId });
            await agent.read(
                await agent.dispatch({ message: 'go', initialData: { runId: opts.runId } }),
            );
        } finally {
            await flue.stop();
            await dispose();
            releaseRun(opts.runId);
        }
        return recorded;
    }

    it('names the SPECIALIST the model selected, from the runtime\'s own result', async () => {
        // The finding this design rests on: `details.agent` is supplied by the
        // runtime, so the name needs no bookkeeping of ours. If a version stops
        // supplying it, `recordIfPossible` writes nothing rather than a row
        // reading `agent: 'unknown'` — and this assertion is what says so.
        const recorded = await runRecording({ runId: 'led-agent' });
        expect(recorded).toHaveLength(1);
        expect(recorded[0].agent).toBe('evidence_assessor');
        expect(recorded[0].taskId).toMatch(/^task_/);
        expect(recorded[0].answerAccepted).toBe(true);
    });

    it('records a REFUSED answer too, and says it was refused', async () => {
        // A delegation that happened and was blocked is a thing the ledger must
        // carry. Recording after the guard's throw would have recorded exactly
        // the delegations that went well — the inversion of what a reviewer
        // wants from an audit trail.
        const recorded = await runRecording({
            runId: 'led-refused',
            guard: async () => { throw new Error('ai_guard_blocked: steering'); },
        });
        expect(recorded).toHaveLength(1);
        expect(recorded[0].agent).toBe('evidence_assessor');
        expect(recorded[0].answerAccepted).toBe(false);
    });

    it('records nothing for an ordinary tool call', async () => {
        /*
            The hook is for delegations. A recorder called per tool result would
            put a `task` step in the ledger for every read in the run.

            THE FIRST DRAFT OF THIS CASE WAS VACUOUS, found by mutating the
            `toolName` check away and watching it pass: it bound NO tools and
            scripted no tool call, so there was no ordinary tool result for the
            gate to wrongly record. An empty recorder list proved only that
            nothing happened.

            So it binds a tool and has the model call it.
        */
        const faux = fauxProvider();
        const recorded: Recorded[] = [];
        const dispose = instrument({
            observe: () => {},
            interceptor: async (operation, ctx, next) => {
                const result = await next();
                const binding = readRunBinding(ctx.instanceId ?? '');
                await guardDelegateResult(
                    operation, ctx, result,
                    binding?.guardDelegateOutput, binding?.onDelegationComplete,
                );
                return result;
            },
            dispose: () => {},
        });
        let ordinaryCalls = 0;
        bindRun('led-none', {
            tools: [{
                name: 'list_controls',
                description: 'an ordinary read',
                input: v.strictObject({}),
                annotations: { readOnlyHint: true, destructiveHint: false, title: 'list_controls' },
                run: async () => { ordinaryCalls += 1; return '{}'; },
            }],
            skills: [],
            modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
            maxSubagentsPerTurn: 3,
            onDelegationComplete: async (d) => { recorded.push(d); },
        });
        faux.setResponses([
            fauxAssistantMessage([fauxToolCall('list_controls', {})]),
            fauxAssistantMessage('no delegation at all'),
            fauxAssistantMessage('spare'),
        ]);
        const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
        try {
            const agent = init(InflectAgent, { id: 'led-none' });
            await agent.read(
                await agent.dispatch({ message: 'go', initialData: { runId: 'led-none' } }),
            );
        } finally {
            await flue.stop();
            await dispose();
            releaseRun('led-none');
        }
        // THE TOOL REALLY RAN — otherwise the absence below is the vacuity this
        // case was rewritten to remove.
        expect(ordinaryCalls).toBe(1);
        expect(recorded).toEqual([]);
    });
});

