/**
 * Epic G-4 — Close a campaign.
 *
 *   POST /api/t/:slug/access-reviews/:reviewId/close
 *
 * Executes REVOKE/MODIFY decisions against live `TenantMembership`,
 * emits per-row audit entries, and produces the signed PDF artifact.
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
            const review = await getAccessReview(ctx, params.reviewId);
            const viaConnected =
                review?.scope === 'CONNECTED_APP' || review?.scope === 'LEGACY_APP';
            const result = viaConnected
                ? await closeConnectedAccessReview(ctx, params.reviewId)
                : await closeAccessReview(ctx, params.reviewId);
            return jsonResponse(result);
        },
    ),
);
