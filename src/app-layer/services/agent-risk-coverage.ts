/**
 * Per-agent agentic-risk coverage — the pure classification layer.
 *
 * The question this answers is narrower than framework coverage and that
 * narrowness is the point: "for THIS registered agent, which of the ten OWASP
 * agentic risks does the tenant actually hold a control for?" A percentage
 * hides which risk is open, and the open one is the only part an assessor
 * cares about, so every readout carries four DISJOINT code lists as well as
 * the number.
 *
 * Three inputs decide a risk's status, and they are deliberately not
 * interchangeable:
 *
 *   • `scopedToAgent` — an `AiSystemRequirementLink` from the agent's required
 *     AI-system entry to this requirement. This is the ONLY per-agent signal
 *     in the model. Without it the readout would be identical for every agent
 *     in the tenant, which is a tenant readout wearing an agent's name.
 *   • `directControls` — tenant controls linked to the agentic requirement
 *     itself. Evidence that the risk is treated; not evidence it is treated
 *     for this agent.
 *   • `inheritedFrom` — tenant controls on a requirement in ANOTHER framework
 *     that cross-maps onto this risk. This is what makes an ISO 42001 or ISO
 *     27001 holder start above zero on day one instead of at zero.
 *
 * INHERITED COVERAGE IS CAPPED AT `PARTIALLY_COVERED`, even when the mapping
 * strength is EQUAL or SUPERSET and `determineGapStatus` would return COVERED.
 * A cross-framework mapping is Inflect's curated judgement that two
 * obligations overlap; it is not the tenant asserting that the control governs
 * this agent. Letting a curated EQUAL edge mark an agentic risk COVERED would
 * let the product claim, on the strength of its own mapping file, that a risk
 * nobody has looked at is handled. The cap is the whole reason the inherited
 * path is safe to ship.
 *
 * Status vocabulary is `GapStatus` from cross-framework-traceability, reused
 * verbatim rather than re-spelled, so the conservative semantics documented
 * for gap analysis (RELATED never counts as coverage) hold here too.
 */
import {
    determineGapStatus,
    strengthToConfidence,
    type GapStatus,
} from './cross-framework-traceability';
import {
    MAPPING_STRENGTH_RANK,
    type MappingStrengthValue,
} from '../domain/requirement-mapping.types';

/** A tenant control that stands behind a risk, directly or by inheritance. */
export interface CoveringControl {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly status: string;
}

/**
 * One cross-framework route into an agentic risk: a requirement the tenant
 * holds controls for, plus the curated strength of the mapping onto the risk.
 */
export interface InheritedCoverage {
    readonly frameworkKey: string;
    readonly frameworkName: string;
    readonly requirementCode: string;
    readonly requirementTitle: string;
    readonly strength: MappingStrengthValue;
    readonly controls: readonly CoveringControl[];
}

/** Everything known about one agentic risk before it is classified. */
export interface AgentRiskCoverageInput {
    readonly code: string;
    readonly title: string;
    readonly section: string | null;
    readonly scopedToAgent: boolean;
    readonly directControls: readonly CoveringControl[];
    readonly inheritedFrom: readonly InheritedCoverage[];
}

/** Why a risk is not COVERED — the single next action, not a diagnosis list. */
export type AgentRiskCoverageReason = 'NOT_SCOPED' | 'NO_CONTROL';

export interface AgentRiskCoverageEntry extends AgentRiskCoverageInput {
    readonly status: GapStatus;
    readonly reason: AgentRiskCoverageReason | null;
    /** Inherited routes that carry at least one control, strongest first. */
    readonly inheritedFrom: readonly InheritedCoverage[];
}

export interface AgentRiskCoverageSummary {
    readonly total: number;
    /** Scoped to the agent AND directly controlled. */
    readonly covered: readonly string[];
    /** Controlled, but not for this agent — or reached only by a mapping. */
    readonly partiallyCovered: readonly string[];
    /** Reached only by RELATED mappings: awareness, never a coverage claim. */
    readonly reviewNeeded: readonly string[];
    /** Nothing at all. The list an assessor reads first. */
    readonly uncovered: readonly string[];
    /** covered / total, rounded. Conservative: PARTIAL does not count. */
    readonly coveragePercent: number;
}

/** Strongest-first ordering over the four statuses. */
const STATUS_RANK: Record<GapStatus, number> = {
    COVERED: 3,
    PARTIALLY_COVERED: 2,
    REVIEW_NEEDED: 1,
    NOT_COVERED: 0,
};

/**
 * Classify one agentic risk for one agent.
 *
 * Inherited routes with no tenant control are DROPPED rather than reported
 * with an empty control list: `inheritedFrom` means inherited coverage, and a
 * mapping edge nobody implements is structure, not coverage. Reporting it
 * would put a populated-looking array beside a NOT_COVERED verdict.
 */
export function classifyAgentRiskCoverage(input: AgentRiskCoverageInput): AgentRiskCoverageEntry {
    const inherited = input.inheritedFrom
        .filter((i) => i.controls.length > 0)
        .sort(
            (a, b) =>
                MAPPING_STRENGTH_RANK[b.strength] - MAPPING_STRENGTH_RANK[a.strength] ||
                a.frameworkKey.localeCompare(b.frameworkKey) ||
                a.requirementCode.localeCompare(b.requirementCode),
        );

    const hasDirect = input.directControls.length > 0;

    // The strongest verdict any inherited route can justify, capped at
    // PARTIALLY_COVERED — see the module header for why the cap is the point.
    let inheritedStatus: GapStatus = 'NOT_COVERED';
    for (const route of inherited) {
        const raw = determineGapStatus(strengthToConfidence(route.strength));
        const capped: GapStatus = raw === 'COVERED' ? 'PARTIALLY_COVERED' : raw;
        if (STATUS_RANK[capped] > STATUS_RANK[inheritedStatus]) inheritedStatus = capped;
    }

    let status: GapStatus;
    if (input.scopedToAgent && hasDirect) status = 'COVERED';
    else if (hasDirect) status = 'PARTIALLY_COVERED';
    else status = inheritedStatus;

    const reason: AgentRiskCoverageReason | null =
        status === 'COVERED' ? null : input.scopedToAgent ? 'NO_CONTROL' : 'NOT_SCOPED';

    return { ...input, inheritedFrom: inherited, status, reason };
}

/**
 * Partition the classified risks into four disjoint code lists.
 *
 * The four lists always sum to `total`, and both suites assert that partition
 * explicitly rather than trusting it: a status added later without a bucket
 * here would silently vanish from every readout instead of failing loudly.
 */
export function summariseAgentRiskCoverage(
    entries: readonly AgentRiskCoverageEntry[],
): AgentRiskCoverageSummary {
    const pick = (s: GapStatus) => entries.filter((e) => e.status === s).map((e) => e.code);
    const covered = pick('COVERED');
    const total = entries.length;

    return {
        total,
        covered,
        partiallyCovered: pick('PARTIALLY_COVERED'),
        reviewNeeded: pick('REVIEW_NEEDED'),
        uncovered: pick('NOT_COVERED'),
        coveragePercent: total > 0 ? Math.round((covered.length / total) * 100) : 0,
    };
}
