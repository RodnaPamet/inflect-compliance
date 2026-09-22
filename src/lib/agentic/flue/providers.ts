import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

import { FLUE_PROVIDER_IDS } from './model-selection';
import type { FlueProviderTerms } from './runtime-bootstrap';

/**
 * THE PROVIDERS THIS RUNTIME REGISTERS — built once, from deployment config.
 *
 * ── ESM-ONLY. REACHED BY DYNAMIC IMPORT ONLY ────────────────────────────────
 *
 * `@earendil-works/pi-ai` publishes an `import` condition and no `require`
 * one, exactly like `@flue/runtime`. Nothing in the main `src/` graph may
 * import this module statically; `execute.ts` pulls it in behind the same
 * dynamic boundary, and
 * `tests/guards/flue-esm-modules-stay-off-the-static-graph.test.ts` is where
 * that is enforced rather than merely intended.
 *
 * `runtime-bootstrap.ts` gets away with `import type { Provider }` because a
 * type-only import is erased.
 *
 * ── WHY OUR OWN IDS, RATHER THAN pi's BUILT-IN ONES ─────────────────────────
 *
 * A provider id is the left half of the `"<provider-id>/<model-id>"` specifier
 * that `useModel` takes, which makes it the ROUTING decision — and routing is
 * what `aiResidency` governs. Registering the vendor factory under its own id
 * (`anthropic/...`) would mean the residency of a run was decided by which
 * vendor a specifier happened to name, and every future vendor would silently
 * be an external route.
 *
 * Under `inflect-external` / `inflect-local` the id says what the RESIDENCY is
 * and the vendor is an implementation detail behind it. A LOCAL_ONLY tenant's
 * specifier cannot name an external provider because `resolveFlueModel` never
 * builds one, and — the half that matters — a deployment with no external
 * credential registers no external provider AT ALL, so there is no route to
 * resolve against even if a specifier were wrong.
 *
 * ── WHAT THE MODEL METADATA IS AND IS NOT USED FOR ──────────────────────────
 *
 * `cost` is zeroed. pi multiplies it into `usage.cost`, which this driver does
 * not read: `WorkflowRun.costTokens` is charged from `usage.totalTokens`, a
 * count the provider reports rather than a price we would be restating. A
 * wrong price here would be a wrong number in a place nobody is looking;
 * leaving it zero and charging tokens keeps the ledger honest about what it
 * measures.
 *
 * `contextWindow` / `maxTokens` DO matter — the runtime compacts against them
 * — so they are the real values for the external model and conservative
 * floors for a local gateway whose model we cannot introspect.
 */

/** Anthropic's published limits for the models this product pins. */
const EXTERNAL_CONTEXT_WINDOW = 200_000;
const EXTERNAL_MAX_TOKENS = 64_000;

/**
 * Conservative floors for a self-hosted gateway.
 *
 * A gateway can front anything, and pi has no way to ask it. Under-reporting
 * makes the runtime compact EARLIER than it needs to, which costs tokens; over-
 * reporting makes it send a request the server rejects, which fails the run.
 * The cheap failure is the right default.
 */
const LOCAL_CONTEXT_WINDOW = 32_768;
const LOCAL_MAX_TOKENS = 4_096;

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** The model ids a deployment offers, alongside the credentials to reach them. */
export interface FlueProviderModels {
    /** `ANTHROPIC_MODEL` — the id an EXTERNAL run may name. */
    externalModel?: string | null;
    /**
     * Every local model id this runtime may serve.
     *
     * ── A CEILING WORTH NAMING ──────────────────────────────────────────────
     *
     * `resolveFlueModel` honours a per-tenant `localModel` override, but
     * providers are registered ONCE at boot — `start()` throws if the process
     * already has a runtime, and mutating the registry per run is the exact
     * race `model-selection.ts` exists to avoid. So a tenant override can only
     * be served if the deployment registered that id at boot.
     *
     * Rather than let such a run fail inside pi with a resolution error,
     * `flueModelIsRegistered` below answers it up front and the driver refuses
     * with a named reason. Upgrade path when this bites: read the distinct
     * configured `localModel` values at boot and pass them here.
     */
    localModels?: readonly string[];
}

function externalProvider(apiKey: string, modelId: string): Provider {
    const baseUrl = 'https://api.anthropic.com';
    const model: Model<'anthropic-messages'> = {
        id: modelId,
        name: modelId,
        api: 'anthropic-messages',
        provider: FLUE_PROVIDER_IDS.external,
        baseUrl,
        reasoning: true,
        input: ['text'],
        cost: { ...NO_COST },
        contextWindow: EXTERNAL_CONTEXT_WINDOW,
        maxTokens: EXTERNAL_MAX_TOKENS,
    };
    return createProvider<'anthropic-messages'>({
        id: FLUE_PROVIDER_IDS.external,
        name: 'Inflect (external)',
        baseUrl,
        // RESOLVED FROM THE ARGUMENT, not from ambient `process.env`.
        //
        // pi's built-in factories read their vendor env var themselves, which
        // would mean a key present in the environment registers a working
        // external route regardless of what this deployment decided. Closing
        // over the key the caller passed keeps "has an external credential"
        // and "has an external route" the same fact.
        auth: {
            apiKey: {
                name: 'Inflect external model credential',
                resolve: async () => ({ auth: { apiKey }, source: 'ANTHROPIC_API_KEY' }),
            },
        },
        models: [model],
        api: anthropicMessagesApi(),
    });
}

function localProvider(baseUrl: string, apiKey: string | null, modelIds: readonly string[]): Provider {
    const models: Model<'openai-completions'>[] = modelIds.map((id) => ({
        id,
        name: id,
        api: 'openai-completions',
        provider: FLUE_PROVIDER_IDS.local,
        baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { ...NO_COST },
        contextWindow: LOCAL_CONTEXT_WINDOW,
        maxTokens: LOCAL_MAX_TOKENS,
    }));
    return createProvider<'openai-completions'>({
        id: FLUE_PROVIDER_IDS.local,
        name: 'Inflect (local gateway)',
        baseUrl,
        auth: {
            apiKey: {
                name: 'Inflect local gateway credential',
                // A keyless gateway is normal and is NOT "unconfigured": the
                // base URL is what makes the route exist. Resolving to an
                // entry with no key keeps such a deployment usable, where
                // returning `undefined` would report the provider as
                // unavailable.
                resolve: async () => ({
                    auth: apiKey ? { apiKey, baseUrl } : { baseUrl },
                    source: apiKey ? 'AI_LOCAL_API_KEY' : 'AI_LOCAL_BASE_URL',
                }),
            },
        },
        models,
        api: openAICompletionsApi(),
    });
}

/**
 * Build the providers this deployment may register — ALWAYS an explicit array,
 * possibly empty.
 *
 * The order mirrors `flueProviderIdsFor`: local first, external second, so the
 * two functions can be compared id-for-id by a test rather than by eye.
 */
export function buildFlueProviders(
    terms: FlueProviderTerms,
    models: FlueProviderModels,
): readonly Provider[] {
    const providers: Provider[] = [];
    if (terms.localBaseUrl) {
        providers.push(
            localProvider(terms.localBaseUrl, terms.localApiKey ?? null, models.localModels ?? []),
        );
    }
    if (terms.externalApiKey && models.externalModel) {
        providers.push(externalProvider(terms.externalApiKey, models.externalModel));
    }
    return providers;
}

/**
 * Is this specifier one the registered set can actually resolve?
 *
 * Asked BEFORE dispatch so an unregistered model is a named refusal an
 * operator can act on, rather than a stream error surfacing mid-run from
 * inside pi with the run row already created.
 */
export function flueModelIsRegistered(
    specifier: string,
    providers: readonly Provider[],
): boolean {
    const slash = specifier.indexOf('/');
    if (slash <= 0) return false;
    const providerId = specifier.slice(0, slash);
    const modelId = specifier.slice(slash + 1);
    const provider = providers.find((p) => p.id === providerId);
    // `getModels()` rather than a `models` field: the catalogue is behind a
    // method because a dynamic provider's list changes after `refreshModels()`.
    // The contract says it must not throw, and pi itself treats a throwing
    // implementation as having no models — so a refusal is the honest answer
    // if one ever does.
    return !!provider?.getModels().some((m) => m.id === modelId);
}
