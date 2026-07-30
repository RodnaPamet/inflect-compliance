import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { getTenantCtx } from '@/app-layer/context';
import {
    getReport,
    openReportArtefact,
    FORMAT_META,
    type ReportFormat,
} from '@/app-layer/usecases/risk-report';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { logEvent } from '@/app-layer/events/audit';
import { runInTenantContext } from '@/lib/db-context';

// The storage stream and Readable.toWeb both need Node primitives.
export const runtime = 'nodejs';

/**
 * RQ-10 — download a generated report's file.
 *
 * Three changes worth naming:
 *
 *   1. **The storage key is asserted against the tenant.** The route used to
 *      pass `run.outputPath` straight to `readStream`, and `readReportArtefact`
 *      took a bare path with no ctx — which made the guard structurally
 *      impossible to write rather than merely absent. Safe today only because
 *      `outputPath` is always produced by `generatePathKey(ctx.tenantId, …)` and
 *      the ReportRun row is read tenant-scoped; that is a property of the
 *      callers, not of this read. `openReportArtefact` now asserts it.
 *
 *   2. **The artefact streams.** It used to be `Buffer.concat`-ed in full before
 *      a single byte reached the client, so a large Deep Dive PDF was held
 *      entirely in the request's memory. Nothing here needs the bytes at once.
 *
 *   3. **The download is audited.** `reports/pdf/generate` and
 *      `reports/soa/export.csv` both log; this route did not — so in a
 *      compliance product, taking a copy of the risk register left no trace,
 *      while producing one did.
 */
export const GET = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; reportId: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const run = await getReport(ctx, params.reportId);
        if (run.status !== 'COMPLETED' || !run.outputPath) throw badRequest('Report is not ready for download');

        // Logged BEFORE the stream is handed to the client: the audit record is
        // about the access decision, which has already been made by this point.
        // Waiting for the transfer to finish would lose the record whenever a
        // client disconnected mid-download — exactly when it matters most.
        await runInTenantContext(ctx, (db) =>
            logEvent(db, ctx, {
                action: 'REPORT_DOWNLOADED',
                entityType: 'ReportRun',
                entityId: run.id,
                detailsJson: {
                    // REQUIRED discriminator — `validateAuditDetailsJson`
                    // rejects a payload without it, and this logEvent is awaited
                    // before the response, so omitting it would 400 every
                    // download. 'access' rather than 'data_lifecycle': nothing
                    // changed, someone took a copy.
                    category: 'access',
                    format: run.format,
                    templateId: run.templateId,
                    sizeBytes: run.outputSizeBytes ?? null,
                },
            }),
        );

        const nodeStream = openReportArtefact(ctx, run.outputPath);
        const mime = (FORMAT_META[run.format as ReportFormat] ?? FORMAT_META.PDF).mime;
        return new NextResponse(
            Readable.toWeb(nodeStream as Readable) as unknown as BodyInit,
            {
                headers: {
                    'Content-Type': mime,
                    'Content-Disposition': `attachment; filename="report-${run.id}.${run.format.toLowerCase()}"`,
                    // Known from the ReportRun row, so the client can show real
                    // progress rather than an indeterminate spinner.
                    ...(run.outputSizeBytes ? { 'Content-Length': String(run.outputSizeBytes) } : {}),
                },
            },
        );
    },
);
