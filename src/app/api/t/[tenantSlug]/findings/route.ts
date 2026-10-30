import { NextRequest } from 'next/server';
import { listFindings, createFinding } from '@/app-layer/usecases/finding';
import { parseJsonBody } from '@/lib/validation/route';
import { CreateFindingSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

/**
 * The findings register (#4535). Each verb takes its own `findings.*` key, so a
 * custom role can be given or refused findings apart from its base role, and a
 * refusal writes a hash-chained `AUTHZ_DENIED` row. The usecases still assert
 * the coarse tier behind it.
 *
 * The body is parsed inline rather than through `withValidatedBody`: that
 * wrapper and `requirePermission` both claim the handler's third argument.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('findings.view', async (req: NextRequest, _routeArgs, ctx) => {
        // The register's status facet (`?status=OPEN,IN_PROGRESS`), applied here
        // rather than over the loaded rows so it narrows past the backfill cap.
        const status = req.nextUrl.searchParams.get('status') || undefined;
        // PR-5 — backfill cap.
        const findings = await listFindings(ctx, { take: LIST_BACKFILL_CAP + 1 }, { status });
        const result = applyBackfillCap(findings);
        // PR-6 — row-count observability.
        recordListPageRowCount({
            entity: 'findings',
            count: result.rows.length,
            truncated: result.truncated,
            tenantId: ctx.tenantId,
        });
        return jsonResponse(result);
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('findings.create', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, CreateFindingSchema);
        const finding = await createFinding(ctx, body);
        return jsonResponse(finding, { status: 201 });
    }),
);
