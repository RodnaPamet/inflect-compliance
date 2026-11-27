/**
 * The LLM evaluation nightlies' switches, from an organization's settings
 * page (owner decision 2026-11-27).
 *
 *   GET /api/org/[orgSlug]/eval-nightlies → each nightly's state, and whether
 *                                           the caller may switch it (org
 *                                           admin tier)
 *   PUT /api/org/[orgSlug]/eval-nightlies → turn one nightly on or off
 *                                           (canSwitchEvalNightlies: ORG_OWNER,
 *                                           and the org must be named in
 *                                           EVALS_SWITCH_ORG_SLUGS)
 *
 * PUT is mutation-rate-limited (withApiErrorHandling default), refuses a
 * non-owner through `requireOrgPermission` with an `ORG_AUTHZ_DENIED` row, and
 * the usecase refuses (and audits) an owner of a non-operator organization and
 * audits a change as `ORG_EVAL_NIGHTLY_SWITCHED`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { EVAL_NIGHTLY_KEYS } from '@/lib/evals/evaluation-nightlies';
import { getEvalNightlySwitches, setEvalNightlySwitch } from '@/app-layer/usecases/eval-nightly-switches';

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

// STRICT: one nightly per request, and an unknown key is a 400.
const SetEvalNightlySchema = z
    .object({
        nightly: z.enum(EVAL_NIGHTLY_KEYS),
        enabled: z.boolean(),
    })
    .strict();

export const GET = withApiErrorHandling(async (req: NextRequest, routeCtx: RouteContext) => {
    const ctx = await getOrgCtx(await routeCtx.params, req);
    return NextResponse.json({ switches: await getEvalNightlySwitches(ctx) });
});

export const PUT = withApiErrorHandling(
    requireOrgPermission<{ orgSlug: string }>('canSwitchEvalNightlies', async (req, _args, ctx) => {
        const body = await parseJsonBody(req, SetEvalNightlySchema);
        return NextResponse.json({ switches: await setEvalNightlySwitch(ctx, body) });
    }),
);
