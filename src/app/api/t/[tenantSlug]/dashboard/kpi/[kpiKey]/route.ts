/**
 * GET /api/t/[tenantSlug]/dashboard/kpi/[kpiKey]
 *
 * On-demand data for a swappable dashboard KPI card + its pie.
 * `kpiKey` ∈ { assets, audits, tests }. Loaded only when the user
 * selects that KPI in the dashboard's custom slot, so it never taxes
 * the default dashboard render. Read-scoped + tenant-scoped via
 * `getTenantCtx` → `getDashboardKpi` (which asserts read access).
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    getDashboardKpi,
    isSwappableKpiKey,
} from '@/app-layer/usecases/dashboard';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string; kpiKey: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        if (!isSwappableKpiKey(params.kpiKey)) {
            throw badRequest(`Unknown KPI key: ${params.kpiKey}`);
        }
        const data = await getDashboardKpi(ctx, params.kpiKey);
        return jsonResponse(data);
    },
);
