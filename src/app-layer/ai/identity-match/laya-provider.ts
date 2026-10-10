/**
 * Laya — Convai Innovations' open-weights System One model, running on
 * infrastructure we operate. The LOCAL path.
 *
 * Nothing leaves our infrastructure, which is what makes this the provider a
 * `LOCAL_ONLY` tenant is promised. Two consequences shape the code:
 *
 * **The base URL is deployment configuration, never a tenant setting.**
 * `LAYA_BASE_URL` is read from the environment and no tenant-writable column
 * reaches it. A tenant-settable local URL would be the same SSRF the Jev constant
 * exists to prevent, with the added irony of arriving through the privacy-
 * preserving option.
 *
 * **The key is optional.** Most Laya servers are community projects behind a
 * network boundary rather than an auth header, so requiring a key would make the
 * common deployment impossible and push operators toward the external path. Both
 * variables are in `NON_SUBPROCESSOR_ALLOWLIST` with that reason: they name
 * infrastructure we run, not a third party.
 *
 * It runs as its own service rather than in-process through ONNX Runtime, which
 * would add a native runtime and roughly a gigabyte of weights to the web and
 * worker images.
 *
 * @module app-layer/ai/identity-match/laya-provider
 */

import { env } from '@/env';
import {
    LAYA_MODEL,
    buildMatchRequest,
    parseSystemOneResponse,
    type MatchState,
    type SystemOneResponse,
} from './systemone-wire';
import { callSystemOne } from './transport';
import type { DecisionProvider, DecisionCallContext } from './types';

/**
 * 2 s per attempt.
 *
 * The model card reports 32.8 ms for one question on a T4 and publishes no CPU
 * figure, so this is a generous allowance for a CPU deployment rather than a
 * target. Deliberately TIGHTER than Jev's 3 s: a local call crossing no public
 * network has no excuse for a long tail, and a local path that hangs as long as
 * the external one removes the reason to prefer it inline.
 */
export const LAYA_TIMEOUT_MS = 2_000;

export class LayaDecisionProvider implements DecisionProvider {
    readonly providerName = 'laya' as const;
    readonly modelName = LAYA_MODEL;
    readonly isExternal = false;

    constructor(
        private readonly baseUrl: string,
        private readonly apiKey?: string
    ) {
        if (!baseUrl) throw new Error('LayaDecisionProvider requires LAYA_BASE_URL');
    }

    async adjudicate(state: MatchState, ctx: DecisionCallContext): Promise<SystemOneResponse> {
        const raw = await callSystemOne({
            url: `${this.baseUrl.replace(/\/+$/, '')}/v1/systemone`,
            body: buildMatchRequest(LAYA_MODEL, state),
            timeoutMs: LAYA_TIMEOUT_MS,
            deadlineAt: ctx.deadlineAt,
            headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
            fetchImpl: ctx.fetchImpl,
            nowMs: ctx.nowMs,
            sleep: ctx.sleep,
        });
        // The STATE says which shape to expect: an orphan was asked the person
        // question alone, so its answer carries no `match`. Told rather than
        // guessed — a union of the two schemas would report the wrong reason
        // for a malformed full response.
        return parseSystemOneResponse(raw, { expectMatch: state.candidates.length > 0 });
    }
}

export function layaConfig(): { baseUrl?: string; apiKey?: string } {
    return { baseUrl: env.LAYA_BASE_URL, apiKey: env.LAYA_API_KEY };
}
