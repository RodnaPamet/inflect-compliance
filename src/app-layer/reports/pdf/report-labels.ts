/**
 * PR-H — framework-derived labels for the export artifacts.
 *
 * Every user-facing string in the Audit Readiness / Gap Analysis PDFs derives
 * from the RESOLVED framework, never an ISO literal. "Annex A" / "Statement of
 * Applicability" wording is gated behind the ISO family — a SOC 2 / NIS2 report
 * reads "Coverage & Readiness" / "Requirements" so the auditor deliverable
 * names its real framework.
 *
 * Pure + exported so it can be unit-tested directly (PDF text extraction is
 * environment-fragile; the label logic is not).
 */

export interface FrameworkLabelInput {
    /** Version-qualified display name, e.g. "ISO 27001:2022" or "SOC 2". */
    frameworkName: string;
    /** ISO-27001 family — gates the Annex-A / SoA wording. */
    hasStatementOfApplicability: boolean;
    /** Total requirement/control count for the "All N …" data-source note. */
    requirementCount: number;
}

export interface AuditReadinessLabels {
    reportSubtitle: string;
    /** Section heading — "Statement of Applicability" (ISO) or "Coverage & Readiness". */
    applicabilitySection: string;
    dataSourceDescription: string;
    /** The requirements/SoA table heading. */
    tableSectionTitle: string;
}

export function auditReadinessLabels(fw: FrameworkLabelInput): AuditReadinessLabels {
    const section = fw.hasStatementOfApplicability ? 'Statement of Applicability' : 'Coverage & Readiness';
    return {
        reportSubtitle: `${section} — ${fw.frameworkName}`,
        applicabilitySection: section,
        dataSourceDescription: fw.hasStatementOfApplicability
            ? `All ${fw.requirementCount} Annex A controls with mapping, applicability, and implementation status.`
            : `All ${fw.requirementCount} ${fw.frameworkName} requirements with mapping and implementation status.`,
        tableSectionTitle: fw.hasStatementOfApplicability ? 'Statement of Applicability' : 'Requirements',
    };
}

export interface GapAnalysisLabels {
    reportSubtitle: string;
    dataSourceDescription: string;
    /** Prose phrase for "requirements" — "<fw> Annex A requirements" (ISO) or "<fw> requirements". */
    requirementsPhrase: string;
    noGapsParagraph: string;
}

export function gapAnalysisLabels(
    fw: FrameworkLabelInput,
    gapCount: number,
): GapAnalysisLabels {
    const requirementsPhrase = fw.hasStatementOfApplicability
        ? `${fw.frameworkName} Annex A requirements`
        : `${fw.frameworkName} requirements`;
    return {
        reportSubtitle: `${fw.frameworkName} — ${gapCount} gaps identified`,
        dataSourceDescription: `Automated compliance gap detection against ${requirementsPhrase}.`,
        requirementsPhrase,
        noGapsParagraph: fw.hasStatementOfApplicability
            ? 'All Annex A requirements are fully mapped, justified, and have associated evidence. The SoA is audit-ready.'
            : `All ${fw.frameworkName} requirements are fully mapped and have associated evidence. Coverage is audit-ready.`,
    };
}
