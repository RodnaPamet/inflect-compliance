/**
 * The provider contract, in its own module so the residency guard can read the
 * factory without the factory importing its own test's mocks.
 *
 * @module app-layer/ai/identity-match/types
 */

import type { MatchState, SystemOneResponse } from './systemone-wire';

/**
 * Everything a call needs that is not the state.
 *
 * `deadlineAt` is here rather than inside the provider because the pass owns the
 * budget — see `transport.ts`. The three injection points exist so the timeout and
 * retry rules can be tested without a clock or a socket; production passes none of
 * them.
 */
export interface DecisionCallContext {
    readonly deadlineAt: number;
    readonly fetchImpl?: typeof fetch;
    readonly nowMs?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
}

export interface DecisionProvider {
    readonly providerName: 'jev' | 'laya' | 'stub';
    readonly modelName: string;
    /** Whether a call leaves our infrastructure. Read by the residency guard. */
    readonly isExternal: boolean;
    adjudicate(state: MatchState, ctx: DecisionCallContext): Promise<SystemOneResponse>;
}

/**
 * The effective mode: the stricter of `TenantSecuritySettings.legacyMatchAiMode`
 * and `aiResidency`, computed by the caller.
 */
export type EffectiveDecisionMode = 'OFF' | 'LOCAL_ONLY' | 'EXTERNAL';
