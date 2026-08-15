import { NextRequest, NextResponse } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import {
    computeReadiness, exportReadinessJson, exportUnmappedCsv, exportControlGapsCsv, getReadinessHistory,
    getAuditCycle,
} from '@/app-layer/usecases/audit-readiness';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { contentDispositionHeader } from '@/lib/http/content-disposition';

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; cycleId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    if (action === 'export-json') {
        const data = await exportReadinessJson(ctx, params.cycleId);
        return jsonResponse(data);
    }

    if (action === 'export-unmapped-csv') {
        const { csv, filename } = await exportUnmappedCsv(ctx, params.cycleId);
        return new NextResponse(csv, {
            headers: { 'Content-Type': 'text/csv', 'Content-Disposition': contentDispositionHeader(filename) },
        });
    }

    if (action === 'export-control-gaps-csv') {
        const { csv, filename } = await exportControlGapsCsv(ctx, params.cycleId);
        return new NextResponse(csv, {
            headers: { 'Content-Type': 'text/csv', 'Content-Disposition': contentDispositionHeader(filename) },
        });
    }

    // feat/readiness-trend — the ReadinessSnapshot time-series for this cycle,
    // so the snapshot table (written on every score) stops being write-only.
    if (action === 'history') {
        const cycle = await getAuditCycle(ctx, params.cycleId);
        const rows = await getReadinessHistory(ctx, cycle.frameworkKey, { cycleId: params.cycleId, take: 60 });
        // Ascending for charting (oldest → newest).
        return jsonResponse({ snapshots: rows.slice().reverse() });
    }

    // Default: compute readiness
    const result = await computeReadiness(ctx, params.cycleId);
    return jsonResponse(result);
});
