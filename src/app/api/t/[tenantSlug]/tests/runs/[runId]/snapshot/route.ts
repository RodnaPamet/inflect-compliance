/**
 * POST /api/t/[tenantSlug]/tests/runs/[runId]/snapshot
 * Creates immutable snapshot of a test run in an audit pack.
 * Body: { auditPackId: string }
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { snapshotTestRun } from '@/app-layer/usecases/test-hardening';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

const SnapshotSchema = z.object({ auditPackId: z.string().min(1) });

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; runId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = SnapshotSchema.safeParse(raw);
    if (!parsed.success) {
        return jsonResponse({ error: 'auditPackId is required' }, { status: 400 });
    }
    const item = await snapshotTestRun(ctx, params.runId, parsed.data.auditPackId);
    return jsonResponse(item, { status: 201 });
});
