/**
 * GET  /api/t/[tenantSlug]/tests/runs/[runId]/evidence — List evidence linked to a test run
 * POST /api/t/[tenantSlug]/tests/runs/[runId]/evidence — Link evidence to a test run
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listRunEvidence, linkEvidenceToRun } from '@/app-layer/usecases/control';
import { withValidatedBody } from '@/lib/validation/route';
import { LinkTestEvidenceSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; runId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const evidence = await listRunEvidence(ctx, params.runId);
    return jsonResponse(evidence);
});

export const POST = withApiErrorHandling(withValidatedBody(LinkTestEvidenceSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; runId: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const link = await linkEvidenceToRun(ctx, params.runId, body);
    return jsonResponse(link, { status: 201 });
}));
