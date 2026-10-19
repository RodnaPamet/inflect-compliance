/**
 * Step 3d (#3677) — internal audit's queue of sampled workpapers.
 *
 *   GET /api/t/:slug/audits/workpaper-reviews
 *
 * Gated by `audits.view` (decided in step 0e, `docs/agentic-iam-roadmap.md`,
 * "Permission keys"): every role holds it, because an internal auditor is
 * often on the AUDITOR role, which holds no `audits.manage`. The usecase
 * narrows the read to the CALLER's own assigned reviews, and only while the
 * caller is a person, an ACTIVE member and in the third line of defence; a
 * caller who is not gets no rows and the reason.
 *
 * There is no POST here and no route that draws or assigns: a review is
 * opened by the scheduled sweep alone, because a person who could pick which
 * workpapers get re-performed, or who re-performs them, would be choosing the
 * sample.
 */
import { NextRequest } from 'next/server';
import { listMyWorkpaperReviews } from '@/app-layer/usecases/audit-workpaper-sample-review';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('audits.view', async (_req: NextRequest, _route, ctx) =>
        jsonResponse(await listMyWorkpaperReviews(ctx)),
    ),
);
