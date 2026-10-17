import { createModels, type Context } from '@earendil-works/pi-ai';

import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import { buildFlueProviders } from '@/lib/agentic/flue/providers';
import type { FlueProviderTerms } from '@/lib/agentic/flue/runtime-bootstrap';

/**
 * THE FLUE EXTERNAL ROUTE NAMES ITS WORKSPACE — on the wire, not on a field.
 *
 * An organisation-level `ANTHROPIC_API_KEY` is refused with HTTP 400 unless
 * every request carries `anthropic-workspace-id`. For the Flue runtime that
 * header has to survive two libraries before it reaches a socket: pi-ai's
 * `Models` collection, and the Anthropic SDK client pi builds per request. pi
 * 0.83 accepts a provider-level `headers` option and then never sends it, so
 * asserting that SOME field holds the id proves nothing — it is the field that
 * looks right and is not read.
 *
 * So these cases register the provider the way the runtime does (one
 * `Models` collection, the provider set on it, the model resolved by id), make
 * a real completion call, and read the headers off the request the SDK hands
 * to `fetch`. The `fetch` is pi's documented request-option seam; it answers a
 * 400 so nothing streams, and nothing leaves the process.
 */

const MODEL_ID = 'claude-x';
const CONTEXT: Context = {
    messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
};

/** The headers of every request the external route sent for one completion. */
async function requestHeadersFor(terms: FlueProviderTerms): Promise<Headers[]> {
    const [external] = buildFlueProviders(terms, { externalModel: MODEL_ID });
    if (!external) throw new Error('no external provider was built for these terms');

    const models = createModels();
    models.setProvider(external);
    const model = models.getModel(FLUE_PROVIDER_IDS.external, MODEL_ID);
    if (!model) throw new Error('the external model did not resolve by id');

    const sent: Headers[] = [];
    const captureFetch: typeof fetch = async (input, init) => {
        sent.push(
            input instanceof Request ? new Headers(input.headers) : new Headers(init?.headers),
        );
        return new Response(
            JSON.stringify({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'captured by the test' },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
        );
    };

    // The 400 surfaces as an error result rather than a throw in pi; either is
    // fine here, because the request — the only thing under test — has gone.
    await models
        .completeSimple(model, CONTEXT, { fetch: captureFetch, maxRetries: 0 })
        .catch(() => undefined);
    return sent;
}

describe('the Flue external provider and anthropic-workspace-id', () => {
    it('sends the workspace id on the request when one is configured', async () => {
        const sent = await requestHeadersFor({
            externalApiKey: 'sk-test',
            externalWorkspaceId: 'wrkspc_01TESTWORKSPACE',
        });
        expect(sent.length).toBeGreaterThan(0);
        for (const headers of sent) {
            expect(headers.get('anthropic-workspace-id')).toBe('wrkspc_01TESTWORKSPACE');
            // Beside the credential, not instead of it.
            expect(headers.get('x-api-key')).toBe('sk-test');
        }
    });

    it('sends no workspace header when none is configured — a workspace key is unchanged', async () => {
        const sent = await requestHeadersFor({ externalApiKey: 'sk-test' });
        expect(sent.length).toBeGreaterThan(0);
        for (const headers of sent) {
            expect(headers.has('anthropic-workspace-id')).toBe(false);
            expect(headers.get('x-api-key')).toBe('sk-test');
        }
    });

    it('treats a blank workspace id as unset rather than sending an empty header', async () => {
        const sent = await requestHeadersFor({ externalApiKey: 'sk-test', externalWorkspaceId: '   ' });
        expect(sent.length).toBeGreaterThan(0);
        for (const headers of sent) {
            expect(headers.has('anthropic-workspace-id')).toBe(false);
        }
    });

    it('leaves the model without a headers field when no workspace is configured', () => {
        // "Byte-for-byte unchanged" at the declaration too: the model a
        // workspace-scoped deployment registers is the one it registered before.
        const [external] = buildFlueProviders(
            { externalApiKey: 'sk-test' },
            { externalModel: MODEL_ID },
        );
        const [model] = external.getModels();
        expect('headers' in model).toBe(false);
    });
});
