/**
 * Step 3d (#3677) — one sampled workpaper, for the reviewer it is assigned to
 * (and, read-only, for internal audit's overview).
 *
 *   GET  /api/t/:slug/audits/workpaper-reviews/:reviewId
 *        the review, the whole workpaper it is about, and whether this
 *        viewer may answer it
 *   POST /api/t/:slug/audits/workpaper-reviews/:reviewId
 *        body: { "outcome": "CONCURRED" | "DISSENTED" | "INDETERMINATE",
 *                "dissentCodes"?: [...] }
 *
 * Gated by `audits.view`, as the queue is. The usecase admits only the
 * assigned reviewer, a person, still an ACTIVE third-line member and not the
 * auditor agent's owner; each other caller is a 403 with a named reason and a
 * hash-chained `AUTHZ_DENIED` row. The answer is write-once, codes not prose,
 * and a DISSENTED answer queues one finding proposal for a person to decide.
 *
 * The body is not parsed here beyond JSON: the usecase owns the schema, so
 * every caller is validated by the same rules.
 */
import { NextRequest } from 'next/server';
import {
    getWorkpaperReview,
    recordWorkpaperReview,
} from '@/app-layer/usecases/audit-workpaper-sample-review';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'audits.view',
        async (_req: NextRequest, { params }, ctx) => jsonResponse(await getWorkpaperReview(ctx, params.reviewId)),
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'audits.view',
        async (req: NextRequest, { params }, ctx) => {
            const body = await req.json().catch(() => ({}));
            return jsonResponse(await recordWorkpaperReview(ctx, params.reviewId, body));
        },
    ),
);
