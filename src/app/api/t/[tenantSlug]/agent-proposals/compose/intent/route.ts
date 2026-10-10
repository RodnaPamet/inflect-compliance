/**
 * COMPOSE A GRANT PROPOSAL FROM A TYPED INSTRUCTION.
 *
 * The free-text entry point for #3351. It resolves a phrase to an APPROVED
 * template and a set of open-field values, then hands those to the same
 * usecase the form posts to — `composeExternalWriteProposal` — which re-checks
 * every value against the template's own constraints. So this route widens how
 * a proposal is DESCRIBED and not what may be proposed.
 *
 * ── A SIBLING PATH, NOT A SECOND POST ───────────────────────────────────────
 *
 * `../route.ts` keeps its GET and POST together so "what may I compose" and
 * "compose it" cannot drift apart. This is a third operation with a different
 * body, and Next routes one handler per method per path, so it sits beside
 * them rather than inside. What it must NOT do is re-implement the compose
 * step: it calls the same usecase, so the bound stays in one place.
 *
 * ── WHY THE REFUSALS ARE ALL 409 ────────────────────────────────────────────
 *
 * Three different things can refuse here — the residency gate, the resolver,
 * and compose itself — and none of them means the request was malformed. Each
 * returns the one sentence that names the action which fixes it. A 400 is
 * reserved for a body this route cannot read at all.
 *
 * ── RATE LIMITED, UNLIKE ITS SIBLING ────────────────────────────────────────
 *
 * Only 17 of the API's routes carry an explicit limit, and they are the
 * expensive or abusable ones. This is both: every accepted call makes TWO
 * model calls (`grant-intent.ts` asks once for the template and once for the
 * subject). `API_MUTATION_LIMIT` is the wrapper's default and the right
 * bucket — the work is local gateway compute under LOCAL_ONLY, with no vendor
 * spend, so the interactive-mutation budget fits where the 5/hour
 * key-creation budget would break an operator typing a few requests.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';

import { getTenantCtx } from '@/app-layer/context';
import {
    describeIntentForReviewer,
    describeIntentRefusal,
    resolveGrantIntent,
} from '@/app-layer/ai/intent/grant-intent';
import {
    describeIntentChooserRefusal,
    intentChooserForTenant,
} from '@/app-layer/ai/intent/chooser-for-tenant';
import {
    composeExternalWriteProposal,
    describeComposeRefusal,
} from '@/app-layer/usecases/external-write-compose';
import { LAYA_TIMEOUT_MS } from '@/app-layer/ai/identity-match/laya-provider';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';

/**
 * The ceiling for the whole resolution, derived from what it actually does:
 * `resolveGrantIntent` asks the chooser twice, each call bounded by
 * `LAYA_TIMEOUT_MS`, plus one call's worth of slack for the round trips
 * between them. Derived rather than a round number, so a change to either the
 * per-call timeout or the number of questions moves it.
 */
const INTENT_CHOOSER_CALLS = 2;
const INTENT_BUDGET_MS = LAYA_TIMEOUT_MS * (INTENT_CHOOSER_CALLS + 1);

/**
 * Just the phrase.
 *
 * No `parameterSetId`: choosing the template is the whole job here, and a
 * surface that accepted one would be two ways to say the same thing with no
 * rule about which wins. No `rationale` either — see the sibling route; the
 * readings are the misparse check, so they are server-derived.
 *
 * The length bound is a cost bound, not a validation: the phrase goes to a
 * model, and the content guard inside the resolver is what actually inspects
 * it.
 */
const BodySchema = z
    .object({
        phrase: z.string().trim().min(1).max(500),
    })
    .strict();

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);

        const parsed = BodySchema.safeParse(await req.json().catch(() => null));
        if (!parsed.success) {
            throw badRequest('Send { phrase }.');
        }

        // The gate FIRST, before the phrase is looked at by anything: if no
        // local model may read it, it must not reach one, and the content
        // guard inside the resolver runs on the path that is allowed to.
        const gate = await intentChooserForTenant(ctx, {
            deadlineAt: Date.now() + INTENT_BUDGET_MS,
        });
        if (!gate.ok) {
            return jsonResponse(
                { error: describeIntentChooserRefusal(gate.reason) },
                { status: 409 },
            );
        }

        const intent = await resolveGrantIntent(ctx, parsed.data.phrase, {
            chooser: gate.chooser,
        });
        if (!intent.ok) {
            return jsonResponse({ error: describeIntentRefusal(intent.refusal) }, { status: 409 });
        }

        const composed = await composeExternalWriteProposal(ctx, {
            parameterSetId: intent.resolved.parameterSetId,
            openFieldValues: intent.resolved.openFieldValues,
            // The phrase AND what the parser made of it, so a reviewer can
            // catch a misparse rather than approve a date nobody asked for.
            rationale: describeIntentForReviewer(intent.resolved),
        });
        if (!composed.ok) {
            return jsonResponse(
                { error: describeComposeRefusal(composed.refusal) },
                { status: 409 },
            );
        }

        return jsonResponse(
            {
                proposalId: composed.proposalId,
                status: composed.status,
                guardVerdict: composed.guardVerdict,
                // Returned so the operator sees what was understood without
                // opening the proposal — the same lines the reviewer gets.
                readings: intent.resolved.readings,
            },
            { status: 201 },
        );
    },
    { rateLimit: { scope: 'grant-intent-compose' } },
);
