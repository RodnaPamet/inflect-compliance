import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { getCorrelationMatrix, setCorrelation, removeCorrelation } from '@/app-layer/usecases/risk-correlation';
import { parseJsonBody } from '@/lib/validation/route';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

/** RQ-8 — correlation matrix: GET matrix, PUT set a pair, DELETE remove a pair. */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        return jsonResponse({ matrix: await getCorrelationMatrix(ctx) });
    },
);

const SetSchema = z.object({
    riskAId: z.string().min(1),
    riskBId: z.string().min(1),
    coefficient: z.number().min(-1).max(1),
    rationale: z.string().max(2000).optional(),
});

const DelSchema = z.object({ riskAId: z.string().min(1), riskBId: z.string().min(1) });

type Params = { tenantSlug: string };

/**
 * PUT and DELETE both gate on `risks.edit`, mirroring `assertCanWrite` in
 * `setCorrelation` / `removeCorrelation`, so a refusal is auditable (#2117).
 * The asserts stay — they protect non-HTTP callers.
 *
 * BOTH write verbs, not the DELETE alone. Overwriting a correlation coefficient
 * is how you erase one: `setCorrelation` on an existing pair replaces the
 * stored value, and a coefficient driven to 0 removes the dependence between
 * two risks from every aggregate that reads this matrix, leaving the row in
 * place. Gating the DELETE and not the PUT would audit the visible removal and
 * miss the quiet one — and the census that tracks this counts a module with one
 * gated and one ungated destructive handler as ungated for exactly that reason.
 *
 * Both read their body with `parseJsonBody` rather than composing
 * `withValidatedBody`, whose handler takes the parsed body in the third
 * argument `requirePermission` uses for `ctx`. One consequence is deliberate:
 * authorization now runs BEFORE the body is parsed, so an unauthorized caller
 * sending malformed JSON is refused rather than told its JSON is malformed.
 */
export const PUT = withApiErrorHandling(
    requirePermission<Params>('risks.edit', async (req, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, SetSchema);
        await setCorrelation(ctx, body);
        return jsonResponse({ success: true });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('risks.edit', async (req, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, DelSchema);
        await removeCorrelation(ctx, body.riskAId, body.riskBId);
        return jsonResponse({ success: true });
    }),
);
