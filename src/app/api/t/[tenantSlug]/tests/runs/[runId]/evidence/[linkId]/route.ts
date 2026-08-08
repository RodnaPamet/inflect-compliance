/**
 * DELETE /api/t/[tenantSlug]/tests/runs/[runId]/evidence/[linkId] — Unlink evidence from a test run
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { unlinkEvidenceFromRun } from '@/app-layer/usecases/control';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

export const DELETE = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; runId: string; linkId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    // Scope the unlink to THIS run — the link must belong to the run in the URL.
    await unlinkEvidenceFromRun(ctx, params.runId, params.linkId);
    return jsonResponse({ ok: true });
});
