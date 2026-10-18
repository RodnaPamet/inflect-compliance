/**
 * Step 3a (#3674) — an AGENT campaign's reviewer packs.
 *
 *   GET  /api/t/:slug/access-reviews/:reviewId/agent-packs
 *   POST /api/t/:slug/access-reviews/:reviewId/agent-packs
 *
 * GET reads the packs, their narrowings, the drawn sample and — once closed —
 * the evidence hash recomputed from the rows beside the stored file's. It
 * carries `access_reviews.view`, which every role holds; a pack is register
 * data, so `getAgentReviewPacks` narrows the read to the campaign's reviewer or
 * a holder of `admin.agent_registry`.
 *
 * POST prepares the packs, once, through the read-only pack workflow. It
 * carries `access_reviews.create` (OWNER + ADMIN), mirroring the
 * `assertCanAdmin` in `prepareAgentReviewPacks`: preparing is the second half
 * of creating the campaign, and writes nothing a decision depends on until
 * every page of the population succeeded.
 */
import { NextRequest } from 'next/server';
import {
    getAgentReviewPacks,
    prepareAgentReviewPacks,
} from '@/app-layer/usecases/access-review-agent';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.view',
        async (_req: NextRequest, { params }, ctx) => {
            return jsonResponse(await getAgentReviewPacks(ctx, params.reviewId));
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.create',
        async (_req: NextRequest, { params }, ctx) => {
            return jsonResponse(await prepareAgentReviewPacks(ctx, params.reviewId), { status: 201 });
        },
    ),
);
