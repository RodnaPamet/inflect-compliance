/**
 * Digital Sovereignty Posture — getting-started self-assessment bank.
 *
 * Six sovereignty dimensions × five questions = 30. Each question has FIVE
 * ordered options scoring 0 (none) → 4 (leading). Dimension score = mean of its
 * five answers; overall = mean of the six dimension scores (surfaced 0–4 and as
 * a 0–100 normalization). An EU-market posture lens distinct from the AI
 * assessment — jurisdiction, residency, identity, exit-readiness, regulatory
 * alignment, and sovereign AI.
 *
 * Regulatory content is CLAUSE-REFERENCED ONLY — short identifiers, never
 * ISO / EU-regulation prose. The six-dimension model derives from the
 * MIT-licensed Digital-Sovereignty-Assessment-Tool; the clause-cite discipline
 * is ours. This is a self-assessment aid, NOT legal advice.
 *
 * This module is PURE CONTENT — it imports nothing and calls no usecase. The
 * scorer (`@/lib/self-assessments/scoring`) and the suggestion→materialize path
 * (`usecases/self-assessment`) consume it.
 */

/**
 * One ordered answer option, scored 0 (none) → 4 (leading). Its label is UI
 * copy and lives in the message catalogues, not here:
 * `onboarding.sovereignty.questions.<questionId>.options.s<score>`.
 */
export interface SelfAssessmentOption {
    score: 0 | 1 | 2 | 3 | 4;
}

export interface SelfAssessmentQuestion {
    /**
     * Stable id, e.g. `ds-1-01`. Also the message key: the question's text is
     * `onboarding.sovereignty.questions.<id>.text` in `messages/<locale>.json`,
     * so English and Bulgarian are read from one place each.
     */
    id: string;
    /** Exactly five ordered options, scores 0..4. */
    options: SelfAssessmentOption[];
}

/**
 * A suggestion TEMPLATE — title + clause reference only, never regulatory
 * prose. Materialised (on explicit approval) into a real risk + control when a
 * dimension scores below the gap threshold.
 */
export interface SelfAssessmentSuggestion {
    riskTitle: string;
    controlName: string;
    /** Short clause identifier surfaced on the suggestion (e.g. "EUCS"). */
    clauseRef: string;
}

export interface SelfAssessmentDimension {
    id: number;
    /** i18n label key (resolved by the UI via next-intl) — never hard-coded. */
    labelKey: string;
    /** Short regulatory clause identifiers — cite, never copy. */
    clauseRefs: string[];
    /** Exactly five questions. */
    questions: SelfAssessmentQuestion[];
    /** The gap suggestion for this dimension (dimension score < threshold). */
    suggestion: SelfAssessmentSuggestion;
}

export interface SelfAssessment {
    /** Assessment key — a member of the assessment-key Zod enum. */
    key: string;
    version: number;
    dimensions: SelfAssessmentDimension[];
}

/** The five ordered options, scores 0..4 (labels are in the message catalogues). */
function opts(): SelfAssessmentOption[] {
    return ([0, 1, 2, 3, 4] as const).map((score) => ({ score }));
}

export const DIGITAL_SOVEREIGNTY_ASSESSMENT: SelfAssessment = {
    key: 'digital-sovereignty',
    version: 1,
    dimensions: [
        // ── Dimension 1 — Cloud Jurisdiction & Sovereign Cloud ──
        {
            id: 1,
            labelKey: 'cloudJurisdiction',
            clauseRefs: ['EUCS', 'Gaia-X', 'NIS2 Art 21'],
            suggestion: {
                riskTitle: 'Extraterritorial jurisdiction exposure on cloud workloads',
                controlName: 'Sovereign-cloud / HYOK evaluation for sensitive tiers',
                clauseRef: 'EUCS',
            },
            questions: [
                { id: 'ds-1-01', options: opts() },
                { id: 'ds-1-02', options: opts() },
                { id: 'ds-1-03', options: opts() },
                { id: 'ds-1-04', options: opts() },
                { id: 'ds-1-05', options: opts() },
            ],
        },
        // ── Dimension 2 — Data Residency & Transfer Mechanisms ──
        {
            id: 2,
            labelKey: 'dataResidency',
            clauseRefs: ['GDPR Ch. V', 'Data Governance Act', 'EU 2023/2854'],
            suggestion: {
                riskTitle: 'Unlawful or unassessed cross-border data transfer',
                controlName: 'Data-residency inventory + GDPR Ch. V transfer-mechanism review',
                clauseRef: 'GDPR Ch. V',
            },
            questions: [
                { id: 'ds-2-01', options: opts() },
                { id: 'ds-2-02', options: opts() },
                { id: 'ds-2-03', options: opts() },
                { id: 'ds-2-04', options: opts() },
                { id: 'ds-2-05', options: opts() },
            ],
        },
        // ── Dimension 3 — Identity & Sovereignty of Access ──
        {
            id: 3,
            labelKey: 'identitySovereignty',
            clauseRefs: ['eIDAS 2.0', 'NIS2 Art 21(2)(i)'],
            suggestion: {
                riskTitle: 'Foreign-controlled identity-provider dependency',
                controlName: 'EU-jurisdiction IdP + eIDAS 2.0 readiness assessment',
                clauseRef: 'eIDAS 2.0',
            },
            questions: [
                { id: 'ds-3-01', options: opts() },
                { id: 'ds-3-02', options: opts() },
                { id: 'ds-3-03', options: opts() },
                { id: 'ds-3-04', options: opts() },
                { id: 'ds-3-05', options: opts() },
            ],
        },
        // ── Dimension 4 — Infrastructure Dependency & Exit-Readiness ──
        {
            id: 4,
            labelKey: 'infraExitReadiness',
            clauseRefs: ['DORA Art 28', 'NIS2 supply-chain', 'Data Act switching'],
            suggestion: {
                riskTitle: 'Critical third-party lock-in without a tested exit plan',
                controlName: 'Documented, RTO-bounded exit plan + concentration register',
                clauseRef: 'DORA Art 28',
            },
            questions: [
                { id: 'ds-4-01', options: opts() },
                { id: 'ds-4-02', options: opts() },
                { id: 'ds-4-03', options: opts() },
                { id: 'ds-4-04', options: opts() },
                { id: 'ds-4-05', options: opts() },
            ],
        },
        // ── Dimension 5 — Regulatory Alignment & Certification ──
        {
            id: 5,
            labelKey: 'regulatoryAlignment',
            clauseRefs: ['NIS2', 'CRA', 'EUCS', 'AI Act', 'DORA'],
            suggestion: {
                riskTitle: 'Unmapped EU digital-regulation obligations',
                controlName: 'EU digital-regulation applicability + certification roadmap',
                clauseRef: 'NIS2',
            },
            questions: [
                { id: 'ds-5-01', options: opts() },
                { id: 'ds-5-02', options: opts() },
                { id: 'ds-5-03', options: opts() },
                { id: 'ds-5-04', options: opts() },
                { id: 'ds-5-05', options: opts() },
            ],
        },
        // ── Dimension 6 — Sovereign AI ──
        {
            id: 6,
            labelKey: 'sovereignAi',
            clauseRefs: ['AI Act EU 2024/1689', 'Data Act'],
            suggestion: {
                riskTitle: 'Non-EU AI provider dependency for sensitive processing',
                controlName: 'EU / open-weight model evaluation + AI Act tiering',
                clauseRef: 'AI Act EU 2024/1689',
            },
            questions: [
                { id: 'ds-6-01', options: opts() },
                { id: 'ds-6-02', options: opts() },
                { id: 'ds-6-03', options: opts() },
                { id: 'ds-6-04', options: opts() },
                { id: 'ds-6-05', options: opts() },
            ],
        },
    ],
};

/**
 * Maturity bands — a LABEL only, no legal-compliance claim. `key` is the
 * message key the UI renders (`onboarding.sovereignty.bands.<key>`); the
 * scorer returns the key, never English text.
 */
export const SOVEREIGNTY_MATURITY_BANDS = [
    { max: 1, key: 'exposed' },
    { max: 2, key: 'emerging' },
    { max: 3, key: 'managed' },
    { max: 4.0001, key: 'sovereignReady' },
] as const;

export type SovereigntyBandKey = (typeof SOVEREIGNTY_MATURITY_BANDS)[number]['key'];

/** A dimension scoring below this yields a suggested risk + control. */
export const SOVEREIGNTY_GAP_THRESHOLD = 2;
