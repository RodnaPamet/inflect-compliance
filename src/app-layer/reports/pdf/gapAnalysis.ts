/**
 * Gap Analysis PDF Generator
 *
 * PR-U — computed off the readiness spine (`generateReadinessReport`), the SAME
 * payload the on-screen readiness view uses, so "gap" here means exactly what the
 * hub shows: the UNMAPPED requirements (the "Gap analysis — N unmapped" card) plus
 * the MAPPED-BUT-NOT-IMPLEMENTED count (the "Gaps" KPI). It no longer runs the
 * old SoA checks (a fourth, broader Annex-A-shaped definition), so a non-ISO gap
 * report is free of ISO Annex-A concepts.
 *
 *   Cover page → Metadata page → Summary → Unmapped requirements
 */
import crypto from 'crypto';
import type { RequestContext } from '@/app-layer/types';
import { generateReadinessReport } from '@/app-layer/usecases/framework/coverage';
import { resolveInstalledFrameworkKey } from '@/app-layer/usecases/soa';
import { gapAnalysisLabels } from './report-labels';
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import { addCoverPage, addMetadataPage, applyHeadersAndFooters } from '@/lib/pdf/layout';
import { renderTable, autoColumnWidths } from '@/lib/pdf/table';
import { addSectionTitle, addSummaryMetrics, addSpacer, addParagraph } from '@/lib/pdf/sections';
import type { ReportMeta, TableColumn, WatermarkMode, DataSourceNote } from '@/lib/pdf/types';
import prisma from '@/lib/prisma';

export async function generateGapAnalysisPdf(
    ctx: RequestContext,
    options?: { watermark?: WatermarkMode; framework?: string },
): Promise<PDFKit.PDFDocument> {
    // ─── Fetch data — the readiness spine (same payload the view renders) ───
    const frameworkKey = options?.framework && options.framework.length > 0
        ? options.framework
        : await resolveInstalledFrameworkKey(ctx);
    const report = await generateReadinessReport(ctx, frameworkKey);
    const s = report.summary;

    // "Gap" = the two on-screen populations: no-mapping (unmapped) + mapped-not-
    // implemented (gapRequirements). One consistent meaning across screen + export.
    const unmappedCount = report.coverage.unmapped;
    const totalGaps = unmappedCount + s.gapRequirements;

    const tenant = await prisma.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { name: true },
    });

    // ─── Content hash ───
    const dataHash = crypto.createHash('sha256')
        .update(JSON.stringify({ framework: report.framework.key, unmapped: unmappedCount, gaps: s.gapRequirements }))
        .digest('hex');

    const frameworkName = report.framework.version
        ? `${report.framework.name} ${report.framework.version}`
        : report.framework.name;

    // ─── Framework-derived labels (PR-H) — SoA/Annex-A wording gated on the ISO family ───
    const labels = gapAnalysisLabels(
        { frameworkName, hasStatementOfApplicability: report.hasStatementOfApplicability, requirementCount: s.totalRequirements },
        totalGaps,
    );
    const requirementsPhrase = labels.requirementsPhrase;

    // ─── Meta ───
    const meta: ReportMeta = {
        tenantName: tenant?.name || 'Tenant',
        reportTitle: 'Gap Analysis Report',
        reportSubtitle: labels.reportSubtitle,
        generatedAt: report.generatedAt,
        framework: report.framework.key,
        watermark: options?.watermark || 'NONE',
        contentHash: dataHash,
    };

    const dataSources: DataSourceNote[] = [
        { source: 'Coverage & Readiness', description: `Requirement mapping + implementation verdict against ${requirementsPhrase}.` },
        { source: 'Control Mappings', description: 'Requirement-to-control mappings driving the mapped / unmapped split.' },
        { source: 'Implementation Status', description: 'Per-requirement implemented / gap rollup across its in-scope controls.' },
    ];

    // ─── Build PDF ───
    const doc = createPdfDocument(meta);
    addCoverPage(doc, meta);
    addMetadataPage(doc, meta, dataSources);
    doc.addPage();

    // Summary — the same populations the hub tiles show.
    addSectionTitle(doc, 'Analysis Summary');
    addSummaryMetrics(doc, [
        { label: 'Total Requirements', value: s.totalRequirements },
        { label: 'Unmapped', value: unmappedCount },
        { label: 'Mapped, not implemented', value: s.gapRequirements },
        { label: 'Excepted', value: s.exceptedRequirements },
        { label: 'Coverage', value: `${s.coveragePercent}%` },
    ]);

    addSpacer(doc);

    // THE SAME CLAIM AS THE AUDIT-READINESS PDF, AND IT MUST BE GATED THE SAME
    // WAY. `labels.noGapsParagraph` reads "...are fully mapped, justified, and
    // have associated evidence. The SoA is audit-ready." — an assertion about
    // EVIDENCE — while this branch tested only `totalGaps === 0`
    // (unmapped + gapRequirements). A tenant with every requirement mapped and
    // implemented and not one approved piece of evidence got it.
    //
    // Left unfixed, the two auditor-facing exports would have contradicted
    // each other for the same tenant on the same day, now that #2618 gates the
    // readiness PDF on evidence: one saying 51 controls lack evidence, the
    // other saying the SoA is audit-ready. `allImplemented` mirrors that PDF
    // exactly, including why gapRequirements === 0 is not enough — excepted
    // and not-applicable requirements increment neither counter.
    const allImplemented =
        s.totalRequirements > 0 && s.implementedRequirements === s.totalRequirements;
    if (totalGaps === 0 && allImplemented && s.missingEvidenceCount === 0) {
        addParagraph(doc, labels.noGapsParagraph);
    } else if (totalGaps === 0) {
        // No unmapped and nothing awaiting implementation, but the claim above
        // would still be false. Say which half is missing.
        const parts: string[] = [];
        if (!allImplemented) {
            parts.push(`${s.implementedRequirements} of ${s.totalRequirements} requirement(s) implemented`);
            if (s.exceptedRequirements > 0) parts.push(`${s.exceptedRequirements} risk-accepted under an exception`);
        }
        if (s.missingEvidenceCount > 0) parts.push(`${s.missingEvidenceCount} in-scope control(s) lack current evidence`);
        addParagraph(doc, `No unmapped or unimplemented requirements remain, but this is not yet audit-ready: ${parts.join('; ')}.`);
    } else {
        addParagraph(doc, `${totalGaps} gap(s) to close before audit: ${unmappedCount} requirement(s) with no mapping, and ${s.gapRequirements} mapped but not yet implemented.`);
    }

    addSpacer(doc);

    // Unmapped requirements — the "Gap analysis — N unmapped" card population.
    if (report.unmappedRequirements.length > 0) {
        addSectionTitle(doc, `Unmapped Requirements (${report.unmappedRequirements.length})`);
        const widths = autoColumnWidths([1.2, 4, 2]);
        const columns: TableColumn[] = [
            { key: 'code', header: 'Code', width: widths[0] },
            { key: 'title', header: 'Requirement', width: widths[1] },
            { key: 'section', header: 'Section', width: widths[2] },
        ];
        renderTable(doc, columns, [...report.unmappedRequirements]
            .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
            .map((r) => ({ code: r.code, title: r.title, section: r.section || '—' })));
    } else {
        addSectionTitle(doc, 'No Unmapped Requirements');
        addParagraph(doc, `Every ${requirementsPhrase} requirement is mapped to at least one control.`);
    }

    applyHeadersAndFooters(doc, meta);
    return doc;
}
