import type { Provider } from '@earendil-works/pi-ai';

import { FLUE_PROVIDER_IDS } from './model-selection';

/**
 * HOW THE FLUE RUNTIME IS STARTED IN THIS PROCESS — and the three defaults
 * that are wrong for this product.
 *
 * `start()` from `@flue/runtime/node` boots the runtime in-process, "mirroring
 * what a generated Flue server entry does at boot … without any HTTP surface".
 * That is what makes an embedded driver possible at all: no second service, no
 * second deploy unit, and the run stays inside the request or job that owns it.
 *
 * Its option defaults are tuned for a standalone script, and each of the three
 * is a hazard here. This module exists to state them once, in code, rather
 * than leave them to whoever writes the `start()` call.
 *
 * ── 1. `providers` OMITTED REGISTERS EVERY BUILT-IN ─────────────────────────
 *
 * The docstring is explicit: "Omitted registers every pi built-in; an empty
 * array registers none." Every built-in means every vendor pi ships an
 * adapter for, each resolving its own ambient credential from `process.env`.
 *
 * In a product where `aiResidency: LOCAL_ONLY` is a hard invariant, a runtime
 * with every external provider registered is an egress surface created by
 * omission — nothing would have to go wrong for a model specifier to resolve
 * against a vendor nobody chose. So the list is ALWAYS explicit, and this
 * module is the only place it is built.
 *
 * ── 2. `db` DEFAULTS TO IN-MEMORY, AND THAT IS THE ANSWER WE WANT ───────────
 *
 * Unusually, the default is the safe one and the temptation is to override it.
 * `@flue/postgres` is refused by the integration plan because a second
 * persistence path into this database bypasses RLS, the encrypted-field
 * manifest and the hash-chained audit trail. `sqlite('./file.db')` is the same
 * objection in a smaller package: run state that outlives the process and that
 * no tenant policy governs.
 *
 * `WorkflowRun` is the system of record. The runtime's own store is a
 * conversation cache for the duration of a run, and losing it on restart is
 * correct — a resumed run rebuilds from the sealed context chain, which is the
 * thing that IS governed.
 *
 * ── 3. `agents` IS FIXED AT START ───────────────────────────────────────────
 *
 * The runtime serves the agents it was started with; `start()` throws if the
 * process already has a runtime. So a driver cannot define a fresh agent per
 * run. Per-run variation travels as dispatch data instead, which is the
 * shape the runtime intends and also the safer one: an agent function that
 * cannot be assembled per request cannot have its tool set widened per
 * request either.
 */

/**
 * The providers this runtime may register, by id.
 *
 * Built HERE rather than at the `start()` call so the "never omit" rule has
 * exactly one enforcement point. An empty array is a legal and meaningful
 * answer — a deployment with no model credentials registers nothing, and every
 * run then refuses at `resolveFlueModel` with a named reason rather than
 * resolving against a vendor default nobody configured.
 */
export interface FlueProviderTerms {
    /** `ANTHROPIC_API_KEY`, or absent. */
    externalApiKey?: string | null;
    /** `AI_LOCAL_BASE_URL` / tenant override, or absent. */
    localBaseUrl?: string | null;
    /**
     * `AI_LOCAL_API_KEY`, or absent.
     *
     * Deliberately NOT part of `flueProviderIdsFor`'s answer: a self-hosted
     * gateway that needs no key is a normal deployment, and the BASE URL is
     * what makes the local route exist. Treating the key as the test would
     * make a keyless gateway look unconfigured.
     */
    localApiKey?: string | null;
}

/** Which provider ids a given deployment can legitimately offer. */
export function flueProviderIdsFor(terms: FlueProviderTerms): readonly string[] {
    const ids: string[] = [];
    if (terms.localBaseUrl) ids.push(FLUE_PROVIDER_IDS.local);
    if (terms.externalApiKey) ids.push(FLUE_PROVIDER_IDS.external);
    return ids;
}

/**
 * The shape a caller must satisfy to start the runtime safely.
 *
 * Deliberately NOT a call to `start()`. This module is pure so it can be
 * tested without booting anything, and so the boot site — which is a process
 * concern, not a per-run one — stays visible at the place that owns process
 * lifecycle rather than being buried in a driver.
 */
export interface FlueStartPlan {
    /** ALWAYS present, never omitted. May be empty. */
    providers: readonly Provider[];
    /**
     * Absent, on purpose. `undefined` selects the runtime's in-memory default;
     * any adapter here is the second persistence path the plan refuses.
     */
    db?: never;
}

/**
 * Build the start plan from the providers a deployment actually has.
 *
 * The `db` key is absent from the returned object rather than set to
 * `undefined`, so a reader of the call site sees no persistence decision to
 * second-guess, and `FlueStartPlan['db']` being `never` means a later edit
 * that adds one fails to compile instead of quietly opening the path.
 */
export function planFlueStart(providers: readonly Provider[]): FlueStartPlan {
    return { providers };
}
