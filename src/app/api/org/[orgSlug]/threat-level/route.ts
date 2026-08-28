/**
 * Org-wide threat level — current posture + set.
 *
 *   GET /api/org/[orgSlug]/threat-level   → current posture (read)
 *   PUT /api/org/[orgSlug]/threat-level   → set posture (canSetThreatLevel)
 *
 * PUT is mutation-rate-limited (withApiErrorHandling default) and audits
 * via ORG_THREAT_LEVEL_SET in the usecase.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import {
    getCurrentOrgThreatLevel,
    setOrgThreatLevel,
    ORG_THREAT_TIERS,
} from '@/app-layer/usecases/org-threat-level';

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

const SetThreatLevelSchema = z
    .object({
        level: z.enum(ORG_THREAT_TIERS),
        summary: z.string().min(1).max(280),
        detail: z.string().max(4000).nullish(),
    })
    .strip();

export const GET = withApiErrorHandling(
    async (req: NextRequest, routeCtx: RouteContext) => {
        const ctx = await getOrgCtx(await routeCtx.params, req);
        const current = await getCurrentOrgThreatLevel(ctx);
        return NextResponse.json({ threatLevel: current });
    },
);

export const PUT = withApiErrorHandling(
    requireOrgPermission<{ orgSlug: string }>('canSetThreatLevel', async (req, _args, ctx) => {
        const body = await parseJsonBody(req, SetThreatLevelSchema);
        const updated = await setOrgThreatLevel(ctx, {
            level: body.level,
            summary: body.summary,
            detail: body.detail ?? null,
        });
        return NextResponse.json({ threatLevel: updated });
    }),
);
