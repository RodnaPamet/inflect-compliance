import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { InflectAgent } from '@/lib/agentic/flue/agent';
import { bindRun, releaseRun } from '@/lib/agentic/flue/run-binding';
import { installFlueTelemetry } from '@/lib/agentic/flue/telemetry';
import { releaseDelegationCounts, _resetDelegationCounts } from '@/lib/agentic/flue/delegation-gate';

/**
 * THE PRODUCTION INTERCEPTOR ASKS THE RUN BEFORE EVERY MODEL CALL (#4196).
 *
 * The kill switch was asked once, before boot, and then only at the tool
 * boundary. Mid-run, each tool call was refused and the refusal reached the
 * model as a tool error; the model was called again and the run settled
 * COMPLETED. `beforeModelCall` on the run binding is the fix, and the
 * interceptor in `flue/telemetry.ts` is the only seam every model call passes
 * through.
 *
 * So this file installs the REAL interceptor, binds a run whose
 * `beforeModelCall` it controls, and reads the effect from the faux provider:
 * a refused call is a scripted response that was never consumed, which is
 * "nothing was sent" stated as a count.
 *
 * What `executeFlueRun` then does with the refusal (latch, settle ABORTED or
 * at the cap) is tested in `tests/unit/flue-kill-switch-stops-the-model-call.test.ts`.
 */

interface Outcome {
    /** How many times the run was asked, by operation order. */
    asks: number;
    /** Scripted responses the provider never handed out. */
    unconsumed: number;
    threw: string | null;
}

async function run(opts: {
    runId: string;
    /** The model's first reply: a tool call, a delegation, or plain text. */
    first: 'tool' | 'task' | 'text';
    /** Refuse the Nth ask (1-based). */
    refuseAsk?: number;
}): Promise<Outcome> {
    const dispose = installFlueTelemetry();
    const faux = fauxProvider();
    const first =
        opts.first === 'tool'
            ? fauxAssistantMessage([fauxToolCall('echo', { text: 'plain' })])
            : opts.first === 'task'
              ? fauxAssistantMessage([fauxToolCall('task', { prompt: 'sub', agent: 'risk_analyst' })])
              : fauxAssistantMessage('finished');
    faux.setResponses([first, fauxAssistantMessage('finished'), fauxAssistantMessage('finished')]);

    let asks = 0;
    bindRun(opts.runId, {
        tools: [
            {
                name: 'echo',
                description: 'Echo a string back.',
                input: v.object({ text: v.string() }),
                annotations: { readOnlyHint: true, destructiveHint: false, title: 'Echo' },
                run: async () => 'echoed',
            },
        ],
        skills: [],
        modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
        maxSubagentsPerTurn: 3,
        beforeModelCall: async () => {
            asks += 1;
            if (asks === opts.refuseAsk) throw new Error('This agent has been stopped by a kill switch.');
        },
    });

    const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
    let threw: string | null = null;
    try {
        const agent = init(InflectAgent, { id: opts.runId });
        await agent.read(await agent.dispatch({ message: 'go', initialData: { runId: opts.runId } }));
    } catch (err) {
        threw = err instanceof Error ? err.message : String(err);
    } finally {
        await flue.stop();
        await dispose();
        releaseRun(opts.runId);
        releaseDelegationCounts(opts.runId);
    }
    return { asks, unconsumed: faux.getPendingResponseCount(), threw };
}

beforeEach(() => {
    _resetDelegationCounts();
});

describe('the interceptor asks the run before every model call', () => {
    it('asks once per model call, and not for a tool call', async () => {
        // A tool call, then a final answer: two model calls and one tool call.
        const out = await run({ runId: 'ask-tool', first: 'tool' });

        expect(out.threw).toBeNull();
        expect(out.unconsumed).toBe(1);
        expect(out.asks).toBe(2);
    });

    it('sends nothing when the ask refuses: the call is never made', async () => {
        const out = await run({ runId: 'ask-refuse', first: 'tool', refuseAsk: 2 });

        // The first call was made and the second refused before it was sent,
        // so two of the three scripted responses are still waiting.
        expect(out.asks).toBe(2);
        expect(out.unconsumed).toBe(2);
    });

    it('refuses the first call too, so nothing at all is sent', async () => {
        const out = await run({ runId: 'ask-first', first: 'text', refuseAsk: 1 });

        expect(out.asks).toBe(1);
        expect(out.unconsumed).toBe(3);
    });

    it("asks before a delegate's model call as well as the parent's", async () => {
        // Parent delegates; the delegate answers; the parent answers. A
        // delegate's model call carries the parent run's instance id, so the
        // parent's binding is found and asked.
        const out = await run({ runId: 'ask-task', first: 'task' });

        expect(out.threw).toBeNull();
        expect(out.unconsumed).toBe(0);
        expect(out.asks).toBe(3);
    });
});
