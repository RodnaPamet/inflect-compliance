/**
 * Readiness recommendations and gap details as codes (#4728).
 *
 * The scorer used to return English sentences for both, built on the server,
 * so the readiness page could not translate them, and a framework without a
 * scoring profile of its own got a configuration note as its one
 * "recommendation" (`set tenant.readinessWeightsJson[…]`), which no customer
 * can act on. The scorer now returns codes; the page words them from
 * `audits.readiness.rec.*` / `audits.readiness.gap.*`, and the English below
 * is what the exports and API callers keep reading.
 *
 * The bands are the score's own (`readinessBand`), so a dimension's advice
 * and the colour it is painted cannot disagree.
 *
 * Client-safe: imports only the band definition.
 */
import { readinessBand } from './bands';

export const READINESS_RECOMMENDATION_CODES = [
    'COVERAGE_LOW',
    'COVERAGE_NEARLY',
    'IMPLEMENTATION_LOW',
    'EVIDENCE_LOW',
    'EVIDENCE_NEARLY',
    'OVERDUE_MANY',
    'OVERDUE_FEW',
    'ISSUES_MANY',
    'STRONG',
    'NIS2_COVERAGE_LOW',
    'NIS2_COVERAGE_NEARLY',
    'NIS2_EVIDENCE_LOW',
    'NIS2_POLICIES_LOW',
    'NIS2_POLICIES_PARTIAL',
    'NIS2_ISSUES_MANY',
    'NIS2_STRONG',
    'GENERIC_COVERAGE_LOW',
] as const;

export type ReadinessRecommendationCode = (typeof READINESS_RECOMMENDATION_CODES)[number];

export interface ReadinessRecommendation {
    code: ReadinessRecommendationCode;
    /** The number the advice names, for the codes that name one. */
    count?: number;
}

const RECOMMENDATION_EN: Record<ReadinessRecommendationCode, (count: number) => string> = {
    COVERAGE_LOW: () => 'Map more Annex A requirements to controls — coverage is below 50%',
    COVERAGE_NEARLY: () => 'Continue mapping requirements — aim for 80%+ coverage before audit',
    IMPLEMENTATION_LOW: () => 'Focus on implementing controls — many APPLICABLE controls are not yet IMPLEMENTED',
    EVIDENCE_LOW: () => 'Attach evidence to controls — auditors will expect documentation for each control',
    EVIDENCE_NEARLY: () => 'Strengthen evidence collection — aim for 80%+ controls with evidence',
    OVERDUE_MANY: (n) => `Address ${n} overdue tasks to improve audit readiness`,
    OVERDUE_FEW: (n) => `Close remaining ${n} overdue task(s)`,
    ISSUES_MANY: (n) => `Resolve ${n} open audit findings/control gaps before audit`,
    STRONG: () => 'Readiness is strong — review final pack before scheduling audit',
    NIS2_COVERAGE_LOW: () => 'Map NIS2 requirements (Art.21 measures) to controls — coverage below 50%',
    NIS2_COVERAGE_NEARLY: () => 'Continue mapping NIS2 requirements — aim for full Art.21 coverage',
    NIS2_EVIDENCE_LOW: () => 'Attach evidence to mapped controls — NIS2 requires demonstrable measures',
    NIS2_POLICIES_LOW: () => 'Link governing policies to your NIS2 controls — most in-scope controls have no policy attached',
    NIS2_POLICIES_PARTIAL: () => 'Attach policies to the remaining unlinked NIS2 controls to demonstrate governance',
    NIS2_ISSUES_MANY: (n) => `Address ${n} open issues to reduce compliance risk`,
    NIS2_STRONG: () => 'NIS2 readiness is strong — prepare for notification to competent authority',
    GENERIC_COVERAGE_LOW: () => 'Map more of the framework\'s requirements to controls — coverage is below 50%',
};

/** The English sentence the exports carry for a recommendation. */
export function recommendationEnglish(r: ReadinessRecommendation): string {
    return RECOMMENDATION_EN[r.code](r.count ?? 0);
}

export function iso27001Recommendations(coverage: number, impl: number, evidence: number, overdue: number, issues: number): ReadinessRecommendation[] {
    const recs: ReadinessRecommendation[] = [];
    if (readinessBand(coverage) === 'atRisk') recs.push({ code: 'COVERAGE_LOW' });
    else if (readinessBand(coverage) === 'nearly') recs.push({ code: 'COVERAGE_NEARLY' });
    if (impl < 60) recs.push({ code: 'IMPLEMENTATION_LOW' });
    if (readinessBand(evidence) === 'atRisk') recs.push({ code: 'EVIDENCE_LOW' });
    else if (readinessBand(evidence) === 'nearly') recs.push({ code: 'EVIDENCE_NEARLY' });
    if (overdue > 5) recs.push({ code: 'OVERDUE_MANY', count: overdue });
    else if (overdue > 0) recs.push({ code: 'OVERDUE_FEW', count: overdue });
    if (issues > 3) recs.push({ code: 'ISSUES_MANY', count: issues });
    if (recs.length === 0) recs.push({ code: 'STRONG' });
    return recs;
}

export function nis2Recommendations(coverage: number, evidence: number, policies: number, issues: number): ReadinessRecommendation[] {
    const recs: ReadinessRecommendation[] = [];
    if (readinessBand(coverage) === 'atRisk') recs.push({ code: 'NIS2_COVERAGE_LOW' });
    else if (readinessBand(coverage) === 'nearly') recs.push({ code: 'NIS2_COVERAGE_NEARLY' });
    if (readinessBand(evidence) === 'atRisk') recs.push({ code: 'NIS2_EVIDENCE_LOW' });
    if (readinessBand(policies) === 'atRisk') recs.push({ code: 'NIS2_POLICIES_LOW' });
    else if (policies < 100) recs.push({ code: 'NIS2_POLICIES_PARTIAL' });
    if (issues > 3) recs.push({ code: 'NIS2_ISSUES_MANY', count: issues });
    if (recs.length === 0) recs.push({ code: 'NIS2_STRONG' });
    return recs;
}

/**
 * A framework without a profile of its own is scored on coverage, evidence
 * and issues, so its advice covers those three. It used to be a single note
 * telling the reader to configure a scoring profile.
 */
export function genericRecommendations(coverage: number, evidence: number, issues: number): ReadinessRecommendation[] {
    const recs: ReadinessRecommendation[] = [];
    if (readinessBand(coverage) === 'atRisk') recs.push({ code: 'GENERIC_COVERAGE_LOW' });
    else if (readinessBand(coverage) === 'nearly') recs.push({ code: 'COVERAGE_NEARLY' });
    if (readinessBand(evidence) === 'atRisk') recs.push({ code: 'EVIDENCE_LOW' });
    else if (readinessBand(evidence) === 'nearly') recs.push({ code: 'EVIDENCE_NEARLY' });
    if (issues > 3) recs.push({ code: 'ISSUES_MANY', count: issues });
    if (recs.length === 0) recs.push({ code: 'STRONG' });
    return recs;
}

// ─── Gap details ───

/** What a gap is, as data the page words. */
export type ReadinessGapDetail =
    | { code: 'NOT_MAPPED' }
    | { code: 'NO_EVIDENCE' }
    | { code: 'NO_POLICY' }
    | { code: 'DUE'; dueAt: string | null }
    | { code: 'ISSUE'; severity: string | null; issueType?: string | null }
    | { code: 'OPEN_AUDIT_FINDINGS'; count: number };
