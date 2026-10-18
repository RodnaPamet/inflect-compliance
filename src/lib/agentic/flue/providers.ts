import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

import { anthropicWorkspaceHeaders } from '@/lib/ai/anthropic-workspace';

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
 * — so they are the published floor for the external models and conservative
 * floors for a local gateway whose model we cannot introspect.
 */

/**
 * The smaller of Anthropic's published limits for the models this product
 * pins: `claude-haiku-4-5`, 200K context and 64K output. `claude-sonnet-5-5`,
 * the agent runtime's default, allows 1M and 128K; reporting less is the cheap
 * failure described below, not the expensive one.
 */
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
    /** `AGENT_FLUE_MODEL` — the id an EXTERNAL run may name. */
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

/**
 * The Claude models that take a thinking BUDGET rather than adaptive thinking:
 * every generation before 4.6. A closed set — no model released from now on
 * joins it.
 *
 * pi 0.83 chooses the thinking shape from `compat.forceAdaptiveThinking` and
 * from nothing else, and this runtime asks for reasoning on every request:
 * Flue's default level is `medium`, and its compaction asks for `high`. Left
 * unset, every request carries `thinking: { type: "enabled", budget_tokens }`.
 * That is right for Haiku 4.5, and an HTTP 400 on `claude-sonnet-5-5` and on
 * every other current model, which refuse a budget outright. So adaptive is
 * the default and this list is the exception, the direction that stays right
 * as models are released.
 */
const BUDGET_THINKING_MODEL = /^claude-(?:3|(?:opus|sonnet|haiku)-4-5|opus-4-1|(?:opus|sonnet)-4-(?:0|\d{8}))(?![0-9])/;

/** Does pi have to send adaptive thinking for this external model id? */
export function takesAdaptiveThinking(modelId: string): boolean {
    return !BUDGET_THINKING_MODEL.test(modelId);
}

function externalProvider(
    apiKey: string,
    modelId: string,
    workspaceId: string | null | undefined,
): Provider {
    const baseUrl = 'https://api.anthropic.com';
    // ON THE MODEL, not on the provider, because that is the field pi sends.
    //
    // `createProvider` accepts a provider-level `headers` too, and stores it —
    // but pi 0.83's `Models` never reads it back, so a header put there is
    // silently not sent. `Model.headers` is merged into the request auth by
    // `Models.getAuth(model)` AND into the SDK client's default headers by the
    // anthropic-messages API itself, so it reaches the wire whichever path a
    // caller takes. Absent when no workspace id is configured, which leaves the
    // model — and so the request — exactly as it was.
    const workspaceHeaders = anthropicWorkspaceHeaders(workspaceId);
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
        ...(Object.keys(workspaceHeaders).length > 0 ? { headers: workspaceHeaders } : {}),
        // Adaptive thinking plus an effort level, rather than a budget, for
        // every model that is not on the closed pre-4.6 list above.
        ...(takesAdaptiveThinking(modelId) ? { compat: { forceAdaptiveThinking: true } } : {}),
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
        providers.push(
            externalProvider(terms.externalApiKey, models.externalModel, terms.externalWorkspaceId),
        );
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
    if (!provider) return false;
    // `getModels()` rather than a `models` field: the catalogue is behind a
    // method because a dynamic provider's list changes after `refreshModels()`.
    //
    // WRAPPED, because the sentence below used to be a claim and not a
    // behaviour (#3617). It said "the contract says it must not throw, and pi
    // itself treats a throwing implementation as having no models — so a refusal
    // is the honest answer if one ever does", and then called `getModels()`
    // bare. A throwing catalogue propagated out of the one check whose whole
    // purpose is to turn an unresolvable specifier into a NAMED refusal before
    // dispatch — so the failure it exists to prevent arrived as an unhandled
    // throw from the gate instead of from pi. Found by the first test ever to
    // call it with a hostile provider.
    try {
        return provider.getModels().some((m) => m.id === modelId);
    } catch {
        return false;
    }
}
