import { NextRequest, NextResponse } from 'next/server';
import { getSoA } from '@/app-layer/usecases/soa';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { logEvent } from '@/app-layer/events/audit';
import { runInTenantContext } from '@/lib/db-context';

/**
 * SoA CSV Export
 *
 * Columns are framework-family-dependent — the Applicability/Justification
 * pair is an ISO-27001 Annex-A construct, so only the ISO family gets them:
 *
 *   ISO family:
 *     AnnexAKey | Title | Section | Applicable | Justification |
 *     ImplementationStatus | ControlRefs | Owner | Frequency |
 *     EvidenceCount | OpenTasks | LastTestResult
 *   Non-ISO family (neutral coverage/readiness CSV):
 *     RequirementKey | Title | Section | ImplementationStatus |
 *     ControlRefs | Owner | Frequency | EvidenceCount | OpenTasks |
 *     LastTestResult
 *
 * No internal IDs are exposed — uses requirement/control codes and titles only.
 */

function escapeCSV(value: string | null | undefined): string {
    const s = String(value ?? '');
    // Wrap in quotes if contains comma, quote, or newline
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

export const GET = withApiErrorHandling(
    requirePermission('reports.export', async (req: NextRequest, _routeArgs, ctx) => {

    // PR-H — scope to the selected framework; the CSV names the real framework.
    const requestedFramework =
        new URL(req.url).searchParams.get('framework') || undefined;
    const report = await getSoA(ctx, {
        framework: requestedFramework,
        includeEvidence: true,
        includeTasks: true,
        includeTests: true,
    });
    const isIso = report.isIsoFamily;

    // ─── Build CSV ───
    // The SoA columns (Annex-A key + Applicability + Justification) are an
    // ISO-27001 artifact; a non-ISO framework gets a neutral coverage/readiness
    // CSV that never shows Applicability/Justification.
    const headers = isIso
        ? [
              'AnnexAKey',
              'Title',
              'Section',
              'Applicable',
              'Justification',
              'ImplementationStatus',
              'ControlRefs',
              'Owner',
              'Frequency',
              'EvidenceCount',
              'OpenTasks',
              'LastTestResult',
          ]
        : [
              'RequirementKey',
              'Title',
              'Section',
              'ImplementationStatus',
              'ControlRefs',
              'Owner',
              'Frequency',
              'EvidenceCount',
              'OpenTasks',
              'LastTestResult',
          ];

    const rows = report.entries.map(entry => {
        const controlRefs = entry.mappedControls
            .map(c => `${c.code || '—'} ${c.title}`)
            .join('; ');

        const owners = [...new Set(
            entry.mappedControls
                .map(c => c.owner)
                .filter(Boolean)
        )].join('; ');

        const frequencies = [...new Set(
            entry.mappedControls
                .map(c => c.frequency)
                .filter(Boolean)
        )].join('; ');

        const applicable = entry.applicable === true ? 'Yes'
            : entry.applicable === false ? 'No'
            : 'Unmapped';

        const common = [
            escapeCSV(entry.implementationStatus?.replace(/_/g, ' ')),
            escapeCSV(controlRefs),
            escapeCSV(owners),
            escapeCSV(frequencies),
            String(entry.evidenceCount),
            String(entry.openTaskCount),
            escapeCSV(entry.lastTestResult),
        ];
        const lead = [
            escapeCSV(entry.requirementCode),
            escapeCSV(entry.requirementTitle),
            escapeCSV(entry.section),
        ];
        return (
            isIso
                ? [...lead, escapeCSV(applicable), escapeCSV(entry.justification), ...common]
                : [...lead, ...common]
        ).join(',');
    });

    const csv = [headers.join(','), ...rows].join('\r\n');

    // ─── Audit log ───
    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'SOA_EXPORTED',
            entityType: 'SoAReport',
            entityId: report.framework,
            details: `SoA exported as CSV (${report.entries.length} entries)`,
            metadata: { format: 'csv', entryCount: report.entries.length },
        })
    );

    // ─── Response ───
    // PR-H — filename derives from the resolved framework, not an ISO literal.
    const now = new Date().toISOString().slice(0, 10);
    const fwSlug = report.framework.replace(/[^A-Za-z0-9]+/g, '');
    const kind = isIso ? 'SoA' : 'Coverage';
    const filename = `${ctx.tenantSlug || 'tenant'}_${fwSlug}_${kind}_${now}.csv`;

    return new NextResponse(csv, {
        status: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-cache, no-store',
        },
    });
    }),
);
