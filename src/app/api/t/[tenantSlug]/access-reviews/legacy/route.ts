/**
 * Create a LEGACY_APP access review from one legacy application's reconciled
 * snapshot (Step 5b's create, over HTTP).
 *
 *   POST /api/t/:slug/access-reviews/legacy
 *
 * A leaf of its own, as CONNECTED_APP has `/connected` and agents `/agents`:
 * `POST /access-reviews` refuses LEGACY_APP by name (`SCOPE_HAS_ITS_OWN_ROUTE`)
 * and points here. Until this route, `createLegacyAccessReview` had no HTTP
 * entrance at all.
 *
 * Authorisation is enforced twice, as on the siblings: here by
 * `requirePermission` on `access_reviews.create`, whose denials write an
 * `AUTHZ_DENIED` row, and again in the usecase by `assertCanAdmin`, which
 * protects its non-HTTP callers.
 *
 * The route parses, authorises and delegates — nothing else. Every rule that
 * makes the campaign a true claim lives in `createLegacyAccessReview`: the
 * five named refusals (NO_SNAPSHOT, SNAPSHOT_INCOMPLETE, SNAPSHOT_STALE,
 * NOT_RECONCILED, NO_SUBJECTS — each a 400 carrying its code), the subjects
 * frozen at create, and the snapshot's population coverage frozen into each
 * subject's provenance (#3325). Do not add a check here that the usecase also
 * makes; a second copy is a copy that drifts.
 *
 * The body is parsed `.strict()` with `parseJsonBody` INSIDE the handler, as
 * the member create does, so authorisation runs before the body is read and a
 * key this route does not take is a 400 rather than silently dropped. The
 * usecase parses the same fields again, tolerantly, for its other callers.
 */
import { NextRequest } from 'next/server';
import { createLegacyAccessReview } from '@/app-layer/usecases/access-review-legacy';
import { CreateLegacyAccessReviewBodySchema } from '@/app-layer/schemas/access-review.schemas';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'access_reviews.create',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = await parseJsonBody(req, CreateLegacyAccessReviewBodySchema);
            const result = await createLegacyAccessReview(ctx, body);
            return jsonResponse(result, { status: 201 });
        },
    ),
);
