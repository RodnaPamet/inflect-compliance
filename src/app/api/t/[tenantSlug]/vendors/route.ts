import { listVendors, listVendorsPaginated, listVendorKpiCounts, createVendor } from '@/app-layer/usecases/vendor';
import { CreateVendorSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { z } from 'zod';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

const VendorQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    status: z.string().optional(),
    criticality: z.string().optional(),
    riskRating: z.string().optional(),
    reviewDue: z.enum(['overdue', 'next30d']).optional(),
    q: z.string().optional().transform(normalizeQ),
}).strip();

export const GET = withApiErrorHandling(requirePermission<{ tenantSlug: string }>('vendors.view', async (req, _routeArgs, ctx) => {
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = VendorQuerySchema.parse(sp);

    const hasPagination = query.limit || query.cursor;
    if (hasPagination) {
        const result = await listVendorsPaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters: {
                status: query.status,
                criticality: query.criticality,
                riskRating: query.riskRating,
                reviewDue: query.reviewDue,
                q: query.q,
            },
        });
        return jsonResponse(result);
    }

    // PR-5 — backfill cap.
    const vendors = await listVendors(
        ctx,
        {
            status: query.status,
            criticality: query.criticality,
            riskRating: query.riskRating,
            reviewDue: query.reviewDue,
            q: query.q,
        },
        { take: LIST_BACKFILL_CAP + 1 },
    );
    const result = applyBackfillCap(vendors);
    // KPI card counts come from aggregates, not from `result.rows` and not
    // from getVendorMetrics' 5,000-row read — so they stay correct above the
    // cap and cost four integers instead of the whole register.
    const kpiCounts = await listVendorKpiCounts(ctx, {
        status: query.status,
        criticality: query.criticality,
        riskRating: query.riskRating,
        reviewDue: query.reviewDue,
        q: query.q,
    });
    // PR-6 — row-count observability.
    recordListPageRowCount({
        entity: 'vendors',
        count: result.rows.length,
        truncated: result.truncated,
        tenantId: ctx.tenantId,
    });
    return jsonResponse({ ...result, kpiCounts });
}));

export const POST = withApiErrorHandling(requirePermission<{ tenantSlug: string }>('vendors.create', async (req, _routeArgs, ctx) => {
    const body = await parseJsonBody(req, CreateVendorSchema);
    const vendor = await createVendor(ctx, body);
    return jsonResponse(vendor, { status: 201 });
}));
