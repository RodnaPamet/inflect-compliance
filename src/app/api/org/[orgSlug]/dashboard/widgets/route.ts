/**
 * Epic 41 — Configurable Dashboard Widget Engine.
 *
 *   GET  /api/org/[orgSlug]/dashboard/widgets   list all widgets
 *   POST /api/org/[orgSlug]/dashboard/widgets   create one widget
 *
 * Both routes resolve OrgContext via `getOrgCtx` and gate on the
 * appropriate org-scoped permission (read = canViewPortfolio,
 * write = canConfigureDashboard). The Zod-validated body for POST
 * locks the per-(type, chartType) config shape so persisted JSON is
 * never an arbitrary blob.
 */
import { NextRequest, NextResponse } from 'next/server';

import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { CreateOrgDashboardWidgetInput } from '@/app-layer/schemas/org-dashboard-widget.schemas';
import {
    listOrgDashboardWidgets,
    createOrgDashboardWidget,
} from '@/app-layer/usecases/org-dashboard-widgets';
import { cachedAggregationRead } from '@/lib/cache/aggregation-cache';
import { AGGREGATIONS } from '@/lib/cache/aggregation-registry';

interface RouteContext {
    params: Promise<{ orgSlug: string }>;
}

export const GET = withApiErrorHandling(
    async (req: NextRequest, routeCtx: RouteContext) => {
        const ctx = await getOrgCtx((await routeCtx.params), req);
        // Org-scoped aggregation: key on organizationId, not tenantId.
        const widgets = await cachedAggregationRead({
            scopeKey: ctx.organizationId,
            aggregation: 'org-dashboard-widgets',
            dependsOn: AGGREGATIONS['org-dashboard-widgets'].dependsOn,
            ttlSeconds: AGGREGATIONS['org-dashboard-widgets'].ttlSeconds,
            compute: () => listOrgDashboardWidgets(ctx),
        });
        return NextResponse.json({ widgets });
    },
);

export const POST = withApiErrorHandling(
    requireOrgPermission<{ orgSlug: string }>('canConfigureDashboard', async (req, _args, ctx) => {
        const body = await parseJsonBody(req, CreateOrgDashboardWidgetInput);
        const widget = await createOrgDashboardWidget(ctx, body);
        return NextResponse.json({ widget }, { status: 201 });
    }),
);
