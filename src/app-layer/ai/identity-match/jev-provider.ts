/**
 * Jev — TypeSafe AI's hosted System One model. The EXTERNAL path.
 *
 * This is the only provider that sends anything to a third party, so everything
 * about it is arranged to make that fact hard to obscure.
 *
 * **The host is a code constant.** No environment variable, no tenant setting and
 * no configuration column can change the URL this provider calls. That is the
 * difference between an external path and a fetch primitive: a configurable host
 * is a server-side request forgery waiting for whoever can write that column, and
 * the sub-processor register would be describing a destination the code no longer
 * uses. `tests/guards/ai-residency-enforcement.test.ts` asserts the constant.
 *
 * **IT IS INERT AGAIN, AND THIS TIME BY A DECISION RATHER THAN A WINDOW.**
 * {@link TYPESAFE_SUBPROCESSOR_ACTIVE} is `false` since 2026-10-14, so
 * `getDecisionProvider` refuses to return this provider for tenant work however
 * a tenant sets its mode.
 *
 * The whole history, because the flag has now moved twice: Step 6a registered
 * TypeSafe as *proposed, inactive*; #3409 activated it on 2026-10-11 with the
 * legal review and the customer notice deliberately skipped; and on 2026-10-14
 * the owner withdrew it, on the evidence that the path had produced ZERO
 * verdicts in production while carrying a US transfer, a DPA obligation and an
 * open injection finding (#3461).
 *
 * The provider is kept rather than deleted so the withdrawal is one constant
 * away from reversible, and so the register continues to describe code that
 * exists. Deleting it is a separate decision about ~9,600 lines.
 *
 * @module app-layer/ai/identity-match/jev-provider
 */

import { env } from '@/env';
import {
    JEV_MODEL,
    buildMatchRequest,
    parseSystemOneResponse,
    type MatchState,
    type SystemOneResponse,
} from './systemone-wire';
import { callSystemOne } from './transport';
import type { DecisionProvider, DecisionCallContext } from './types';

/**
 * The documented endpoint, verified at <https://docs.typesafe.ai/api> on
 * 2026-10-08: `POST https://api.typesafe.ai/v1/systemone`.
 */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * Whether TypeSafe is an ACTIVE sub-processor.
 *
 * DEFINED in `lib/legacy-access/adjudication-mode.ts` since Step 6c, and
 * re-exported here so every existing importer keeps working. It moved because
 * the settings usecase has to read it, and reading it from THIS module would
 * drag the transport — and therefore the egress stack — into a settings page.
 *
 * Still exactly one definition. Flipping it is a sub-processor activation, not a
 * configuration change — see `docs/sub-processors.md`.
 */
export { TYPESAFE_SUBPROCESSOR_ACTIVE } from '@/lib/legacy-access/adjudication-mode';

/** The vendor's documented per-attempt budget for an inline call. */
export const JEV_TIMEOUT_MS = 3_000;

export class JevDecisionProvider implements DecisionProvider {
    readonly providerName = 'jev' as const;
    readonly modelName = JEV_MODEL;
    readonly isExternal = true;

    constructor(private readonly apiKey: string) {
        if (!apiKey) throw new Error('JevDecisionProvider requires TYPESAFE_API_KEY');
    }

    async adjudicate(state: MatchState, ctx: DecisionCallContext): Promise<SystemOneResponse> {
        const raw = await callSystemOne({
            url: JEV_ENDPOINT,
            body: buildMatchRequest(JEV_MODEL, state),
            timeoutMs: JEV_TIMEOUT_MS,
            deadlineAt: ctx.deadlineAt,
            // Verified header form: `Authorization: Bearer <API_KEY>`.
            headers: { authorization: `Bearer ${this.apiKey}` },
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

/** Reads the key without deciding anything about residency. */
export function typesafeApiKey(): string | undefined {
    return env.TYPESAFE_API_KEY;
}
