import {
    listIncidents,
    listIncidentKpiCounts,
    createIncident,
} from '@/app-layer/usecases/incident';
import { CreateIncidentSchema } from '@/app-layer/schemas/incident.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

export const GET = withApiErrorHandling(
    requirePermission('incidents.view', async (_req, _routeArgs, ctx) => {
        // PR-5 backfill cap: read one past the cap, so a truncated list is a
        // fact the response carries (`truncated`) rather than a silent stop.
        const incidents = await listIncidents(ctx, { take: LIST_BACKFILL_CAP + 1 });
        const result = applyBackfillCap(incidents);
        // The KPI cards are counted over every incident, not over `rows`.
        const kpiCounts = await listIncidentKpiCounts(ctx);
        recordListPageRowCount({
            entity: 'incidents',
            count: result.rows.length,
            truncated: result.truncated,
            tenantId: ctx.tenantId,
        });
        return jsonResponse({ ...result, kpiCounts });
    }),
);

export const POST = withApiErrorHandling(
    requirePermission('incidents.manage', async (req, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, CreateIncidentSchema);
        const incident = await createIncident(ctx, body);
        return jsonResponse(incident, { status: 201 });
    }),
);
