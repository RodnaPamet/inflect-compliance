/**
 * Audit Readiness PDF Generator
 *
 * PR-U — computed off the SAME readiness spine (`generateReadinessReport`) the
 * on-screen readiness view uses, so the exported headline numbers (coverage %,
 * readiness score, implemented / gap / excepted, per-section breakdown) MATCH
 * what the user saw for the selected framework. The old SoA engine
 * (getSoA + runSoAChecks) — with its ISO Annex-A Applicability/Justification
 * columns and "SoA is audit-ready" verdict — is gone; the SoA remains a separate
 * ISO-only artifact (/reports/soa + the SoA CSV export). Non-ISO exports carry
 * zero SoA/Applicability/Justification constructs as a result.
 *
 *   Cover page → Metadata page → Summary metrics → Coverage by section → Unmapped
 */
import crypto from 'crypto';
import type { RequestContext } from '@/app-layer/types';
import { generateReadinessReport } from '@/app-layer/usecases/framework/coverage';
import { resolveInstalledFrameworkKey } from '@/app-layer/usecases/soa';
import { auditReadinessLabels } from './report-labels';
import { createPdfDocument } from '@/lib/pdf/pdfKitFactory';
import { addCoverPage, addMetadataPage, applyHeadersAndFooters } from '@/lib/pdf/layout';
import { renderTable, autoColumnWidths } from '@/lib/pdf/table';
import { addSectionTitle, addSummaryMetrics, addSpacer, addParagraph } from '@/lib/pdf/sections';
import type { ReportMeta, TableColumn, WatermarkMode, DataSourceNote } from '@/lib/pdf/types';
import prisma from '@/lib/prisma';

export async function generateAuditReadinessPdf(
    ctx: RequestContext,
    options?: { framework?: string; watermark?: WatermarkMode },
): Promise<PDFKit.PDFDocument> {
    // ─── Fetch data — the readiness spine (same payload the view renders) ───
    const frameworkKey = options?.framework && options.framework.length > 0
        ? options.framework
        : await resolveInstalledFrameworkKey(ctx);
    const report = await generateReadinessReport(ctx, frameworkKey);
    const s = report.summary;

    const tenant = await prisma.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { name: true },
    });

    // ─── Content hash for auditability ───
    const dataHash = crypto.createHash('sha256')
        .update(JSON.stringify({ framework: report.framework.key, summary: s, sections: report.bySection.length }))
        .digest('hex');

    const frameworkName = report.framework.version
        ? `${report.framework.name} ${report.framework.version}`
        : report.framework.name;

    // ─── Framework-derived labels (PR-H) — SoA/Annex-A wording is gated behind
    // the ISO family, so a SOC 2 / NIS2 report never leaks an ISO literal. ───
    const labels = auditReadinessLabels({
        frameworkName,
        hasStatementOfApplicability: report.hasStatementOfApplicability,
        requirementCount: s.totalRequirements,
    });

    // ─── Meta ───
    const meta: ReportMeta = {
        tenantName: tenant?.name || 'Tenant',
        reportTitle: 'Audit Readiness Report',
        reportSubtitle: labels.reportSubtitle,
        generatedAt: report.generatedAt,
        framework: report.framework.key,
        watermark: options?.watermark || 'NONE',
        contentHash: dataHash,
    };

    const dataSources: DataSourceNote[] = [
        { source: labels.applicabilitySection, description: labels.dataSourceDescription },
        { source: 'Implementation Verdict', description: 'Per-requirement implemented / gap / excepted rollup across its applicable mapped controls.' },
        { source: 'Control Evidence', description: 'Evidence counts and overdue-task signals feeding the readiness score.' },
    ];

    // ─── Build PDF ───
    const doc = createPdfDocument(meta);
    addCoverPage(doc, meta);
    addMetadataPage(doc, meta, dataSources);
    doc.addPage();

    // Summary metrics — readiness spine numbers (match the on-screen view).
    addSectionTitle(doc, 'Summary');
    addSummaryMetrics(doc, [
        { label: 'Total Requirements', value: s.totalRequirements },
        { label: 'Mapped', value: s.mappedRequirements },
        { label: 'Coverage', value: `${s.coveragePercent}%` },
        { label: 'Implemented', value: s.implementedRequirements },
        { label: 'Gaps', value: s.gapRequirements },
        { label: 'Excepted', value: s.exceptedRequirements },
        { label: 'Readiness', value: `${s.readinessScore}/100` },
    ]);

    addSpacer(doc);

    // Readiness status — a readiness verdict, NOT an ISO "SoA is audit-ready" line.
    addSectionTitle(doc, 'Readiness Status');
    if (s.gapRequirements === 0 && report.coverage.unmapped === 0) {
        addParagraph(doc, `Audit-ready — readiness score ${s.readinessScore}/100. Every requirement is mapped and implemented.`);
    } else {
        addParagraph(doc, `Readiness score ${s.readinessScore}/100. ${s.gapRequirements} mapped requirement(s) not yet implemented; ${report.coverage.unmapped} unmapped.`);
    }

    addSpacer(doc);

    // Coverage by section — the same per-section breakdown the hub shows.
    addSectionTitle(doc, 'Coverage by Section');
    const secWidths = autoColumnWidths([3, 1, 1, 1.2]);
    const secColumns: TableColumn[] = [
        { key: 'section', header: 'Section', width: secWidths[0] },
        { key: 'total', header: 'Requirements', width: secWidths[1], align: 'center' },
        { key: 'mapped', header: 'Mapped', width: secWidths[2], align: 'center' },
        { key: 'coverage', header: 'Coverage', width: secWidths[3], align: 'center' },
    ];
    const sectionRows = [...report.bySection]
        .sort((a, b) => a.section.localeCompare(b.section))
        .map((sec) => ({
            section: sec.section,
            total: String(sec.total),
            mapped: String(sec.mapped),
            coverage: `${sec.coveragePercent}%`,
        }));
    renderTable(doc, secColumns, sectionRows, undefined, {
        values: { section: 'TOTAL', total: String(s.totalRequirements), mapped: String(s.mappedRequirements), coverage: `${s.coveragePercent}%` },
    });

    // Unmapped requirements — the readiness view's gap population (matches the
    // hub "Gap analysis — N unmapped" card exactly).
    if (report.unmappedRequirements.length > 0) {
        addSpacer(doc, 24);
        addSectionTitle(doc, `Unmapped Requirements (${report.unmappedRequirements.length})`);
        const gapWidths = autoColumnWidths([1.2, 4, 2]);
        const gapColumns: TableColumn[] = [
            { key: 'code', header: 'Code', width: gapWidths[0] },
            { key: 'title', header: 'Requirement', width: gapWidths[1] },
            { key: 'section', header: 'Section', width: gapWidths[2] },
        ];
        const gapRows = [...report.unmappedRequirements]
            .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
            .map((r) => ({ code: r.code, title: r.title, section: r.section || '—' }));
        renderTable(doc, gapColumns, gapRows);
    }

    applyHeadersAndFooters(doc, meta);
    // NOTE: doc.end() is NOT called here — the route calls it after attaching listeners
    return doc;
}
