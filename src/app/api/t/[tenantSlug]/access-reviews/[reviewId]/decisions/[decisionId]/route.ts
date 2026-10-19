/**
 * Epic G-4 — Submit a per-user reviewer verdict.
 *
 *   PUT /api/t/:slug/access-reviews/:reviewId/decisions/:decisionId
 *
 * Body: discriminated union on `decision`
 *   { decision: 'CONFIRM', notes?: string }
 *   { decision: 'REVOKE',  notes?: string }
 *   { decision: 'MODIFY',  modifiedToRole: Role,   (never OWNER — #3727)
 *                          notes?: string }
 *
 * A MODIFY to OWNER, or one carrying `modifiedToCustomRoleId`, is refused by
 * name (`CAMPAIGN_NEVER_PROMOTES_TO_OWNER`, `CAMPAIGN_MODIFY_SETS_NO_CUSTOM_ROLE`)
 * and the refusal writes an `ACCESS_REVIEW_DECISION_REFUSED` audit row —
 * `recordDecisionSubmissionRefusal`, which rethrows the 400 unchanged.
 *
 * The reviewer-vs-admin gate, the CHECK-pair shape, and the
 * OPEN→IN_REVIEW transition all live in the usecase.
 *
 * ─── WHY `access_reviews.decide` IS GRANTED TO EVERY ROLE ───────────────
 *
 * The key answers "may this role ever record a verdict", and the answer has
 * to be yes for all five: a reviewer is assigned PER CAMPAIGN, so a READER
 * can legitimately be the assigned reviewer. `submitDecision` still refuses
 * anyone who is neither the assigned reviewer nor `canAdmin` — that rule
 * stays in the usecase, where it can see which campaign is being decided.
 * Narrowing the key to OWNER/ADMIN would read as a tightening and would in
 * fact be an authorisation REGRESSION for every non-admin reviewer.
 *
 * The body is read with `parseJsonBody` inside the handler rather than by
 * composing `withValidatedBody`, whose handler takes the parsed body in the
 * third argument `requirePermission` uses for `ctx`.
 */
import { NextRequest } from 'next/server';
import { recordDecisionSubmissionRefusal, submitDecision } from '@/app-layer/usecases/access-review';
import { SubmitDecisionSchema } from '@/app-layer/schemas/access-review.schemas';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const PUT = withApiErrorHandling(
    requirePermission<{
        tenantSlug: string;
        reviewId: string;
        decisionId: string;
    }>('access_reviews.decide', async (req: NextRequest, { params }, ctx) => {
        const body = await parseJsonBody(req, SubmitDecisionSchema).catch((err: unknown) =>
            recordDecisionSubmissionRefusal(ctx, params.decisionId, err),
        );
        const result = await submitDecision(ctx, params.decisionId, body);
        return jsonResponse(result);
    }),
);
