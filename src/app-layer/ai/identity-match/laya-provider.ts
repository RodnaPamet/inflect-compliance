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
 * 12 s per attempt — ADJUDICATION ONLY. The intent chooser has its own, tighter
 * budget in `ai/intent/laya-chooser.ts`; see the note there before merging them
 * back together.
 *
 * MEASURED, on the deployed VM, same image and payload (#3445): p50 7,332 ms
 * and p95 7,727 ms for one adjudication with five candidates, at `cpus: 1.0`
 * on a two-vCPU `e2-highmem-2`. 12 s is about 1.55x that p95.
 *
 * THIS IS NOW LOOSER THAN JEV'S 3 s, which inverts what this docblock used to
 * claim, so the old reasoning is worth naming: it said a local call "crossing
 * no public network has no excuse for a long tail". That confused distance
 * with latency. Jev's 3 s buys a network round trip to GPU-backed inference;
 * this is CPU inference on two shared cores, and the model card's 32.8 ms is a
 * T4 figure with no CPU equivalent published. The tighter number was never
 * reachable on this hardware — it made LOCAL_ONLY return TIMEOUT for every
 * call, which is the exact opposite of preferring the local path.
 *
 * WHAT THIS DOES NOT FIX: the throughput criterion in #3445. 500 accounts at
 * 7.3 s each is ~61 minutes against a 120 s deadline, and no per-call timeout
 * touches that. Concurrency 4 was measured and made p50 worse (14.8 s), and
 * the batch endpoint worse still (9.2 s/account). What this change buys is a
 * verdict instead of a non-verdict on calls that are made.
 */
export const LAYA_TIMEOUT_MS = 12_000;

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
