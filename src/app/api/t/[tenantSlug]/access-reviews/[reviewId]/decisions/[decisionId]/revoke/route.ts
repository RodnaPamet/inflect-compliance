/**
 * Reset a submitted reviewer verdict back to pending (#3269).
 *
 *   POST /api/t/:slug/access-reviews/:reviewId/decisions/:decisionId/revoke
 *
 * Body: `{ reason: string }` — 3..2000 characters, required.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `revokeDecision` has been complete, gated, audited and unit-tested since
 * Audit Coherence S7 (2026-05-24) — and unreachable. Its own docblock describes
 * a three-step reviewer flow beginning "Reviewer (or admin acting on their
 * behalf) calls `revokeDecision(…)`", and nothing could. So the defect it was
 * written to fix stayed live: a reviewer who records the wrong verdict needed an
 * admin and a database intervention, on a surface whose output is SOC 2
 * evidence.
 *
 * The usecase emits `ACCESS_REVIEW_DECISION_REVOKED` with the reason in
 * `detailsJson` specifically so an auditor can see unwound decisions. No such
 * row could ever be written.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POST ON AN ACTION LEAF, NOT `DELETE` ON THE DECISION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `DELETE .../decisions/:decisionId` reads like the obvious shape and is the
 * wrong one twice over:
 *
 *   - `reason` is REQUIRED, and a required request body on `DELETE` is the kind
 *     of thing intermediaries drop. The reason is not decoration: it is what
 *     makes the audit row answer "why was this unwound", which is the question
 *     the row exists for.
 *   - It is not a delete. The row survives with its verdict nulled and its
 *     `snapshotRole` / `snapshotMembershipStatus` DELIBERATELY preserved, so the
 *     evidentiary record of what the access looked like stays intact. A `DELETE`
 *     verb would describe the opposite of what happens.
 *
 * `POST …/close` on the campaign is the established convention for an action
 * leaf here, and this follows it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAME KEY AS RECORDING, DELIBERATELY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `access_reviews.decide`, which is granted to all five roles. Revoking is the
 * same authority as recording — a reviewer unwinding their own typo is not a
 * privileged act beyond having been allowed to record it in the first place —
 * and the real narrowing is per CAMPAIGN rather than per role: the usecase
 * refuses anyone who is neither the assigned reviewer nor `canAdmin`
 * (`access-review.ts:418-424`).
 *
 * Giving revoke a NARROWER key would be the subtler mistake. It would read as a
 * tightening while actually making the typo unfixable for exactly the
 * non-admin reviewers the usecase was written for, sending them back to the
 * admin-plus-database path this route removes.
 *
 * The gate is at the ROUTE because `requirePermission` writes a hash-chained
 * `AUTHZ_DENIED` row and a usecase-level throw writes nothing (Epic D.3). A
 * refused revoke attempt is worth a trail entry.
 *
 * Body read with `parseJsonBody` inside the handler rather than by composing
 * `withValidatedBody`, for the reason the sibling decision route records: that
 * wrapper hands the parsed body in the third argument, which
 * `requirePermission` uses for `ctx`.
 */
import { NextRequest } from 'next/server';
import { revokeDecision } from '@/app-layer/usecases/access-review';
import { RevokeDecisionSchema } from '@/app-layer/schemas/access-review.schemas';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{
        tenantSlug: string;
        reviewId: string;
        decisionId: string;
    }>('access_reviews.decide', async (req: NextRequest, { params }, ctx) => {
        const body = await parseJsonBody(req, RevokeDecisionSchema);
        const result = await revokeDecision(ctx, params.decisionId, body);
        return jsonResponse(result);
    }),
);
