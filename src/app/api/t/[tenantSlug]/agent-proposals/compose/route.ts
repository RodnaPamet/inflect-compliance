/**
 * A human composes an external write, and gets a PROPOSAL (#3301).
 *
 * ── WHY IT LIVES UNDER agent-proposals ──────────────────────────────────────
 *
 * Because that is what it makes. The twelve pages under `agents/` are
 * governance over agent output and none of them accepted an instruction; this
 * is the narrow intent surface, and its result enters the same queue, under the
 * same approval gate, as anything an agent proposed. A sibling path would
 * suggest a second kind of proposal, and there is only one.
 *
 * ── AUTHORIZATION IS THE USECASE'S ──────────────────────────────────────────
 *
 * `composeExternalWriteProposal` calls `assertCanWrite`, which is the same
 * shape its siblings here use (`approve` → `assertCanWrite`, the index →
 * `assertCanRead`) and is why this is not under `/admin`: composing is
 * deliberately the LOWER bar. The proposal reaches a reviewer who needs the
 * authority to approve it, and requiring that authority to compose as well
 * would turn four eyes into two.
 *
 * `params` is a Promise and is awaited here, per the Next 15+ contract the
 * `async-params-route-typing` ratchet holds — unlike a `requirePermission`
 * handler, where the wrapper has already reified it.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';

import { getTenantCtx } from '@/app-layer/context';
import {
    composeExternalWriteProposal,
    describeComposeRefusal,
    listComposeOffer,
} from '@/app-layer/usecases/external-write-compose';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';

/**
 * The body, and what it deliberately CANNOT carry.
 *
 * `openFieldValues` only. There is no field for the template's approved
 * parameters, so no request can edit them — the usecase merges them under the
 * open values, read from the row. A surface that accepted them and validated
 * them afterwards would be one refactor away from accepting them for real.
 *
 * No `rationale` either, though the usecase accepts one (#3351). That text is
 * what a reviewer reads to catch a misparse of a typed request, so it has to
 * be server-derived: a requester who could supply the readings could claim one
 * end date while sending another. `.strict()` makes an attempt a 400 rather
 * than a silent strip, which is the louder of the two failures.
 */
const BodySchema = z
    .object({
        parameterSetId: z.string().min(1).max(200),
        openFieldValues: z.record(z.string(), z.unknown()).default({}),
    })
    .strict();

export const POST = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);

    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
        throw badRequest('Send { parameterSetId, openFieldValues }.');
    }

    const outcome = await composeExternalWriteProposal(ctx, parsed.data);
    if (!outcome.ok) {
        // 409, not 500 and not a bare 400: the request is well-formed and the
        // CONFIGURATION or the chosen value is what refuses. The sentence names
        // which of the eleven causes it is, because each is fixed by a
        // different action.
        return jsonResponse({ error: describeComposeRefusal(outcome.refusal) }, { status: 409 });
    }

    return jsonResponse({
        proposalId: outcome.proposalId,
        // QUARANTINED is not PENDING, and the surface must not report it as
        // "awaiting approval": a quarantined proposal never enters the review
        // queue, so that would describe a wait nobody is going to end.
        status: outcome.status,
        guardVerdict: outcome.guardVerdict,
    }, { status: 201 });
});

/**
 * What this template lets an operator fill in, and which subjects it may name.
 *
 * A GET beside the POST on purpose: one path, so "what may I compose" and
 * "compose it" cannot drift apart into two surfaces with different ideas of the
 * bound. Read-gated by the usecase (`assertCanRead`).
 *
 * Candidates are resolved PER REQUEST. A cached list would be a snapshot
 * presented as a live bound, and the submitted value is re-checked at compose
 * and again at dispatch — so this is a convenience for the operator and never
 * the thing that decides.
 */
export const GET = withApiErrorHandling(async (
    req: NextRequest,
    { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);

    const parameterSetId = new URL(req.url).searchParams.get('parameterSetId');
    // Required, not defaulted. There is no sensible "all templates' fields"
    // answer: the open fields and the population are properties of ONE template.
    if (!parameterSetId) throw badRequest('parameterSetId is required');

    const outcome = await listComposeOffer(ctx, parameterSetId);
    if (!outcome.ok) {
        return jsonResponse({ error: describeComposeRefusal(outcome.refusal) }, { status: 409 });
    }
    return jsonResponse({
        label: outcome.label,
        toolName: outcome.toolName,
        fields: outcome.fields,
    });
});
