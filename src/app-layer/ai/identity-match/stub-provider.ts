/**
 * The stub — it answers nothing, ever.
 *
 * An unconfigured deployment must produce NO verdicts rather than invented ones.
 * The tempting alternative is a stub that returns a neutral answer — `NONE` at
 * probability 0.5 — and that is strictly worse than throwing: a neutral verdict is
 * still a verdict, it would be recorded as the model's opinion, and an evaluation
 * record computed over stub answers would describe a model nobody ran.
 *
 * So `adjudicate` rejects. The caller's fail-closed path then leaves the account
 * in the review queue, which is where an account with no model opinion belongs.
 *
 * @module app-layer/ai/identity-match/stub-provider
 */

import { type MatchState, type SystemOneResponse } from './systemone-wire';
import type { DecisionProvider, DecisionCallContext } from './types';

export class StubDecisionProvider implements DecisionProvider {
    readonly providerName = 'stub' as const;
    readonly modelName = 'none';
    readonly isExternal = false;

    async adjudicate(_state: MatchState, _ctx: DecisionCallContext): Promise<SystemOneResponse> {
        throw new NoDecisionProviderError();
    }
}

export class NoDecisionProviderError extends Error {
    constructor() {
        super(
            'no decision model is configured for this deployment; no verdict can be produced ' +
                '(this is the safe default — the account stays in the review queue)'
        );
        this.name = 'NoDecisionProviderError';
    }
}
