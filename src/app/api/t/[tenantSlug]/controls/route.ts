import { listControls, listControlKpiCounts, listControlsPaginated, createControl, listControlsWithDeleted } from '@/app-layer/usecases/control';
import { CreateControlSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { z } from 'zod';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

const ControlsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    status: z.string().optional(),
    // Three display states over a two-value column, comma-joinable for the
    // multi-select — see @/lib/controls/control-applicability. A plain
    // z.enum() would 400 on `?applicability=APPLICABLE,UNASSESSED`, which is
    // exactly what the picker sends; the repository validates each member.
    applicability: z.string().optional(),
    ownerUserId: z.string().optional(),
    q: z.string().optional().transform(normalizeQ),
    // Consistency `?ids=` deep-link (comma-separated) + health verdict facet —
    // both resolved to a server-side `id: { in }` restriction in the usecase.
    ids: z.string().optional(),
    health: z.enum(['HEALTHY', 'DEGRADED', 'AT_RISK', 'NOT_APPLICABLE', 'UNKNOWN']).optional(),
    // Controls-dashboard drill-downs. Enums rather than free strings: each has
    // exactly one meaning, and the card that links here is the only caller, so
    // a typo should 400 at the boundary instead of silently listing every
    // control — which would show a number the card did not claim.
    due: z.enum(['soon']).optional(),
    evidence: z.enum(['missing']).optional(),
    includeDeleted: z.enum(['true', 'false']).optional(),
}).strip();

export const GET = withApiErrorHandling(requirePermission<{ tenantSlug: string }>('controls.view', async (req, _routeArgs, ctx) => {
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = ControlsQuerySchema.parse(sp);

    if (query.includeDeleted === 'true') {
        const controls = await listControlsWithDeleted(ctx);
        return jsonResponse(controls);
    }

    const filters = {
        status: query.status,
        applicability: query.applicability,
        ownerUserId: query.ownerUserId,
        q: query.q,
        ids: query.ids,
        health: query.health,
        due: query.due,
        evidence: query.evidence,
    };

    // If pagination params present, use paginated response
    if (query.limit !== undefined || query.cursor !== undefined) {
        const result = await listControlsPaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters,
        });
        return jsonResponse(result);
    }

    // PR-5 — backfill cap. Ask for cap+1 rows; the helper slices to
    // the cap and reports `truncated: true` if the sentinel was hit.
    const controls = await listControls(ctx, filters, { take: LIST_BACKFILL_CAP + 1 });
    const result = applyBackfillCap(controls);
    // KPI card counts come from aggregates, not from `result.rows`. The rows
    // are filter-scoped AND backfill-capped; every card's click resolves
    // against the tenant, so a count taken from the array could not predict
    // its own click — `total` in particular displayed the filtered length
    // while its click clears every filter.
    const kpiCounts = await listControlKpiCounts(ctx, filters);
    // PR-6 — row-count observability.
    recordListPageRowCount({
        entity: 'controls',
        count: result.rows.length,
        truncated: result.truncated,
        tenantId: ctx.tenantId,
    });
    return jsonResponse({ ...result, kpiCounts });
}));

export const POST = withApiErrorHandling(requirePermission<{ tenantSlug: string }>('controls.create', async (req, _routeArgs, ctx) => {
    const body = await parseJsonBody(req, CreateControlSchema);
    const control = await createControl(ctx, body);
    return jsonResponse(control, { status: 201 });
}));
