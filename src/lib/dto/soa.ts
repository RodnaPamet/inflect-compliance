/**
 * Statement of Applicability (SoA) DTOs
 *
 * Deterministic SoA "view" for ISO 27001:2022 Annex A.
 * Every Annex A requirement (5.1..8.34) appears once, even if unmapped.
 */

// ─── Per-Requirement Entry ───

export interface SoAMappedControlDTO {
    controlId: string;
    code: string | null;
    title: string;
    status: string;
    applicability: string;           // APPLICABLE | NOT_APPLICABLE
    justification: string | null;    // applicabilityJustification
    owner: string | null;            // ownerUser display name (never the id)
    frequency: string | null;        // ControlFrequency enum value
}

export interface SoAEntryDTO {
    requirementId: string;
    requirementCode: string;         // e.g. "A.5.1"
    requirementTitle: string;
    section: string | null;          // Organizational | People | Physical | Technological
    /** true=applicable, false=not applicable, null=unmapped/no decision */
    applicable: boolean | null;
    /** Required justification when applicable === false */
    justification: string | null;
    /** Worst-status rollup across mapped applicable controls */
    implementationStatus: string | null;
    /**
     * R2-P5 — the shared requirement verdict: 'implemented' | 'excepted' |
     * 'gap' (only set when applicable). 'excepted' = otherwise a gap, but
     * every gapping applicable control is covered by an in-force exception.
     */
    verdict: string | null;
    /** When verdict === 'excepted', the date the exception cover lapses. */
    exceptedUntil: string | null;
    mappedControls: SoAMappedControlDTO[];
    /** Rollup counts (populated when include* flags are set) */
    evidenceCount: number;
    openTaskCount: number;
    lastTestResult: string | null;   // PASS | FAIL | INCONCLUSIVE | null
}

// ─── Report Envelope ───

export interface SoASummaryDTO {
    total: number;
    applicable: number;
    notApplicable: number;
    unmapped: number;
    implemented: number;
    /** R2-P5 — requirements risk-accepted via an in-force exception. */
    excepted: number;
    missingJustification: number;
}

export interface SoAReportDTO {
    tenantId: string;
    tenantSlug: string;
    framework: string;               // framework key, e.g. "ISO27001"
    /** Human-readable framework name + version for headers, e.g.
     *  "ISO 27001:2022". Resolved from the installed framework so the
     *  report header isn't hard-coded to ISO 27001. */
    frameworkName: string;
    /**
     * R2-P3 — whether the resolved framework is ISO-family (kind ===
     * ISO_STANDARD). The Statement of Applicability is an ISO-27001-Annex-A
     * artifact (ISO 27001/27701/42001 have applicability statements; SOC 2,
     * NIST, PCI, CIS, DORA, NIS2, GDPR do NOT). When false, the SoA view
     * points the user at that framework's coverage/readiness instead of
     * rendering a mislabeled "SoA".
     */
    isIsoFamily: boolean;
    generatedAt: string;             // ISO 8601
    entries: SoAEntryDTO[];
    summary: SoASummaryDTO;
}
