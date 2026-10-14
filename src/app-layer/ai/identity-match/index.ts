/**
 * The decision-provider factory — the one place that decides which model, if any,
 * sees an account.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RESIDENCY IS STRUCTURAL, NOT CONDITIONAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The invariant is not "under `LOCAL_ONLY` we do not CALL an external provider".
 * It is that under `LOCAL_ONLY` we never CONSTRUCT one. The function returns
 * before reaching any external construction, and
 * `tests/guards/ai-residency-enforcement.test.ts` reads this file's source to
 * assert the ordering — every `new …DecisionProvider` that is external must appear
 * textually after the `LOCAL_ONLY` guard.
 *
 * That shape is stronger than a conditional for a reason worth stating: a
 * constructed-but-unused external provider is one refactor away from being a
 * called one, and the refactor looks like tidying. It also removes the question of
 * whether a constructor has side effects, which nobody should have to re-answer
 * when a vendor SDK is swapped in.
 *
 * The same guard derives the SET of constructors from this source, so adding a
 * fourth provider fails the test until somebody classifies it as external or not —
 * which is exactly when the "may `LOCAL_ONLY` reach it?" decision is due.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO INDEPENDENT GATES IN FRONT OF THE EXTERNAL PATH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. The effective mode must be `EXTERNAL` — the stricter of the tenant's
 *    `legacyMatchAiMode` and its `aiResidency`, computed by the caller.
 * 2. `TYPESAFE_SUBPROCESSOR_ACTIVE` must be true, and it is false.
 *
 * So gate 2 is what governs again, and it is doing the exact job #3502's
 * docblock claimed for it: "the one switch that makes the external path
 * unreachable for EVERY tenant at once, in a reviewed diff, if the sub-processor
 * relationship ends." That relationship ended on 2026-10-14, and this is that
 * diff.
 *
 * Keeping the brake while the road was clear is what made the withdrawal a
 * one-line change rather than a refactor. The flag moved twice in four days —
 * false until #3409, true from 2026-10-11, false again from 2026-10-14 — which
 * is the argument for the gate existing at all.
 *
 * Falling back to the local path (and then the stub) rather than throwing is
 * deliberate: a tenant who asked for adjudication gets the privacy-preserving
 * answer or no answer, never an error that reads like a bug in their
 * configuration.
 *
 * Falling back to the local path (and then the stub) rather than throwing is
 * deliberate: a tenant who asked for adjudication gets the privacy-preserving
 * answer or no answer, never an error that reads like a bug in their
 * configuration.
 *
 * @module app-layer/ai/identity-match
 */

import {
    JevDecisionProvider,
    TYPESAFE_SUBPROCESSOR_ACTIVE,
    typesafeApiKey,
} from './jev-provider';
import { StubDecisionProvider } from './stub-provider';
import type { DecisionProvider, EffectiveDecisionMode } from './types';

export { JEV_ENDPOINT, JEV_TIMEOUT_MS } from './jev-provider';
export { TYPESAFE_SUBPROCESSOR_ACTIVE };
export { NoDecisionProviderError } from './stub-provider';
export type { DecisionProvider, DecisionCallContext, EffectiveDecisionMode } from './types';
export {
    JEV_MODEL,
    LAYA_MODEL,
    MATCH_OPTIONS,
    QUESTION_IDS,
    buildMatchRequest,
    parseSystemOneResponse,
    systemOneResponseSchema,
    SystemOneResponseError,
    STATE_BUDGET_CHARS,
    JEV_MAX_CHOICE_OPTIONS,
    LAYA_MAX_CHOICE_OPTIONS,
    MAX_CHOICE_OPTIONS,
} from './systemone-wire';
export type { MatchState, MatchStateAccount, MatchStateCandidate, MatchOption } from './systemone-wire';
export { callSystemOne, parseRetryAfter, SystemOneTransportError } from './transport';

/**
 * The local arm: the stub, and ONLY the stub, since 2026-10-14.
 *
 * It read `layaConfig()` and returned a `LayaDecisionProvider` when a base URL
 * was deployed. The Laya estate was retired on the owner's decision, so there is
 * no local model to construct and this returns the refusing stub for every
 * caller.
 *
 * KEPT AS A FUNCTION rather than inlined at its three call sites, and that is
 * deliberate. `getDecisionProvider` takes four decisions before it reaches an
 * external provider — OFF, the LOCAL_ONLY residency guard, the sub-processor
 * flag, and the credential — and three of them now return the same thing.
 * Collapsing them because the values coincide would delete the structure that
 * makes the residency property READABLE, and `ai-residency-enforcement` asserts
 * that structure: the LOCAL_ONLY branch must RETURN before anything external is
 * constructed. The module header says not to simplify that branch away on the
 * grounds that another check already covers it. This is that situation, arrived
 * at from the other direction.
 *
 * Declared above {@link getDecisionProvider} so the one construction here
 * legitimately appears earlier in the file — the residency guard allows exactly
 * the non-external names before the guard line, and treats anything else
 * constructed there as a finding.
 */
function buildLocalProvider(): DecisionProvider {
    return new StubDecisionProvider();
}

/**
 * Pick the provider for an already-computed effective mode.
 *
 * `effectiveMode` is the STRICTER of the tenant setting and `aiResidency`. This
 * function does not recompute it, deliberately: two places deriving the same
 * strictness is how they come to disagree, and the disagreement would favour the
 * looser one exactly when it mattered.
 */
export function getDecisionProvider(effectiveMode: EffectiveDecisionMode): DecisionProvider {
    // OFF is the default. No model sees anything.
    if (effectiveMode === 'OFF') {
        return new StubDecisionProvider();
    }

    // ── The LOCAL_ONLY guard. Nothing external may be constructed below. ──
    if (effectiveMode === 'LOCAL_ONLY') {
        return buildLocalProvider();
    }

    // Gate 2: the sub-processor is registered but NOT active, so the external
    // provider is unreachable for tenant work however the mode is set.
    if (!TYPESAFE_SUBPROCESSOR_ACTIVE) {
        return buildLocalProvider();
    }

    const key = typesafeApiKey();
    if (!key) {
        // EXTERNAL asked for, no credential. The local path, then the stub.
        return buildLocalProvider();
    }

    return new JevDecisionProvider(key);
}
