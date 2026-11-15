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
 * GET also carries `preparation`: where a background preparation stands
 * (queued, running with N of M subjects done, failed with its refusal), or
 * null when there is none to show (#5317). It is read only after the packs
 * read has passed its gate.
 *
 * POST prepares the packs, once, through the read-only pack workflow. It
 * carries `access_reviews.create` (OWNER + ADMIN), mirroring the
 * `assertCanAdmin` in `prepareAgentReviewPacks`: preparing is the second half
 * of creating the campaign, and writes nothing a decision depends on until
 * every page of the population succeeded. A campaign of up to
 * `SYNC_PACK_RUN_LIMIT` pack runs is prepared inside the request (201); a
 * larger one is handed to the `agent-recert-packs-prepare` job (202), which
 * prepares it as the person who asked, re-read when it runs (#5317).
 */
import { NextRequest } from 'next/server';
import {
    getAgentReviewPacks,
    readAgentPackPreparation,
    requestAgentReviewPacks,
} from '@/app-layer/usecases/access-review-agent';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.view',
        async (_req: NextRequest, { params }, ctx) => {
            const packs = await getAgentReviewPacks(ctx, params.reviewId);
            // Asked only while there are no packs: once they are written there
            // is no preparation left to show, and the queue is not read.
            const preparation = packs.packs.length === 0
                ? await readAgentPackPreparation(ctx, params.reviewId)
                : null;
            return jsonResponse({ ...packs, preparation });
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string; reviewId: string }>(
        'access_reviews.create',
        async (_req: NextRequest, { params }, ctx) => {
            const result = await requestAgentReviewPacks(ctx, params.reviewId);
            return jsonResponse(result, { status: result.mode === 'QUEUED' ? 202 : 201 });
        },
    ),
);
