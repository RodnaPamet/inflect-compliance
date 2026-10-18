import { createModels, type Context } from '@earendil-works/pi-ai';

import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import { buildFlueProviders } from '@/lib/agentic/flue/providers';

/**
 * THE FLUE EXTERNAL ROUTE ASKS FOR THINKING IN A SHAPE THE MODEL ACCEPTS —
 * read off the request body, not off the model declaration.
 *
 * The agent runtime runs on `claude-sonnet-5-5` (owner decision, 2026-10-18).
 * Sonnet 5.5 refuses a thinking budget with HTTP 400, and pi 0.83 sends one —
 * `thinking: { type: "enabled", budget_tokens }` — for any model whose
 * declaration does not set `compat.forceAdaptiveThinking`. Flue asks for
 * reasoning on every turn (its default level is `medium`, compaction asks for
 * `high`), so without the flag EVERY run would be refused before it produced a
 * token. The declaration half is in providers-are-built-from-terms.test.ts;
 * this is the half that cannot be satisfied by a field nobody reads.
 *
 * Same seam as external-provider-sends-workspace-header.test.ts: register the
 * provider as the runtime does, make a real completion call, and read the body
 * the SDK hands to `fetch`, which answers a 400 so nothing streams and nothing
 * leaves the process.
 */

const CONTEXT: Context = {
    messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
};

/** The JSON bodies the external route sent for one completion at `reasoning`. */
async function requestBodiesFor(modelId: string, reasoning: 'medium' | 'high'): Promise<Record<string, unknown>[]> {
    const [external] = buildFlueProviders({ externalApiKey: 'sk-test' }, { externalModel: modelId });
    if (!external) throw new Error('no external provider was built');

    const models = createModels();
    models.setProvider(external);
    const model = models.getModel(FLUE_PROVIDER_IDS.external, modelId);
    if (!model) throw new Error('the external model did not resolve by id');

    const sent: Record<string, unknown>[] = [];
    const captureFetch: typeof fetch = async (input, init) => {
        const raw = input instanceof Request ? await input.text() : String(init?.body);
        sent.push(JSON.parse(raw) as Record<string, unknown>);
        return new Response(
            JSON.stringify({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'captured by the test' },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
        );
    };

    await models
        .completeSimple(model, CONTEXT, { fetch: captureFetch, maxRetries: 0, reasoning })
        .catch(() => undefined);
    return sent;
}

describe('the thinking shape the Flue external route sends', () => {
    it.each(['medium', 'high'] as const)(
        'claude-sonnet-5-5 at %s: adaptive thinking and an effort level, never a budget',
        async (reasoning) => {
            const bodies = await requestBodiesFor('claude-sonnet-5-5', reasoning);
            expect(bodies.length).toBeGreaterThan(0);
            for (const body of bodies) {
                expect(body.model).toBe('claude-sonnet-5-5');
                expect(body.thinking).toMatchObject({ type: 'adaptive' });
                expect(body.thinking).not.toHaveProperty('budget_tokens');
                expect(body.output_config).toEqual({ effort: reasoning });
            }
        },
    );

    it('claude-haiku-4-5 keeps the budget it takes — adaptive thinking is not one of its shapes', async () => {
        // The other direction. Haiku 4.5 predates adaptive thinking, and is
        // still a model an operator may name, so it must not be moved with the rest.
        const bodies = await requestBodiesFor('claude-haiku-4-5', 'medium');
        expect(bodies.length).toBeGreaterThan(0);
        for (const body of bodies) {
            expect(body.thinking).toMatchObject({ type: 'enabled' });
            expect(typeof (body.thinking as { budget_tokens?: unknown }).budget_tokens).toBe('number');
            expect(body).not.toHaveProperty('output_config');
        }
    });
});
