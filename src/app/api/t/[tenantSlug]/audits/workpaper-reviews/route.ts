/**
 * Step 3d (#3677) — internal audit's queue of sampled workpapers.
 *
 *   GET /api/t/:slug/audits/workpaper-reviews
 *
 * Gated by `audits.view` (decided in step 0e, `docs/agentic-iam-roadmap.md`,
 * "Permission keys"): every role holds it, because an internal auditor is
 * often on the AUDITOR role, which holds no `audits.manage`. The usecase
 * narrows the read: internal audit (a person, an ACTIVE third-line member who
 * owns no auditor agent) sees every assignment and its status, read-only but
 * for its own; any other third-line member sees only their own; a caller who
 * is not on the third line gets no rows and the reason. The response also
 * carries the sampling rate and whether this caller may change it.
 *
 * There is no POST here and no route that draws or assigns: a review is
 * opened by the scheduled sweep alone, because a person who could pick which
 * workpapers get re-performed, or who re-performs them, would be choosing the
 * sample.
 */
import { NextRequest } from 'next/server';
import { listWorkpaperReviews } from '@/app-layer/usecases/audit-workpaper-sample-review';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('audits.view', async (_req: NextRequest, _route, ctx) =>
        jsonResponse(await listWorkpaperReviews(ctx)),
    ),
);
