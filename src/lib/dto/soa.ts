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
     * Whether the resolved framework mandates a Statement of Applicability —
     * a per-control record of applicability against a control ANNEX. ISO
     * 27001, ISO 27701 and ISO 42001 do; everything else this repo ships does
     * not. When false, the SoA view points the user at that framework's
     * coverage/readiness instead of rendering a mislabeled "SoA".
     *
     * NOT DERIVED FROM `Framework.kind` — that was the #2617 defect, and this
     * docblock described it for one revision after the code stopped doing it.
     * `kind` is wrong in both directions: ISO 9001/28000/39001 are
     * `ISO_STANDARD` with no control annex, and the value is the SCHEMA
     * DEFAULT, so an unclassified framework (SOC 2 via `seed-catalog.ts`, for
     * one) inherits it. The answer is declared per framework key in
     * {@link frameworkHasStatementOfApplicability}
     * (`lib/compliance/statement-of-applicability.ts`) and fails closed.
     */
    hasStatementOfApplicability: boolean;
    generatedAt: string;             // ISO 8601
    entries: SoAEntryDTO[];
    summary: SoASummaryDTO;
}
