/**
 * POST /api/t/[tenantSlug]/reports/pdf/generate
 *
 * Generate a branded PDF report and return it.
 * Body: { type: "AUDIT_READINESS"|"RISK_REGISTER"|"GAP_ANALYSIS", saveToFileRecord?: boolean, watermark?: "DRAFT"|"FINAL"|"NONE" }
 *
 * If saveToFileRecord=true, persists to local storage + FileRecord and returns { fileId } as JSON.
 * Otherwise returns the PDF as application/pdf.
 */
import { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { z } from 'zod';
import { ReportType } from '@/lib/pdf/types';
import type { WatermarkMode } from '@/lib/pdf/types';
import { generateAuditReadinessPdf } from '@/app-layer/reports/pdf/auditReadiness';
import { generateRiskRegisterPdf } from '@/app-layer/reports/pdf/riskRegister';
import { generateGapAnalysisPdf } from '@/app-layer/reports/pdf/gapAnalysis';
import { logEvent } from '@/app-layer/events/audit';
import { runInTenantContext } from '@/lib/db-context';
import { getStorageProvider, buildTenantObjectKey } from '@/lib/storage';
import { FEATURES } from '@/lib/entitlements';
import { requireFeature } from '@/lib/entitlements-server';
import { logger } from '@/lib/observability/logger';
import { jsonResponse } from '@/lib/api-response';

const GenerateSchema = z.object({
    type: z.nativeEnum(ReportType),
    saveToFileRecord: z.boolean().optional().default(false),
    watermark: z.enum(['DRAFT', 'FINAL', 'NONE']).optional().default('NONE'),
    // PR-H — the selected framework (from the Reports selector). Absent → the
    // generator falls back to the resolved installed framework.
    framework: z.string().min(1).optional(),
}).strip();

const REPORT_TITLES: Record<ReportType, string> = {
    [ReportType.AUDIT_READINESS]: 'Audit_Readiness_Report',
    [ReportType.RISK_REGISTER]: 'Risk_Register',
    [ReportType.GAP_ANALYSIS]: 'Gap_Analysis_Report',
};

/**
 * Collect all data from a PDFKit document into a Buffer.
 * Attaches listeners first, then calls doc.end() to ensure no events are lost.
 */
function collectPdfBuffer(pdfDoc: PDFKit.PDFDocument): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        pdfDoc.on('data', (chunk: Buffer) => chunks.push(chunk));
        pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
        pdfDoc.on('error', reject);
        // Finalize the document AFTER listeners are attached
        pdfDoc.end();
    });
}

// Force Node.js runtime — PDFKit needs stream, zlib, Buffer
export const runtime = 'nodejs';
export const maxDuration = 60;

export const POST = withApiErrorHandling(
    requirePermission('reports.export', async (req: NextRequest, _routeArgs, ctx) => {

    // ─── Plan check: PDF exports require TRIAL+ ───
    await requireFeature(ctx.tenantId, FEATURES.PDF_EXPORTS);

    const body = GenerateSchema.parse(await req.json());

    // ─── Generate PDF ───

    const watermark = body.watermark as WatermarkMode;
    let pdfDoc: PDFKit.PDFDocument;

    try {
        switch (body.type) {
            case ReportType.AUDIT_READINESS:
                pdfDoc = await generateAuditReadinessPdf(ctx, { watermark, framework: body.framework });
                break;
            case ReportType.RISK_REGISTER:
                pdfDoc = await generateRiskRegisterPdf(ctx, { watermark });
                break;
            case ReportType.GAP_ANALYSIS:
                pdfDoc = await generateGapAnalysisPdf(ctx, { watermark, framework: body.framework });
                break;
            default:
                return jsonResponse({ error: 'Unknown report type' }, { status: 400 });
        }
    } catch (genErr) {
        logger.error('PDF generation failed', { component: 'report', reportType: body.type });
        throw genErr;
    }

    // Buffer the PDF (doc.end() was already called in the generator)
    const pdfBuffer = await collectPdfBuffer(pdfDoc);

    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `${REPORT_TITLES[body.type]}_${dateStr}.pdf`;

    // ─── Audit log ───
    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'REPORT_GENERATED',
            entityType: 'Report',
            entityId: body.type,
            details: JSON.stringify({ type: body.type, fileName, sizeBytes: pdfBuffer.length, saveToFileRecord: body.saveToFileRecord }),
        })
    );

    // ─── Save to FileRecord (if requested) ───
    if (body.saveToFileRecord) {
        const storage = getStorageProvider();
        const pathKey = buildTenantObjectKey(ctx.tenantId, 'reports', fileName);
        const { Readable } = await import('stream');
        const writeResult = await storage.write(pathKey, Readable.from(pdfBuffer), {
            mimeType: 'application/pdf',
        });


        const fileRecord = await runInTenantContext(ctx, (db) =>

            db.fileRecord.create({
                data: {
                    tenantId: ctx.tenantId,
                    pathKey,
                    originalName: fileName,
                    mimeType: 'application/pdf',
                    sizeBytes: writeResult.sizeBytes,
                    sha256: writeResult.sha256,
                    status: 'STORED',
                    uploadedByUserId: ctx.userId,
                    storedAt: new Date(),
                    storageProvider: storage.name,
                    domain: 'reports',
                    scanStatus: 'SKIPPED',
                },
            })
        ) as { id: string };

        return jsonResponse({
            fileId: fileRecord.id,
            fileName,
            sizeBytes: writeResult.sizeBytes,
        });
    }

    // ─── Return PDF ───
    return new Response(new Uint8Array(pdfBuffer), {
        status: 200,
        headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Cache-Control': 'no-store',
            'Content-Length': String(pdfBuffer.length),
        },
    });
    }),
);

