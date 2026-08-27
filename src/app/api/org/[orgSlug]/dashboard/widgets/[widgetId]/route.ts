/**
 * Epic 41 — Configurable Dashboard Widget Engine.
 *
 *   PATCH  /api/org/[orgSlug]/dashboard/widgets/[widgetId]   update one widget
 *   DELETE /api/org/[orgSlug]/dashboard/widgets/[widgetId]   delete one widget
 *
 * Both routes scope strictly by the resolved OrgContext — a widget
 * owned by another org returns 404 (no information disclosure). The
 * usecase enforces the (orgId, widgetId) pair on the underlying
 * `where` clause.
 */
import { NextRequest, NextResponse } from 'next/server';

import { getOrgCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requireOrgPermission } from '@/lib/security/org-permission-middleware';
import { withValidatedBody } from '@/lib/validation/route';
import { UpdateOrgDashboardWidgetInput } from '@/app-layer/schemas/org-dashboard-widget.schemas';
import {
    updateOrgDashboardWidget,
    deleteOrgDashboardWidget,
} from '@/app-layer/usecases/org-dashboard-widgets';

interface RouteContext {
    params: Promise<{ orgSlug: string; widgetId: string }>;
}

export const PATCH = withApiErrorHandling(
    withValidatedBody(
        UpdateOrgDashboardWidgetInput,
        async (req: NextRequest, routeCtx: RouteContext, body) => {
            const ctx = await getOrgCtx(
                { orgSlug: (await routeCtx.params).orgSlug },
                req,
            );
            const widget = await updateOrgDashboardWidget(
                ctx,
                (await routeCtx.params).widgetId,
                body,
            );
            return NextResponse.json({ widget });
        },
    ),
);

type DeleteParams = { orgSlug: string; widgetId: string };

/**
 * Gated on `canConfigureDashboard`, mirroring `assertCanWriteOrgWidgets` in
 * the usecase. The gate is what makes a refusal auditable — the assert throws
 * 403 and records nothing, so a blocked delete left no trace (#2147). The
 * assert stays: it protects non-HTTP callers.
 */
export const DELETE = withApiErrorHandling(
    requireOrgPermission<DeleteParams>('canConfigureDashboard', async (_req, { params }, ctx) => {
        const result = await deleteOrgDashboardWidget(ctx, params.widgetId);
        return NextResponse.json(result);
    }),
);
