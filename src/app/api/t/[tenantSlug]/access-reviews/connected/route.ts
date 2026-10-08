/**
 * PR-7 — launch a CONNECTED_APP access review over connected identity accounts.
 *
 * Authorisation is enforced at the route by `requirePermission` (denials write
 * an `AUTHZ_DENIED` row) and again in `createConnectedAccessReview` by
 * `assertCanAdmin`, which protects non-HTTP callers. Step 5a added the first.
 */
import { NextRequest } from 'next/server';
import { createConnectedAccessReview } from '@/app-layer/usecases/access-review-connected';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'access_reviews.create',
        async (req: NextRequest, _routeArgs, ctx) => {
            // The usecase parses with `CreateConnectedAccessReviewSchema`, so the
            // route forwards the raw body — unchanged from before Step 5a.
            const body = await req.json().catch(() => ({}));
            const result = await createConnectedAccessReview(ctx, body);
            return jsonResponse(result, { status: 201 });
        },
    ),
);
