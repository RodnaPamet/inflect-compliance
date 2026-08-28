/**
 * Org security-maturity rating — current + set.
 *
 *   GET /api/org/[orgSlug]/maturity   → current per-domain levels + overall + coverage hint
 *   PUT /api/org/[orgSlug]/maturity   → set one domain's rating (canSetMaturity)
 *
 * PUT is mutation-rate-limited and audits via ORG_MATURITY_RATING_SET.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import {
    getCurrentOrgMaturity,
    setOrgMaturityRating,
    MATURITY_DOMAINS,
    MATURITY_LEVELS,
} from '@/app-layer/usecases/org-maturity';

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

const SetMaturitySchema = z
    .object({
        domain: z.enum(MATURITY_DOMAINS),
        level: z.enum(MATURITY_LEVELS),
        rationale: z.string().max(4000).nullish(),
    })
    .strip();

export const GET = withApiErrorHandling(
    async (req: NextRequest, routeCtx: RouteContext) => {
        const ctx = await getOrgCtx(await routeCtx.params, req);
        const maturity = await getCurrentOrgMaturity(ctx);
        return NextResponse.json({ maturity });
    },
);

export const PUT = withApiErrorHandling(
    requireOrgPermission<{ orgSlug: string }>('canSetMaturity', async (req, _args, ctx) => {
        const body = await parseJsonBody(req, SetMaturitySchema);
        const rating = await setOrgMaturityRating(ctx, {
            domain: body.domain,
            level: body.level,
            rationale: body.rationale ?? null,
        });
        return NextResponse.json({ rating });
    }),
);
