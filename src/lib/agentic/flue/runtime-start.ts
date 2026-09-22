import { start } from '@flue/runtime/node';
import type { Provider } from '@earendil-works/pi-ai';

import { env } from '@/env';
import { logger } from '@/lib/observability/logger';

import { InflectAgent } from './agent';
import { buildFlueProviders } from './providers';
import { planFlueStart } from './runtime-bootstrap';

/**
 * BOOTING THE RUNTIME — once per process, lazily, on the first Flue run.
 *
 * ── ESM-ONLY. REACHED BY DYNAMIC IMPORT ONLY ────────────────────────────────
 *
 * Imports `@flue/runtime/node` and, through `agent.ts` and `providers.ts`, two
 * more ESM-only graphs. Nothing in the main `src/` graph may reach it
 * statically — see the guard named in `providers.ts`.
 *
 * ── WHY LAZY, WHEN `runtime-bootstrap.ts` SAYS THE BOOT SITE BELONGS WITH
 *    PROCESS LIFECYCLE ─────────────────────────────────────────────────────
 *
 * Because this process has no such site to put it in. A Next.js server has no
 * "after boot, before serving" hook that runs in every deployment target, and
 * the BullMQ worker that will own run execution does not exist yet. Booting
 * from a module top level would start a runtime in every process that merely
 * imports the module — including `next build`, which evaluates route modules.
 *
 * So the boot is memoised on the first run that needs it. `start()` throws if
 * the process already has a runtime, which makes "exactly once" a correctness
 * requirement and not merely an efficiency one: the promise is stored BEFORE
 * it is awaited, so two concurrent first runs share one boot instead of
 * racing into a second `start()`.
 *
 * A failed boot clears the memo. Caching a rejection would make one transient
 * failure permanent for the lifetime of the process, and the runtime is a
 * process-level resource a later run has every right to retry.
 */

let booting: Promise<readonly Provider[]> | null = null;

/** The providers this deployment offers, read once from configuration. */
function deploymentProviders(): readonly Provider[] {
    return buildFlueProviders(
        {
            externalApiKey: env.ANTHROPIC_API_KEY,
            localBaseUrl: env.AI_LOCAL_BASE_URL,
            localApiKey: env.AI_LOCAL_API_KEY,
        },
        {
            externalModel: env.ANTHROPIC_MODEL,
            // Deployment-wide only. A per-tenant `localModel` override is not
            // served — see `FlueProviderModels.localModels` for why, and for
            // the upgrade path.
            localModels: env.AI_LOCAL_MODEL ? [env.AI_LOCAL_MODEL] : [],
        },
    );
}

/**
 * Start the runtime if it is not already started, and report the providers it
 * was started with.
 *
 * The providers are returned rather than kept private because the caller needs
 * them for `flueModelIsRegistered` — the pre-dispatch check that turns an
 * unresolvable specifier into a named refusal.
 */
export async function ensureFlueRuntime(): Promise<readonly Provider[]> {
    if (booting) return booting;

    booting = (async () => {
        const providers = deploymentProviders();

        // `agents` is fixed here and `providers` is ALWAYS passed — omitting
        // it registers every pi built-in, which is the egress-by-omission
        // `runtime-bootstrap.ts` documents. `db` is absent, which selects the
        // in-memory default on purpose.
        await start({ agents: [InflectAgent], ...planFlueStart(providers) });

        logger.info('flue-runtime: started', {
            component: 'agentic',
            providerIds: providers.map((p) => p.id),
        });
        return providers;
    })().catch((err) => {
        booting = null;
        throw err;
    });

    return booting;
}
