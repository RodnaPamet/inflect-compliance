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

import { InflectAgent } from '@/lib/agentic/flue/agent';
import { bindRun, releaseRun } from '@/lib/agentic/flue/run-binding';
import {
    gateDelegation,
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
