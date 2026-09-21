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

            // …and the binding was CLAIMED, not merely read. Asserted inside
            // the successful run rather than in a second one: a separate
            // dispatch would need its own scripted responses and its own
            // runtime start, and would be testing the map rather than the
            // agent's use of it. A `get` would leave this at `before + 1`.
            expect(outstandingRunBindings()).toBe(before);
        } finally {
            releaseRun('run-bound');
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
