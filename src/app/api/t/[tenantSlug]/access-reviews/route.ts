/**
 * Epic G-4 — Access Review campaign list + create.
 *
 *   GET  /api/t/:slug/access-reviews         → CappedList<AccessReviewSummary>
 *   POST /api/t/:slug/access-reviews         → { accessReviewId, snapshotCount }
 *
 * Both surfaces delegate to `src/app-layer/usecases/access-review.ts`
 * — every sanitisation and snapshot rule lives there.
 *
 * ─── AUTHORISATION IS ENFORCED TWICE, DELIBERATELY ──────────────────────
 *
 * At the route by `requirePermission`, whose denials write an `AUTHZ_DENIED`
 * audit row, and again in the usecase by `assertCanRead` / `assertCanAdmin`,
 * which protects non-HTTP callers. Step 5a added the first; before it, a
 * refusal to list or create a campaign left no trace in the one artefact this
 * product exists to produce. The caller sets are unchanged — see the
 * `access_reviews` docblock in `src/lib/permissions.ts`.
 *
 * The POST body is read with `parseJsonBody` INSIDE the handler rather than by
 * composing `withValidatedBody`, whose handler takes the parsed body in the
 * third argument `requirePermission` uses for `ctx`. Authorisation therefore
 * runs BEFORE the body is parsed, which is the order we want.
 */
import { NextRequest } from 'next/server';
import {
    listAccessReviews,
    createAccessReview,
} from '@/app-layer/usecases/access-review';
import { CreateAccessReviewSchema } from '@/app-layer/schemas/access-review.schemas';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import {
    LIST_BACKFILL_CAP,
    applyBackfillCap,
} from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

type ReviewParams = { tenantSlug: string };

export const GET = withApiErrorHandling(
    requirePermission<ReviewParams>(
        'access_reviews.view',
        async (_req: NextRequest, _routeArgs, ctx) => {
            const reviews = await listAccessReviews(ctx, {
                take: LIST_BACKFILL_CAP + 1,
            });
            const result = applyBackfillCap(reviews);
            recordListPageRowCount({
                entity: 'access-reviews',
                count: result.rows.length,
                truncated: result.truncated,
                tenantId: ctx.tenantId,
            });
            return jsonResponse(result);
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<ReviewParams>(
        'access_reviews.create',
        async (req: NextRequest, _routeArgs, ctx) => {
            const body = await parseJsonBody(req, CreateAccessReviewSchema);
            const result = await createAccessReview(ctx, body);
            return jsonResponse(result, { status: 201 });
        },
    ),
);
