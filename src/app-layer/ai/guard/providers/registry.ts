/**
 * AI Guard — which providers the guard consults (NeMo Guardrails roadmap, 1.4).
 *
 * The ONLY reader of `AI_GUARD_NEMO_BASE_URL`. Unset (or blank) means the
 * guard is the `patterns` provider alone and NOTHING else is constructed —
 * which is byte-identical to the guard before the seam (G9: absent config
 * constructs nothing). Set means `patterns` first, then `nemo`, composed
 * worst-of. A set value this module cannot use is NOT dropped back to
 * patterns-only: the operator asked for a second slice, so the provider is
 * built and reports itself unavailable on every scan (`CONFIG_INVALID` /
 * `SCHEME_REFUSED` / `EGRESS_REFUSED` for an address outside the deployment),
 * which flags every input and egress until it is fixed.
 * Silently scanning with less than was configured would be a fail-open.
 */
import { env } from '@/env';
import { patternsProvider } from './patterns-provider';
import { createNemoGuardProvider } from './nemo-provider';
import type { GuardProvider } from './types';

export interface GuardProviderConfig {
    /** `AI_GUARD_NEMO_BASE_URL`, or absent. */
    readonly nemoBaseUrl?: string | null;
}

/** Pure: the provider list for a configuration. `patterns` is always first. */
export function resolveGuardProviders(config: GuardProviderConfig): readonly GuardProvider[] {
    const nemoBaseUrl = config.nemoBaseUrl?.trim();
    if (!nemoBaseUrl) return [patternsProvider];
    return [patternsProvider, createNemoGuardProvider({ baseUrl: nemoBaseUrl })];
}

/** The providers for this deployment, from operator env. */
export function activeGuardProviders(): readonly GuardProvider[] {
    return resolveGuardProviders({ nemoBaseUrl: env.AI_GUARD_NEMO_BASE_URL });
}
