/**
 * THE PREMISE THE PER-CALL ART 12 RECORD STANDS ON, MEASURED AGAINST THE REAL
 * RUNTIME.
 *
 * `execute.ts` records one `AiDecisionLog` row per model call, and it can only
 * do that because the runtime reports usage at a finer grain than any hook an
 * agent declares. The shipped docs say so twice:
 *
 *   · `events.md` — "One model call is one turn, correlated by `turnId`", and
 *     `ModelResponse.usage` is "provider-reported token and cost usage for this
 *     single call … Turn usage is the leaf level — `operation` and `compaction`
 *     roll-ups already include it".
 *   · `agent-hooks-api.md` — `useResponseFinish` "runs after the final finish
 *     cycle … its `response.usage` and `response.toolCalls` aggregates are
 *     final", and `useAgentFinish`'s is "the aggregate usage so far".
 *
 * A citation is a claim about a document, not about the package installed here.
 * This file is the measurement: a real run through the real runtime, with the
 * real `observe()`, and the numbers read back off it.
 *
 * ── THE DISCRIMINATOR ───────────────────────────────────────────────────────
 *
 * A reader that took the aggregate and a reader that took the leaf produce
 * IDENTICAL output on a one-call run. So the assertions below are the two that
 * tell the readers apart on a multi-call one: the count of usage-bearing turn
 * events equals the provider's own count of calls served, and no single call's
 * usage is the run's total.
 *
 * `faux.state.callCount` is the independent witness — it is incremented by the
 * provider, not by the runtime and not by the code under test, so a runtime
 * that stopped emitting a turn event per call cannot keep this green by
 * emitting a different number of events.
 */
import {
    fauxProvider,
    fauxAssistantMessage,
    fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { init, observe, type FlueEvent, type FlueEventContext } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { InflectAgent } from '@/lib/agentic/flue/agent';
import { bindRun, releaseRun, type FlueRunBinding } from '@/lib/agentic/flue/run-binding';

/** A tool shaped exactly as the adapter emits one, without importing it. */
function listRisks(): FlueRunBinding['tools'][number] {
    return {
        name: 'list_risks',
        description: 'List the tenant risks.',
        input: v.strictObject({}),
        annotations: { readOnlyHint: true, destructiveHint: false, title: 'list_risks' },
        run: async () => '{"risks":3}',
    };
}

/** What `execute.ts` collects: one record per model call, from the turn event. */
interface Collected {
    instanceId: string;
    totalTokens: number;
    durationMs: number;
}

describe('the runtime reports usage per model call, and `observe()` delivers it', () => {
    it('emits one usage-bearing turn event per call the provider served', async () => {
        const faux = fauxProvider();
        const runId = 'run-per-call-usage';
        const collected: Collected[] = [];

        bindRun(runId, {
            tools: [listRisks()],
            modelSpecifier: `${faux.provider.id}/${faux.getModel().id}`,
        });
        // The first call chooses a tool and the second answers, so the two
        // calls cannot report the same numbers — the second's prompt carries
        // the first's output. The queue is deliberately longer than the run
        // needs: an exhausted faux provider fails the submission, which would
        // make the measurement about the fixture rather than the runtime.
        faux.setResponses([
            fauxAssistantMessage([fauxToolCall('list_risks', {})]),
            fauxAssistantMessage('Three risks, all low.'),
            fauxAssistantMessage('Three risks, all low.'),
            fauxAssistantMessage('Three risks, all low.'),
        ]);

        const stop = observe((event: FlueEvent, ctx: FlueEventContext) => {
            if (event.type !== 'turn') return;
            const usage = event.response.usage;
            if (!usage) return;
            collected.push({
                instanceId: ctx.id,
                totalTokens: usage.totalTokens,
                durationMs: event.durationMs,
            });
        });

        const flue = await start({ agents: [InflectAgent], providers: [faux.provider] });
        try {
            const agent = init(InflectAgent, { id: runId });
            await agent.read(
                await agent.dispatch({ message: 'How many risks?', initialData: { runId } }),
            );

            // ── THE GRANULARITY, against a witness the runtime does not own ──
            expect(collected.length).toBe(faux.state.callCount);
            // …and the run really was multi-call, or the claim above is about
            // a population of one and the aggregate would have matched it.
            expect(collected.length).toBeGreaterThan(1);

            // ── THE CORRELATION ─────────────────────────────────────────────
            //
            // `observe()` is isolate-global, so `ctx.id` is the only thing that
            // makes a turn event THIS run's. `execute.ts` filters on exactly
            // this equality, and the instance id is the run id.
            expect(new Set(collected.map((c) => c.instanceId))).toEqual(new Set([runId]));

            // ── THE DISCRIMINATOR ───────────────────────────────────────────
            //
            // Different calls reporting different numbers, none of which is the
            // total. A reader that took the aggregate reports ONE number here,
            // and the number it reports is `sum` — which is what the row this
            // fix replaced carried.
            const sum = collected.reduce((n, c) => n + c.totalTokens, 0);
            expect(new Set(collected.map((c) => c.totalTokens)).size).toBeGreaterThan(1);
            for (const call of collected) {
                expect(call.totalTokens).toBeGreaterThan(0);
                expect(call.totalTokens).toBeLessThan(sum);
                // Each call carries its own clock, which is where the decision
                // row's `latencyMs` comes from. An aggregate has none.
                expect(call.durationMs).toBeGreaterThanOrEqual(0);
            }
        } finally {
            stop();
            releaseRun(runId);
            await flue.stop();
        }
    }, 60_000);
});
