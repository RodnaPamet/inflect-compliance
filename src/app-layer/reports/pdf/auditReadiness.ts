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
        isIsoFamily: report.isIsoFamily,
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
    // "Audit-ready" must mean audit-ready. Requirement coverage alone does not
    // establish it: this branch used to fire on gaps=0 and unmapped=0 whatever
    // the evidence position, which on a large catalogue produced "Audit-ready —
    // readiness score 0/100. Every requirement is mapped and implemented." in
    // an auditor-facing document (#2618).
    //
    // EVIDENCE GATES THE WORD; OVERDUE WORK DOES NOT. Decided by the product
    // owner on 2026-09-19: a missing audit artifact is the thing an auditor
    // cannot proceed without, whereas an overdue task is a process signal about
    // work already identified. So an overdue task still costs readiness points
    // (see MAX_OVERDUE_PENALTY in framework/coverage.ts) and is still reported
    // in the sentence — it just does not withhold the verdict.
    // GATED ON IMPLEMENTATION, NOT ON THE ABSENCE OF GAPS. `gapRequirements
    // === 0` looks like "everything is implemented" and is not: the rollup at
    // framework/coverage.ts:398-406 buckets each requirement as implemented,
    // excepted, gap or not-applicable, and `excepted` and `not-applicable`
    // increment NEITHER counter. Ten requirements with three implemented and
    // seven risk-accepted therefore gave gaps=0, unmapped=0 and — with clean
    // evidence — printed "Audit-ready" over a score of 30. A framework with
    // ZERO requirements did the same at 0/100, which is the exact sentence
    // #2618 was filed to remove. Requiring implemented === total makes the
    // claim the sentence makes literally true, and `> 0` keeps an empty
    // catalogue from reading as complete (pre-merge review).
    const allImplemented =
        s.totalRequirements > 0 && s.implementedRequirements === s.totalRequirements;
    const requirementsComplete = allImplemented && report.coverage.unmapped === 0;

    // Overdue work never withholds the verdict, but it is never dropped from
    // the sentence either — appended in EVERY branch, because "does not
    // withhold" must not become "does not mention".
    const overdueNote = s.overdueTaskCount > 0 ? ` ${s.overdueTaskCount} task(s) are overdue.` : '';

    if (requirementsComplete && s.missingEvidenceCount === 0) {
        addParagraph(doc, `Audit-ready — readiness score ${s.readinessScore}/100. Every requirement is mapped and implemented, and every in-scope control carries current evidence.${overdueNote}`);
    } else if (requirementsComplete) {
        addParagraph(doc, `Readiness score ${s.readinessScore}/100. Every requirement is mapped and implemented, but ${s.missingEvidenceCount} in-scope control(s) lack current evidence.${overdueNote}`);
    } else {
        // The honest position, itemised. A requirement that is neither
        // implemented nor a gap is excepted or not applicable, and saying so
        // is the difference between "70 outstanding" and "70 decided".
        const parts = [`${s.implementedRequirements} of ${s.totalRequirements} requirement(s) implemented`];
        if (s.gapRequirements > 0) parts.push(`${s.gapRequirements} not yet implemented`);
        if (s.exceptedRequirements > 0) parts.push(`${s.exceptedRequirements} risk-accepted under an exception`);
        if (report.coverage.unmapped > 0) parts.push(`${report.coverage.unmapped} unmapped`);
        const evidenceNote =
            s.missingEvidenceCount > 0
                ? ` ${s.missingEvidenceCount} in-scope control(s) lack current evidence.`
                : '';
        addParagraph(doc, `Readiness score ${s.readinessScore}/100. ${parts.join('; ')}.${evidenceNote}${overdueNote}`);
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
