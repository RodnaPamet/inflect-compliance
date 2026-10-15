import type { Provider } from '@earendil-works/pi-ai';

import { buildFlueProviders, flueModelIsRegistered } from '@/lib/agentic/flue/providers';
import { FLUE_PROVIDER_IDS } from '@/lib/agentic/flue/model-selection';
import { flueProviderIdsFor } from '@/lib/agentic/flue/runtime-bootstrap';

/**
 * THE PROVIDER REGISTRY, BUILT AND INTERROGATED (#3617).
 *
 * `src/lib/agentic/flue/providers.ts` had **zero execution coverage** across all
 * six CI shards (measured on green main run 38794086501). It decides what routes
 * a deployment has: which vendor APIs are registered, under which ids, with
 * which credential, and — through `flueModelIsRegistered` — whether a specifier
 * can resolve at all. That last answer is the difference between a named refusal
 * an operator can act on and a stream error surfacing mid-run with the run row
 * already created.
 *
 * It was uncovered because its only production caller is `runtime-start.ts`,
 * which is itself a process-wide memoised boot and also at zero. Both import the
 * `.lazy` vendor APIs, so this file lives under the `flue` project — the only
 * one that can load them.
 *
 * Nothing here boots a runtime or calls a model. These are value-in, value-out
 * functions; the file simply asks them.
 */

const LOCAL_URL = 'http://gw:11434/v1';

describe('buildFlueProviders — which routes a deployment has', () => {
    it('answers with an explicit empty array, never undefined', () => {
        // The docstring promises "ALWAYS an explicit array, possibly empty". A
        // caller spreading `undefined` would throw at the boot site.
        expect(buildFlueProviders({}, {})).toEqual([]);
        expect(buildFlueProviders({ externalApiKey: null, localBaseUrl: null }, {})).toEqual([]);
    });

    it('registers the local route under the local id, serving the ids it was given', () => {
        const built = buildFlueProviders(
            { localBaseUrl: LOCAL_URL },
            { localModels: ['llama-3.1-70b', 'mistral-small'] },
        );
        expect(built.map((p) => p.id)).toEqual([FLUE_PROVIDER_IDS.local]);
        expect(built[0].getModels().map((m) => m.id)).toEqual([
            'llama-3.1-70b',
            'mistral-small',
        ]);
    });

    it('registers the local route on the BASE URL alone — a keyless gateway is normal', () => {
        // `FlueProviderTerms.localApiKey` says so in as many words: the base URL
        // is what makes the route exist, and treating the key as the test would
        // refuse a self-hosted gateway that needs none.
        expect(buildFlueProviders({ localBaseUrl: LOCAL_URL }, {}).map((p) => p.id)).toEqual([
            FLUE_PROVIDER_IDS.local,
        ]);
        // And a key with no base URL is NOT a route.
        expect(buildFlueProviders({ localApiKey: 'k' }, {}).map((p) => p.id)).toEqual([]);
    });

    it('registers a local route with no models when none are configured', () => {
        // Not an error: the deployment offers a gateway and no ids yet.
        // `flueModelIsRegistered` is what turns that into a refusal later.
        const built = buildFlueProviders({ localBaseUrl: LOCAL_URL }, { localModels: [] });
        expect(built).toHaveLength(1);
        expect(built[0].getModels()).toEqual([]);
    });

    it('needs BOTH a credential and a model id for the external route', () => {
        expect(
            buildFlueProviders({ externalApiKey: 'sk-test' }, { externalModel: 'claude-x' })
                .map((p) => p.id),
        ).toEqual([FLUE_PROVIDER_IDS.external]);
        // Either one alone is not a route.
        expect(buildFlueProviders({ externalApiKey: 'sk-test' }, {}).map((p) => p.id)).toEqual([]);
        expect(buildFlueProviders({}, { externalModel: 'claude-x' }).map((p) => p.id)).toEqual([]);
    });

    it('orders local first, external second — the order the docstring pins', () => {
        const built = buildFlueProviders(
            { localBaseUrl: LOCAL_URL, externalApiKey: 'sk-test' },
            { externalModel: 'claude-x', localModels: ['llama'] },
        );
        expect(built.map((p) => p.id)).toEqual([
            FLUE_PROVIDER_IDS.local,
            FLUE_PROVIDER_IDS.external,
        ]);
    });

    it('agrees id-for-id with flueProviderIdsFor when a model id is configured', () => {
        // The docstring invites exactly this comparison — "so the two functions
        // can be compared id-for-id by a test rather than by eye".
        const terms = { localBaseUrl: LOCAL_URL, externalApiKey: 'sk-test' };
        expect(
            buildFlueProviders(terms, { externalModel: 'claude-x', localModels: ['llama'] })
                .map((p) => p.id),
        ).toEqual([...flueProviderIdsFor(terms)]);
    });

    it('and DIVERGES from it when the external model id is missing — deliberately', () => {
        // Recorded rather than asserted-as-correct. `flueProviderIdsFor` tests
        // only the credential; `buildFlueProviders` needs a model id too. With a
        // key and no id they disagree on MEMBERSHIP, not just order.
        //
        // Unreachable in production today: the sole caller passes
        // `env.ANTHROPIC_MODEL`, which carries a schema default of
        // `claude-haiku-4-5` and so is never absent. This pins the divergence so
        // that if a second caller ever sources the id from somewhere defaultless,
        // the disagreement is already written down.
        const terms = { externalApiKey: 'sk-test' };
        expect([...flueProviderIdsFor(terms)]).toEqual([FLUE_PROVIDER_IDS.external]);
        expect(buildFlueProviders(terms, {}).map((p) => p.id)).toEqual([]);
    });

    it('declares the external model with the deployment bounds and zero cost', () => {
        const [external] = buildFlueProviders(
            { externalApiKey: 'sk-test' },
            { externalModel: 'claude-x' },
        );
        const [model] = external.getModels();
        expect(model.id).toBe('claude-x');
        expect(model.contextWindow).toBe(200_000);
        expect(model.maxTokens).toBe(64_000);
        // Zero throughout: spend is accounted by the run ledger, not by pi's
        // price table, and a non-zero here would be a second place to maintain.
        expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it('resolves the external credential from the ARGUMENT, not the ambient environment', async () => {
        // The property the external builder documents at length: pi's built-in
        // factories read their vendor env var themselves, which would mean a key
        // present in the environment registers a working route regardless of what
        // this deployment decided. Closing over the passed key keeps "has a
        // credential" and "has a route" the same fact.
        const before = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-ambient-must-not-win';  // pragma: allowlist secret -- synthetic string proving the builder ignores ambient env, not a real key
        try {
            const [external] = buildFlueProviders(
                { externalApiKey: 'sk-passed-in' },
                { externalModel: 'claude-x' },
            );
            const auth = external.auth?.apiKey;
            if (!auth) throw new Error('the external provider declared no apiKey auth');
            // The parameter is pi's `{ ctx, credential? }` bag. Building a real
            // `AuthContext` would add nothing: the resolver under test CLOSES
            // OVER the key and never reads its argument, which is precisely the
            // property being asserted — so no value of this parameter can change
            // the outcome, and the cast cannot hide a failure.
            const resolved = await auth.resolve({ ctx: {} } as Parameters<typeof auth.resolve>[0]);
            expect(resolved?.auth).toEqual({ apiKey: 'sk-passed-in' });
        } finally {
            if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
            else process.env.ANTHROPIC_API_KEY = before;
        }
    });
});

describe('flueModelIsRegistered — can this specifier resolve', () => {
    const providers = buildFlueProviders(
        { localBaseUrl: LOCAL_URL, externalApiKey: 'sk-test' },
        { externalModel: 'claude-x', localModels: ['llama-3.1-70b'] },
    );

    it('accepts a specifier the registered set can serve', () => {
        expect(
            flueModelIsRegistered(`${FLUE_PROVIDER_IDS.local}/llama-3.1-70b`, providers),
        ).toBe(true);
        expect(flueModelIsRegistered(`${FLUE_PROVIDER_IDS.external}/claude-x`, providers)).toBe(
            true,
        );
    });

    it('refuses an unknown provider, and a known provider with an unknown model', () => {
        expect(flueModelIsRegistered('somebody-else/llama-3.1-70b', providers)).toBe(false);
        // The half a provider-only check would miss: the route exists, the model
        // does not, and pi would fail mid-run rather than at the door.
        expect(flueModelIsRegistered(`${FLUE_PROVIDER_IDS.local}/not-served`, providers)).toBe(
            false,
        );
    });

    it('refuses a specifier that is not provider/model shaped', () => {
        expect(flueModelIsRegistered('no-slash-at-all', providers)).toBe(false);
        // A LEADING slash leaves an empty provider id. `slash <= 0` is what
        // catches it, and `< 0` would not.
        expect(flueModelIsRegistered('/llama-3.1-70b', providers)).toBe(false);
        expect(flueModelIsRegistered('', providers)).toBe(false);
    });

    it('refuses rather than throws when a provider catalogue throws', () => {
        // The documented contract: `getModels()` must not throw, pi treats a
        // throwing implementation as having no models, "so a refusal is the
        // honest answer if one ever does". Nothing exercised that sentence.
        const hostile = {
            id: FLUE_PROVIDER_IDS.local,
            getModels: () => {
                throw new Error('catalogue exploded');
            },
        } as unknown as Provider;
        expect(
            flueModelIsRegistered(`${FLUE_PROVIDER_IDS.local}/llama-3.1-70b`, [hostile]),
        ).toBe(false);
    });
});
