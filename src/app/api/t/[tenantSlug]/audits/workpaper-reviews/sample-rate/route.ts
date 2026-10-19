/**
 * #3677 — internal audit's sampling rate for the auditor agent's workpapers.
 *
 *   PUT /api/t/:slug/audits/workpaper-reviews/sample-rate
 *       body: { "samplePercent": 1..100 }
 *
 * Gated by `audits.view`, the review page's key, because internal audit is
 * often on the AUDITOR role, which holds no `admin.*` and no `audits.manage`.
 * The usecase is the gate: only a PERSON who is an ACTIVE member on the THIRD
 * line of defence and owns no auditor agent changes the rate (owner decision,
 * 2026-10-19). An API key, an agent or a job is `NOT_A_PERSON`; anybody else is
 * refused with the reason it fails — each a 403 with an `AUTHZ_DENIED` row.
 * The change is audited with the rate before and after, and the next sweep
 * draws at it. The column's CHECK holds 1..100 below this.
 */
import { NextRequest } from 'next/server';
import { setWorkpaperReviewSamplePercent } from '@/app-layer/usecases/audit-workpaper-sample-review';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const PUT = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('audits.view', async (req: NextRequest, _route, ctx) => {
        const body = await req.json().catch(() => ({}));
        return jsonResponse(await setWorkpaperReviewSamplePercent(ctx, body));
    }),
);
