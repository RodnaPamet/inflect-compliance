import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listFindings, createFinding } from '@/app-layer/usecases/finding';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateFindingSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    // The register's status facet (`?status=OPEN,IN_PROGRESS`), applied here
    // rather than over the loaded rows so it narrows past the backfill cap.
    const status = req.nextUrl.searchParams.get('status') || undefined;
    // PR-5 — backfill cap.
    const findings = await listFindings(ctx, { take: LIST_BACKFILL_CAP + 1, status });
    const result = applyBackfillCap(findings);
    // PR-6 — row-count observability.
    recordListPageRowCount({
        entity: 'findings',
        count: result.rows.length,
        truncated: result.truncated,
        tenantId: ctx.tenantId,
    });
    return jsonResponse(result);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateFindingSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const finding = await createFinding(ctx, body);
    return jsonResponse(finding, { status: 201 });
}));
