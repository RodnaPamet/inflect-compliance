/**
 * Epic G-4 — Close a campaign.
 *
 *   POST /api/t/:slug/access-reviews/:reviewId/close
 *
 * Executes REVOKE/MODIFY decisions against live `TenantMembership`,
 * emits per-row audit entries, and produces the evidence PDF (it carries a
 * SHA-256 hash of its contents; it is not cryptographically signed).
 * Body is empty — every input is the campaign id from the URL.
 *
 * Step 5a: gated by `access_reviews.close` (OWNER + ADMIN, mirroring the
 * `assertCanAdmin` both close usecases keep). The scope read that chooses
 * between the two flows now happens AFTER authorisation, so an unauthorised
 * caller can no longer learn whether a campaign exists or what scope it has.
 */
import { NextRequest } from 'next/server';
import {
    closeAccessReview,
    getAccessReview,
} from '@/app-layer/usecases/access-review';
import { closeConnectedAccessReview } from '@/app-layer/usecases/access-review-connected';
import { closeAgentAccessReview } from '@/app-layer/usecases/access-review-agent';
import { subjectTableOf } from '@/lib/access-review/scope';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.close',
        async (_req: NextRequest, { params }, ctx) => {
            // PR-7 — CONNECTED_APP campaigns close via the parallel connected
            // flow (remediation tasks); the mature member flow is untouched.
            //
            // Step 5b routes LEGACY_APP here too rather than adding a third
            // close. Its decisions live in the same table, and that function is
            // already scope-agnostic in its mechanics — two phases, the
            // zero-is-not-complete guard, the pending guard, the remediation
            // tasks. What genuinely differs is the task WORDING (nothing of ours
            // writes to a legacy application) and the evidence provenance, and
            // both are handled inside it. A parallel implementation would have
            // been a second copy of the guards, which is where they rot.
            //
            // #3674 — the dispatch reads WHICH TABLE holds the subjects rather
            // than naming two scopes. It used to name CONNECTED_APP and
            // LEGACY_APP and send everything else to the member close, so the
            // AGENT value would have reached the one close with no zero-subject
            // guard. An unknown scope now goes to the connected close, which
            // refuses zero subjects.
            //
            // AGENT is named, and FIRST: its subjects are in the connected
            // table, but it closes through `closeAgentAccessReview` — packs,
            // narrowings and the sample are rules the connected close does not
            // hold, and both generic closes refuse AGENT by name
            // (`AGENT_CAMPAIGN_OWN_FLOW`).
            const review = await getAccessReview(ctx, params.reviewId);
            if (review.scope === 'AGENT') {
                return jsonResponse(await closeAgentAccessReview(ctx, params.reviewId));
            }
            const viaConnected = subjectTableOf(review.scope) === 'CONNECTED';
            const result = viaConnected
                ? await closeConnectedAccessReview(ctx, params.reviewId)
                : await closeAccessReview(ctx, params.reviewId);
            return jsonResponse(result);
        },
    ),
);
