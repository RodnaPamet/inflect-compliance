import { listRisks, listRisksPaginated, createRisk, listRisksWithDeleted, listRiskKpiCounts } from '@/app-layer/usecases/risk';
import { getRiskStaleness } from '@/app-layer/usecases/risk-staleness';
import { CreateRiskSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { z } from 'zod';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

const RiskQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    status: z.string().optional(),
    scoreMin: z.coerce.number().int().min(0).optional(),
    scoreMax: z.coerce.number().int().min(0).optional(),
    residualScoreMin: z.coerce.number().int().min(0).optional(),
    residualScoreMax: z.coerce.number().int().min(0).optional(),
    treatment: z.string().optional(),
    // Exact matrix cell(s): comma-joined `L{likelihood}xI{impact}` tokens.
    cell: z.string().optional(),
    quantified: z.enum(['yes', 'no']).optional(),
    stale: z.enum(['true']).optional(),
    category: z.string().optional(),
    ownerUserId: z.string().optional(),
    q: z.string().optional().transform(normalizeQ),
    includeDeleted: z.enum(['true', 'false']).optional(),
}).strip();

/**
 * The shared filter projection for both the paginated + backfill reads.
 * `idIn` is threaded in separately by the handler once the staleness
 * detector has resolved the stale-risk id set (only when `stale=true`).
 */
function toRiskFilters(query: z.infer<typeof RiskQuerySchema>, idIn?: string[]) {
    return {
        status: query.status,
        scoreMin: query.scoreMin,
        scoreMax: query.scoreMax,
        residualScoreMin: query.residualScoreMin,
        residualScoreMax: query.residualScoreMax,
        treatment: query.treatment,
        cell: query.cell,
        quantified: query.quantified,
        category: query.category,
        ownerUserId: query.ownerUserId,
        q: query.q,
        ...(idIn !== undefined ? { idIn } : {}),
    };
}

export const GET = withApiErrorHandling(requirePermission<{ tenantSlug: string }>('risks.view', async (req, _routeArgs, ctx) => {
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = RiskQuerySchema.parse(sp);

    if (query.includeDeleted === 'true') {
        const risks = await listRisksWithDeleted(ctx);
        return jsonResponse(risks);
    }

    // PR-K — the "stale/overdue" filter runs the multi-signal detector
    // server-side and restricts the query to the stale-risk id set.
    let staleIdIn: string[] | undefined;
    if (query.stale === 'true') {
        const report = await getRiskStaleness(ctx);
        staleIdIn = report.staleRisks.map((r) => r.riskId);
    }

    const hasPagination = query.limit || query.cursor;
    if (hasPagination) {
        const result = await listRisksPaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters: toRiskFilters(query, staleIdIn),
        });
        return jsonResponse(result);
    }

    // PR-5 — backfill cap. Ask for cap+1 rows; helper slices and
    // reports `truncated`.
    const risks = await listRisks(
        ctx,
        toRiskFilters(query, staleIdIn),
        { take: LIST_BACKFILL_CAP + 1 },
    );
    const result = applyBackfillCap(risks);
    // KPI card counts come from aggregates, not from `result.rows` — so they
    // stay correct above the cap, and each card counts the set its own click
    // produces rather than the set currently on screen.
    const kpiCounts = await listRiskKpiCounts(ctx, toRiskFilters(query, staleIdIn));
    // PR-6 — row-count observability.
    recordListPageRowCount({
        entity: 'risks',
        count: result.rows.length,
        truncated: result.truncated,
        tenantId: ctx.tenantId,
    });
    return jsonResponse({ ...result, kpiCounts });
}));

export const POST = withApiErrorHandling(requirePermission<{ tenantSlug: string }>('risks.create', async (req, _routeArgs, ctx) => {
    const body = await parseJsonBody(req, CreateRiskSchema);
    const risk = await createRisk(ctx, body);
    return jsonResponse(risk, { status: 201 });
}));
