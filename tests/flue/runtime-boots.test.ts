/**
 * THE LOOP EXECUTES — asserted, not described.
 *
 * Everything else about this integration is decidable from source: which model
 * a residency may ask for, which providers a deployment may register, which
 * runtime capabilities are refused. This is the one claim that can only be made
 * by running it, and until now it was made by a transcript pasted into a note.
 *
 * ── WHY THIS FILE LIVES IN ITS OWN JEST PROJECT ─────────────────────────────
 *
 * `@flue/runtime` is ESM-only with no `require` condition, so jest's CJS
 * resolver cannot find it — a RESOLUTION failure, which the repo's existing
 * `ESM_TRANSFORM_ALLOW_LIST` does not address, and which `require.resolve`
 * cannot be used to work around either (`ERR_PACKAGE_PATH_NOT_EXPORTED`).
 *
 * The fix is scoped rather than global: a third jest project whose
 * `customExportConditions` prefer `import`, matching only `tests/flue/**`. The
 * other 2040 test files keep the resolution they have. Changing it for all of
 * them would silently re-point every package that ships both conditions.
 *
 * ── NO DATABASE, NO ENV, NO NETWORK ─────────────────────────────────────────
 *
 * The provider is pi-ai's `fauxProvider`, whose responses are scripted here, so
 * this asserts the RUNTIME's behaviour and never a vendor's. It needs no
 * credential and makes no request, which is what lets it run on every PR.
 */
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { init, useModel, useTool } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

describe('the Flue runtime, embedded in this process', () => {
    // Timeout on the CASE, not via `jest.setTimeout` — in ESM mode there is
    // no `jest` global unless imported from `@jest/globals`.
    it('boots, calls a tool the model chose, and answers', async () => {
        const faux = fauxProvider();
        const model = faux.getModel();
        const toolCalls: unknown[] = [];

        // SYNCHRONOUS. The runtime refuses an async agent function outright —
        // "Move async work into tools, actions, or resource factories" — and
        // nothing in the type signature says so, which is why it is asserted
        // by construction here rather than left to a comment.
        function Probe() {
            useModel(`${faux.provider.id}/${model.id}`);
            useTool({
                name: 'count_controls',
                description: 'Count the tenant controls.',
                input: v.strictObject({ framework: v.optional(v.string()) }),
                run: async (ctx: { data: unknown }) => {
                    toolCalls.push(ctx.data);
                    return '42';
                },
            });
        }

        faux.setResponses([
            fauxAssistantMessage([fauxToolCall('count_controls', { framework: 'ISO27001' })]),
            fauxAssistantMessage('There are 42 controls.'),
        ]);

        const flue = await start({ agents: [Probe], providers: [faux.provider] });
        try {
            const agent = init(Probe, { id: 'probe-1' });
            const receipt = await agent.dispatch('How many controls?');
            const reply = await agent.read(receipt);

            // The THREE facts, together. The reply alone would pass against a
            // runtime that never called the tool; the tool call alone would
            // pass against one that never finished.
            expect({
                text: reply?.text,
                toolCalls,
                modelCalls: faux.state.callCount,
            }).toEqual({
                text: 'There are 42 controls.',
                // The arguments the MODEL chose, arriving at our handler —
                // which is the seam the whole adapter exists to serve.
                toolCalls: [{ framework: 'ISO27001' }],
                modelCalls: 2,
            });
        } finally {
            await flue.stop();
        }
    }, 60_000);
});
