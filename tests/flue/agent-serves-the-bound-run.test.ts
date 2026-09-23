/**
 * THE FIXED AGENT SERVES THE RUN IT WAS BOUND FOR — and refuses when it was
 * bound for none.
 *
 * `start({ agents })` fixes the agent set at boot, so there is one agent
 * function and every run goes through it. What varies per run arrives in the
 * binding, which the DRIVER resolved under the caller's authority before
 * dispatch.
 *
 * ── WHY THIS FILE IMPORTS ALMOST NOTHING ────────────────────────────────────
 *
 * The agent module holds the only VALUE import of `@flue/runtime` in `src/`,
 * so it can only be loaded under this ESM project — and the app graph does not
 * load here at all: an earlier draft imported the tools adapter and the suite
 * died in `pg` with "Class extends value [object Module] is not a
 * constructor", before a single assertion ran.
 *
 * That is why the binding carries RESOLVED tools rather than the
 * `McpInvocation` that produced them. The resolution happens in the driver, in
 * ordinary Node; the agent registers what it was handed. The narrower thing
 * also cannot be widened: no edit inside the agent can reach for more
 * authority, because the inputs that decide authority are not in scope.
 */
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { InflectAgent } from '@/lib/agentic/flue/agent';
import {
    bindRun,
    releaseRun,
    outstandingRunBindings,
    type FlueRunBinding,
} from '@/lib/agentic/flue/run-binding';

/** A tool shaped exactly as the adapter emits one, without importing it. */
function listRisks(onCall: (args: unknown) => void): FlueRunBinding['tools'][number] {
    return {
        name: 'list_risks',
        description: 'List the tenant risks.',
        input: v.strictObject({}),
        annotations: { readOnlyHint: true, destructiveHint: false, title: 'list_risks' },
        run: async (ctx) => {
            onCall(ctx.data);
            return '{"risks":3}';
        },
    };
}

describe('a bound run', () => {
    it('gets its tools, and the model actually calls one', async () => {
        const faux = fauxProvider();
        const called: unknown[] = [];
        const before = outstandingRunBindings();
        bindRun('run-bound', {
            tools: [listRisks((a) => called.push(a))],
            modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
        });
        faux.setResponses([
            fauxAssistantMessage([fauxToolCall('list_risks', {})]),
            fauxAssistantMessage('Three risks.'),
        ]);

        const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
        try {
            const agent = init(InflectAgent, { id: 'run-bound' });
            const reply = await agent.read(
                await agent.dispatch({
                    message: 'How many risks?',
                    // The RUN ID only. `initialData` is part of the durable
                    // record stream and explicitly "not a secrets channel".
                    initialData: { runId: 'run-bound' },
                }),
            );

            expect({ text: reply?.text, toolCalls: called.length }).toEqual({
                text: 'Three risks.',
                toolCalls: 1,
            });

            // …and the binding SURVIVES the render. This assertion used to
            // read `toBe(before)` and called the binding "CLAIMED, not merely
            // read" — the runtime re-renders the agent before EVERY model
            // call, so claiming it on the first render left every later turn
            // with no authority at all. Disposal is the driver's `finally`,
            // which is what the `releaseRun` below stands in for here.
            expect(outstandingRunBindings()).toBe(before + 1);
        } finally {
            releaseRun('run-bound');
            await flue.stop();
        }
    }, 60_000);

    it('still has its tools on the SECOND turn', async () => {
        // THE REGRESSION TEST. The one above cannot see the defect: its tool
        // call happens on turn 1, while the binding is still there, and turn 2
        // only produces text. So it passed throughout.
        //
        // Two tool calls in two separate assistant turns is what separates the
        // designs. With the destructive read, turn 2 re-rendered the agent,
        // found nothing, registered ZERO tools and told the model the run
        // could not be bound — so `called` held one entry, not two, and the
        // run still settled as though it had finished its work.
        const faux = fauxProvider();
        const called: unknown[] = [];
        const before = outstandingRunBindings();
        bindRun('run-two-turns', {
            tools: [listRisks((a) => called.push(a))],
            modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
        });
        faux.setResponses([
            fauxAssistantMessage([fauxToolCall('list_risks', {})]),
            fauxAssistantMessage([fauxToolCall('list_risks', {})]),
            fauxAssistantMessage('Three risks, twice.'),
        ]);

        const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
        try {
            const agent = init(InflectAgent, { id: 'run-two-turns' });
            const reply = await agent.read(
                await agent.dispatch({
                    message: 'Count the risks twice.',
                    initialData: { runId: 'run-two-turns' },
                }),
            );

            expect({ text: reply?.text, toolCalls: called.length }).toEqual({
                text: 'Three risks, twice.',
                toolCalls: 2,
            });
            expect(outstandingRunBindings()).toBe(before + 1);
        } finally {
            releaseRun('run-two-turns');
            await flue.stop();
        }
    }, 60_000);

});

describe('an UNBOUND run fails closed', () => {
    it('registers no tools, so there is nothing for the model to call', async () => {
        // A dispatch naming a run nobody resolved must not inherit a default
        // authority. The model is told, and handed nothing.
        const faux = fauxProvider();
        const called: unknown[] = [];
        // Deliberately bind a DIFFERENT run, so a lookup bug that ignored the
        // id would find this and hand over its tools.
        bindRun('some-other-run', {
            tools: [listRisks((a) => called.push(a))],
            modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
        });
        faux.setResponses([fauxAssistantMessage('I could not act.')]);

        const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
        try {
            const agent = init(InflectAgent, { id: 'run-unbound' });
            await agent
                .read(
                    await agent.dispatch({
                        message: 'How many risks?',
                        initialData: { runId: 'run-unbound' },
                    }),
                )
                .catch(() => undefined);

            // The decisive assertion: the OTHER run's tool never ran.
            expect(called).toEqual([]);
            expect(outstandingRunBindings()).toBeGreaterThan(0);
        } finally {
            releaseRun('some-other-run');
            await flue.stop();
        }
    }, 60_000);
});
