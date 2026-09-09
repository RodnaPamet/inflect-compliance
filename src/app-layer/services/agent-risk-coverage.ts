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
 *   • `applicability` — derived from the agent's own declared exposure profile
 *     by `agent-risk-applicability.ts`. This is the per-agent signal, and the
 *     constraint it exists to satisfy is unchanged: without a term that can
 *     differ between two agents, the readout is identical for every agent in
 *     the tenant, which is a tenant readout wearing an agent's name. It is a
 *     DERIVATION from the register's mandatory columns, not an operator's
 *     applicability decision — the product has no surface for the latter.
 *     Contrast `Control.applicability`, which the same product records with a
 *     justification, a decider and a timestamp; nobody signs this one, and a
 *     NOT_APPLICABLE here is exactly as durable as the column it reads.
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
 * for gap analysis (RELATED never counts as coverage) hold here too, widened
 * LOCALLY to `AgentRiskStatus` for the N/A case. `GapStatus` itself is NOT
 * widened: it is shared with cross-framework-traceability and its four-value
 * semantics are load-bearing there.
 *
 * WHAT COVERED MEANS, SAID PLAINLY BECAUSE THE WORD OVER-PROMISES. COVERED is
 * "this risk applies to this agent, and the tenant holds a control linked
 * directly to it". It does NOT mean the control demonstrably governs this
 * agent: the model has no per-agent control attachment — `ControlRequirementLink`
 * is tenant-wide — so applicability × tenant control is the strongest claim
 * available. Read 80% as "eight of the ten agentic risks that apply to this
 * agent have a control behind them somewhere in this workspace", never as
 * "eight controls were tested against this agent".
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
import type {
    AgentRiskApplicability,
    ApplicabilityBasis,
} from './agent-risk-applicability';

/** A tenant control that stands behind a risk, directly or by inheritance. */
export interface CoveringControl {
    readonly id: string;
    /**
     * The control's short code, which is genuinely OPTIONAL — `Control.code` is
     * `String?` (controls.prisma:18) and a tenant-authored control need not have
     * one. Carried as `null` rather than coerced to `''` so a reader cannot
     * mistake "no code" for a control whose code is the empty string, and so an
     * assessor-facing readout can fall back to the name instead of rendering a
     * blank cell where an identifier is expected.
     */
    readonly code: string | null;
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
    /** Derived from the register — see `agent-risk-applicability.ts`. */
    readonly applicability: AgentRiskApplicability;
    /**
     * An `AiSystemRequirementLink` naming this requirement. INFORMATIONAL here
     * and never a gate: the query layer honours it as an operator override by
     * forcing `applicability` true before classification, so by the time a row
     * reaches this function the decision is already folded in. Carried through
     * so the UI can say a human also recorded the scope.
     */
    readonly explicitlyScoped: boolean;
    readonly directControls: readonly CoveringControl[];
    readonly inheritedFrom: readonly InheritedCoverage[];
}

/**
 * Why a risk is not COVERED — the single next action, not a diagnosis list.
 *
 * `NOT_SCOPED` is RETIRED. Under a derived rule there is no "applicable but
 * unscoped" state: either the risk applies, in which case the only thing that
 * can be missing is a control, or it does not, which is its own status.
 */
export type AgentRiskCoverageReason = 'NO_CONTROL' | 'NOT_APPLICABLE';

/**
 * `GapStatus` plus the one value gap analysis has no use for. Widened HERE and
 * not in `cross-framework-traceability`: a framework requirement is never "not
 * applicable to a framework", and adding a fifth value there would reach every
 * consumer of `determineGapStatus`.
 */
export type AgentRiskStatus = GapStatus | 'NOT_APPLICABLE';

export interface AgentRiskCoverageEntry extends AgentRiskCoverageInput {
    readonly status: AgentRiskStatus;
    readonly reason: AgentRiskCoverageReason | null;
    /** The register column that puts this risk out of scope; null when it applies. */
    readonly applicabilityBasis: ApplicabilityBasis | null;
    /** Inherited routes that carry at least one control, strongest first. */
    readonly inheritedFrom: readonly InheritedCoverage[];
}

export interface AgentRiskCoverageSummary {
    /** Every risk the framework carries. NOT the coverage denominator. */
    readonly total: number;
    /**
     * The denominator. `total` minus the risks the register puts out of scope
     * for THIS agent, which is what makes the percentage a statement about the
     * agent rather than about the catalogue.
     */
    readonly applicableTotal: number;
    /** Applicable AND directly controlled. */
    readonly covered: readonly string[];
    /** Reached only by a cross-framework mapping — never a full coverage claim. */
    readonly partiallyCovered: readonly string[];
    /** Reached only by RELATED mappings: awareness, never a coverage claim. */
    readonly reviewNeeded: readonly string[];
    /** Applicable, and nothing at all behind it. The list an assessor reads first. */
    readonly uncovered: readonly string[];
    /** The register says this agent lacks the capability the risk names. */
    readonly notApplicable: readonly string[];
    /** covered / applicableTotal, rounded. Conservative: PARTIAL does not count. */
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

    // The short-circuit sits AFTER the sorting and dropping above, not before
    // it: which routes carry controls is a fact either way, and an N/A entry
    // that still names the tenant's ISO 42001 control is the thing that lets a
    // reader argue with the applicability call instead of taking it on trust.
    if (!input.applicability.applicable) {
        return {
            ...input,
            inheritedFrom: inherited,
            status: 'NOT_APPLICABLE',
            reason: 'NOT_APPLICABLE',
            applicabilityBasis: input.applicability.basis,
        };
    }

    let status: AgentRiskStatus;
    if (hasDirect) status = 'COVERED';
    else status = inheritedStatus;

    const reason: AgentRiskCoverageReason | null = status === 'COVERED' ? null : 'NO_CONTROL';

    return { ...input, inheritedFrom: inherited, status, reason, applicabilityBasis: null };
}

/**
 * Partition the classified risks into five disjoint code lists.
 *
 * The five lists always sum to `total`, and both suites assert that partition
 * explicitly rather than trusting it: a status added later without a bucket
 * here would silently vanish from every readout instead of failing loudly.
 *
 * The PERCENTAGE is over `applicableTotal`, not `total`. Measuring against the
 * catalogue would count risks this tool has just declared do not apply, which
 * is the arithmetic that makes "the percentage means something" false — and it
 * is why the scoped denominator ships with the applicability rule rather than
 * after it.
 */
export function summariseAgentRiskCoverage(
    entries: readonly AgentRiskCoverageEntry[],
): AgentRiskCoverageSummary {
    const pick = (s: AgentRiskStatus) => entries.filter((e) => e.status === s).map((e) => e.code);
    const covered = pick('COVERED');
    const notApplicable = pick('NOT_APPLICABLE');
    const total = entries.length;
    const applicableTotal = total - notApplicable.length;

    return {
        total,
        applicableTotal,
        covered,
        partiallyCovered: pick('PARTIALLY_COVERED'),
        reviewNeeded: pick('REVIEW_NEEDED'),
        uncovered: pick('NOT_COVERED'),
        notApplicable,
        // Zero rather than NaN when nothing applies — an agent every risk is
        // N/A for has not been found to cover none of them.
        coveragePercent:
            applicableTotal > 0 ? Math.round((covered.length / applicableTotal) * 100) : 0,
    };
}
