/**
 * Cross-Framework Traceability & Gap Analysis Service
 *
 * Applies conservative business semantics on top of the raw mapping
 * resolution engine to answer product-level questions:
 *
 * 1. TRACEABILITY — "If I'm compliant with requirement X in framework A,
 *                   what does that imply for framework B?"
 *
 * 2. GAP ANALYSIS — "Given my compliance posture in framework A,
 *                   which requirements in framework B still need attention?"
 *
 * Key design principle: Mappings support traceability and partial reasoning,
 * NOT automatic compliance. This service carefully distinguishes between:
 *   - Strong traceability (EQUAL)       → requirement fully satisfied
 *   - Partial coverage (SUPERSET)       → target likely satisfied, verify scope
 *   - Partial coverage (SUBSET)         → gap remains, source doesn't fully cover target
 *   - Overlap (INTERSECT)               → shared ground, explicit review needed
 *   - Informational (RELATED)           → awareness only, no coverage claim
 *
 * This service does NOT interact with the database directly. It consumes
 * the MappingTraceResult from the resolution engine and applies business
 * interpretation logic. DB-backed usecases wrap this service.
 */

import {
    type MappingStrengthValue,
} from '../domain/requirement-mapping.types';
import type {
    MappingTraceResult,
    MappingPath,
    MappingEdgeLoader,
    TraceabilityQuery,
} from './mapping-resolution';
import { resolveMapping, resolveMappingBatch } from './mapping-resolution';
import {
    canonicalRequirementCode,
    frameworkFamilyId,
} from '../domain/framework-representation';

// ─── Coverage Confidence ─────────────────────────────────────────────

/**
 * Conservative coverage confidence levels derived from mapping strength.
 *
 * These replace raw strength values with product-meaningful interpretations
 * that prevent overclaiming compliance.
 */
export type CoverageConfidence =
    | 'FULL'         // EQUAL: requirement is semantically equivalent
    | 'HIGH'         // SUPERSET: source fully covers target, but verify scope
    | 'PARTIAL'      // SUBSET: source only partially covers target
    | 'OVERLAP'      // INTERSECT: shared ground but neither covers the other
    | 'INFORMATIONAL' // RELATED: conceptually related, no coverage claim
    | 'NONE';        // No mapping exists

/**
 * Map a mapping strength to a conservative coverage confidence level.
 *
 * Business rules:
 * - EQUAL → FULL:          Both requirements express the same obligation.
 *                          Implementing source fully satisfies target.
 * - SUPERSET → HIGH:       Source is broader than target.
 *                          Implementing source likely satisfies target,
 *                          but scope should be verified.
 * - SUBSET → PARTIAL:      Source is narrower than target.
 *                          Implementing source only partially satisfies target.
 *                          Gap remains.
 * - INTERSECT → OVERLAP:   Partial overlap. Neither fully covers the other.
 *                          Explicit review by compliance team needed.
 * - RELATED → INFORMATIONAL: Conceptually related but no direct coverage
 *                          claim can be made. For awareness only.
 */
export function strengthToConfidence(strength: MappingStrengthValue): CoverageConfidence {
    switch (strength) {
        case 'EQUAL':     return 'FULL';
        case 'SUPERSET':  return 'HIGH';
        case 'SUBSET':    return 'PARTIAL';
        case 'INTERSECT': return 'OVERLAP';
        case 'RELATED':   return 'INFORMATIONAL';
        default:          return 'NONE';
    }
}

/**
 * Numeric ranking for coverage confidence (for sorting/filtering).
 * Higher = more confidence.
 */
export const CONFIDENCE_RANK: Record<CoverageConfidence, number> = {
    FULL: 5,
    HIGH: 4,
    PARTIAL: 3,
    OVERLAP: 2,
    INFORMATIONAL: 1,
    NONE: 0,
};

/**
 * Whether a coverage confidence level represents actionable coverage
 * (i.e., some degree of actual compliance contribution, not just awareness).
 *
 * FULL and HIGH = "covered" (strong/likely)
 * PARTIAL and OVERLAP = "partially covered" (work remains)
 * INFORMATIONAL and NONE = "not covered" (no claim)
 */
export function isActionableCoverage(confidence: CoverageConfidence): boolean {
    return confidence === 'FULL' || confidence === 'HIGH';
}

/**
 * Whether a confidence level represents any form of partial or better coverage.
 * Used for "soft" gap analysis that counts partial coverage.
 */
export function hasAnyCoverage(confidence: CoverageConfidence): boolean {
    return confidence !== 'NONE' && confidence !== 'INFORMATIONAL';
}

// ─── Traceability Result Types ───────────────────────────────────────

/** Human-readable explanation of a mapping relationship. */
export interface TraceabilityExplanation {
    /** Short summary, e.g. "Fully equivalent" or "Partial overlap — review needed" */
    readonly summary: string;
    /** Detailed explanation with rationale chain */
    readonly detail: string;
    /** Whether the customer should take action */
    readonly actionRequired: boolean;
    /** Suggested action if any */
    readonly suggestedAction: string | null;
}

/**
 * A single traceability finding — one source requirement mapped to one
 * target requirement with business-interpreted semantics.
 */
export interface TraceabilityFinding {
    /** Source requirement */
    readonly source: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
    /** Target requirement */
    readonly target: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
    /** Raw mapping strength (from resolution engine) */
    readonly mappingStrength: MappingStrengthValue;
    /** Conservative coverage confidence (business interpretation) */
    readonly confidence: CoverageConfidence;
    /** Numeric confidence rank */
    readonly confidenceRank: number;
    /** Whether this represents actionable coverage (FULL or HIGH) */
    readonly isActionable: boolean;
    /** Whether this is a direct or transitive mapping */
    readonly isDirect: boolean;
    /** Traversal depth */
    readonly depth: number;
    /** Human-readable explanation */
    readonly explanation: TraceabilityExplanation;
    /** Full edge chain for auditability */
    readonly edgeChain: readonly {
        readonly fromCode: string;
        readonly fromFramework: string;
        readonly toCode: string;
        readonly toFramework: string;
        readonly strength: MappingStrengthValue;
        readonly rationale: string | null;
    }[];
}

/**
 * Complete traceability report for a source requirement against a
 * target framework.
 */
export interface TraceabilityReport {
    /** Source requirement being analyzed */
    readonly source: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
    /** Target framework key */
    readonly targetFrameworkKey: string;
    /** All findings, ordered by confidence (highest first) */
    readonly findings: readonly TraceabilityFinding[];
    /** Summary statistics */
    readonly summary: {
        readonly totalFindings: number;
        readonly fullCoverage: number;
        readonly highCoverage: number;
        readonly partialCoverage: number;
        readonly overlapCoverage: number;
        readonly informationalOnly: number;
        /** Best coverage confidence found across all findings */
        readonly bestConfidence: CoverageConfidence;
    };
}

// ─── Gap Analysis Types ──────────────────────────────────────────────

/**
 * Gap status for a single target requirement.
 */
export type GapStatus =
    | 'COVERED'           // FULL or HIGH confidence coverage exists
    | 'PARTIALLY_COVERED' // PARTIAL or OVERLAP coverage exists
    | 'NOT_COVERED'       // No applicable mapping or INFORMATIONAL only
    | 'REVIEW_NEEDED';    // Has mappings but they require manual review

/**
 * A single gap analysis entry for one target requirement.
 */
export interface GapAnalysisEntry {
    /** Target requirement that may or may not be covered */
    readonly targetRequirement: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly requirementTitle: string;
        readonly frameworkKey: string;
        readonly frameworkName: string;
    };
    /** Gap status determination */
    readonly status: GapStatus;
    /** Best coverage confidence from any source requirement */
    readonly bestConfidence: CoverageConfidence;
    /** Number of source requirements that map to this target */
    readonly sourceCount: number;
    /** The best-coverage source requirement (if any) */
    readonly bestSource: {
        readonly requirementId: string;
        readonly requirementCode: string;
        readonly frameworkKey: string;
        readonly strength: MappingStrengthValue;
        readonly confidence: CoverageConfidence;
        readonly isDirect: boolean;
    } | null;
    /** Human-readable explanation */
    readonly explanation: string;
}

/**
 * Complete gap analysis result comparing source framework coverage
 * against a target framework.
 */
export interface GapAnalysisResult {
    /** Source framework */
    readonly sourceFramework: string;
    /** Target framework */
    readonly targetFramework: string;
    /** All target requirements with gap status */
    readonly entries: readonly GapAnalysisEntry[];
    /** Summary statistics */
    readonly summary: {
        readonly totalTargetRequirements: number;
        readonly covered: number;
        readonly partiallyCovered: number;
        readonly notCovered: number;
        readonly reviewNeeded: number;
        /** Overall coverage percentage (COVERED as percent of total) */
        readonly coveragePercent: number;
        /** Coverage including partial (COVERED + PARTIALLY_COVERED) */
        readonly inclusiveCoveragePercent: number;
    };
}

// ─── Tenant Control-Implementation Overlay ───────────────────────────
//
// Audit Coherence S9 (2026-05-24).
//
// Mapping rows are global reference data (NIST → SOC2 mappings are
// the same for every tenant). But the gap report is only useful
// when the auditor can see WHICH tenant controls already implement
// the target requirements. Pre-S9, that join had to happen on the
// frontend by re-querying ControlRequirementLink — and most pages
// just didn't bother.
//
// `enrichWithTenantImplementations` accepts a gap-analysis result
// + a snapshot of the tenant's ControlRequirementLink rows for the
// target framework and returns the same result with each entry
// carrying an `implementingControls` array. Pure function; the
// caller owns the DB query.

/** A tenant control that implements a specific target requirement. */
export interface TenantControlImplementation {
    readonly controlId: string;
    readonly controlCode: string;
    readonly controlName: string;
    readonly controlStatus: string;
    readonly requirementId: string;
}

/** A gap-analysis entry annotated with the tenant's implementing controls. */
export interface GapAnalysisEntryWithImplementations
    extends GapAnalysisEntry {
    readonly implementingControls: readonly TenantControlImplementation[];
}

/** A gap-analysis result annotated with the tenant's implementing controls. */
export interface GapAnalysisResultWithImplementations
    extends Omit<GapAnalysisResult, 'entries'> {
    readonly entries: readonly GapAnalysisEntryWithImplementations[];
}

/**
 * Annotate every gap-analysis entry with the tenant's controls
 * that already implement the target requirement (via
 * ControlRequirementLink rows).
 *
 * Pure function: the caller queries the link table — typically via
 * `db.controlRequirementLink.findMany({ where: { tenantId, requirement: { frameworkKey } } })`
 * — and passes the result here.
 */
export function enrichWithTenantImplementations(
    result: GapAnalysisResult,
    implementations: ReadonlyArray<TenantControlImplementation>,
): GapAnalysisResultWithImplementations {
    const byReq = new Map<string, TenantControlImplementation[]>();
    for (const impl of implementations) {
        const list = byReq.get(impl.requirementId);
        if (list) list.push(impl);
        else byReq.set(impl.requirementId, [impl]);
    }

    return {
        ...result,
        entries: result.entries.map((e) => ({
            ...e,
            implementingControls:
                byReq.get(e.targetRequirement.requirementId) ?? [],
        })),
    };
}

// ─── Explanation Generator ───────────────────────────────────────────

/**
 * Generate a human-readable explanation for a mapping path.
 */
export function generateExplanation(path: MappingPath): TraceabilityExplanation {
    const strength = path.effectiveStrength;
    const confidence = strengthToConfidence(strength);
    const isTransitive = !path.isDirect;
    const depth = path.depth;

    const transitiveNote = isTransitive
        ? ` (via ${depth}-hop transitive mapping)`
        : '';

    switch (confidence) {
        case 'FULL':
            return {
                summary: `Fully equivalent${transitiveNote}`,
                detail: `These requirements express the same obligation. ` +
                    `Implementing the source requirement fully satisfies the target.${transitiveNote}`,
                actionRequired: false,
                suggestedAction: null,
            };
        case 'HIGH':
            return {
                summary: `Strong coverage — verify scope${transitiveNote}`,
                detail: `The source requirement is broader than the target. ` +
                    `Implementing the source likely satisfies the target, ` +
                    `but the scope should be verified.${transitiveNote}`,
                actionRequired: true,
                suggestedAction: 'Verify that the source requirement scope fully covers the target context.',
            };
        case 'PARTIAL':
            return {
                summary: `Partial coverage — gap remains${transitiveNote}`,
                detail: `The source requirement is narrower than the target. ` +
                    `Implementing the source only partially satisfies the target. ` +
                    `Additional controls or evidence may be needed.${transitiveNote}`,
                actionRequired: true,
                suggestedAction: 'Identify and address the gaps not covered by the source requirement.',
            };
        case 'OVERLAP':
            return {
                summary: `Overlap — explicit review needed${transitiveNote}`,
                detail: `The source and target requirements share common ground ` +
                    `but neither fully covers the other. ` +
                    `A compliance team review is recommended.${transitiveNote}`,
                actionRequired: true,
                suggestedAction: 'Review the overlapping areas and identify any uncovered obligations.',
            };
        case 'INFORMATIONAL':
            return {
                summary: `Informational relationship only${transitiveNote}`,
                detail: `The source and target requirements are conceptually related ` +
                    `but no direct coverage claim can be made. ` +
                    `This relationship is for awareness and planning purposes.${transitiveNote}`,
                actionRequired: false,
                suggestedAction: null,
            };
        default:
            return {
                summary: 'No relationship',
                detail: 'No mapping exists between these requirements.',
                actionRequired: false,
                suggestedAction: null,
            };
    }
}

// ─── Framework Identity ──────────────────────────────────────────────
//
// Every framework in this repo can exist TWICE in `Framework` — the row
// `prisma/seed.ts` writes and the row `library-importer.ts` writes — with
// DIFFERENT `key` values, because `Framework.key` is `@unique`. Mapping sets
// are authored against the library representation (the importer resolves refs
// against library keys), while a seeded tenant's requirement rows are the
// other one. Comparing `path.target.frameworkKey === targetFrameworkKey`
// therefore drops every path for a tenant holding the other representation,
// and matching target requirements by `requirementId` misses them again even
// when the path survives.
//
// Both halves live in `domain/framework-representation.ts` and both are
// needed: the family collapses the two rows, and the canonical code collapses
// the two spellings of one obligation (ISO 27001 Annex A is `A.5.15` in the
// library and `5.15` in the seed). The failure this closes is a WRONG NUMBER —
// a requirement that IS mapped reported as a gap, indistinguishable from a
// framework nobody has worked on.

/**
 * `Framework.key` → that row's `sourceUrn`, for every framework row the caller
 * has loaded. The caller owns the query; this service stays pure.
 *
 * ABSENT is a legitimate state and degrades safely rather than to the old
 * behaviour: without it a key still resolves through `LEGACY_KEY_FAMILY_URNS`,
 * so a seeded key whose family is known still collapses. What an absent
 * registry cannot do is recognise a LIBRARY key as a second representation,
 * because nothing but the row's own `sourceUrn` says so.
 */
export type FrameworkIdentityRegistry = ReadonlyMap<string, string | null>;

/** The family a framework key belongs to, across representations. */
function familyOf(frameworkKey: string, frameworks?: FrameworkIdentityRegistry): string {
    return frameworkFamilyId({ key: frameworkKey, sourceUrn: frameworks?.get(frameworkKey) ?? null });
}

/**
 * Every `Framework.key` in the same family as `frameworkKey`.
 *
 * The BFS in `mapping-resolution.ts` filters candidate paths by target
 * framework KEY, so a family-aware consumer has to hand it every key in the
 * family or the paths it wants are discarded before it ever sees them.
 */
export function frameworkFamilyKeys(
    frameworkKey: string,
    frameworks?: FrameworkIdentityRegistry,
): string[] {
    const family = familyOf(frameworkKey, frameworks);
    const keys = new Set<string>([frameworkKey]);
    if (frameworks) {
        for (const key of frameworks.keys()) {
            if (familyOf(key, frameworks) === family) keys.add(key);
        }
    }
    return [...keys];
}

// ─── Traceability Service ────────────────────────────────────────────

/**
 * Build a traceability report from a raw MappingTraceResult.
 *
 * Applies conservative business semantics to each mapping path,
 * generating findings with coverage confidence and explanations.
 */
export function buildTraceabilityReport(
    trace: MappingTraceResult,
    targetFrameworkKey: string,
    frameworks?: FrameworkIdentityRegistry,
): TraceabilityReport {
    const findings: TraceabilityFinding[] = [];
    const targetFamily = familyOf(targetFrameworkKey, frameworks);

    for (const path of trace.paths) {
        // Only include paths targeting the specified framework — as a FAMILY,
        // so a mapping authored against the library representation still
        // answers for a caller asking about the seeded one.
        if (familyOf(path.target.frameworkKey, frameworks) !== targetFamily) continue;

        const confidence = strengthToConfidence(path.effectiveStrength);

        findings.push({
            source: trace.source,
            target: path.target,
            mappingStrength: path.effectiveStrength,
            confidence,
            confidenceRank: CONFIDENCE_RANK[confidence],
            isActionable: isActionableCoverage(confidence),
            isDirect: path.isDirect,
            depth: path.depth,
            explanation: generateExplanation(path),
            edgeChain: path.edges.map(e => ({
                fromCode: e.source.requirementCode,
                fromFramework: e.source.frameworkKey,
                toCode: e.target.requirementCode,
                toFramework: e.target.frameworkKey,
                strength: e.strength,
                rationale: e.rationale,
            })),
        });
    }

    // Sort by confidence rank descending (best coverage first)
    findings.sort((a, b) => {
        if (a.confidenceRank !== b.confidenceRank) return b.confidenceRank - a.confidenceRank;
        return a.target.requirementCode.localeCompare(b.target.requirementCode);
    });

    // Compute summary
    const fullCoverage = findings.filter(f => f.confidence === 'FULL').length;
    const highCoverage = findings.filter(f => f.confidence === 'HIGH').length;
    const partialCoverage = findings.filter(f => f.confidence === 'PARTIAL').length;
    const overlapCoverage = findings.filter(f => f.confidence === 'OVERLAP').length;
    const informationalOnly = findings.filter(f => f.confidence === 'INFORMATIONAL').length;

    const bestConfidence = findings.length > 0
        ? findings[0].confidence
        : 'NONE' as CoverageConfidence;

    return {
        source: trace.source,
        targetFrameworkKey,
        findings,
        summary: {
            totalFindings: findings.length,
            fullCoverage,
            highCoverage,
            partialCoverage,
            overlapCoverage,
            informationalOnly,
            bestConfidence,
        },
    };
}

/**
 * Resolve traceability for a single source requirement against a target framework.
 *
 * This is the primary product-facing API:
 * "If I'm compliant with requirement X, what does that mean for framework B?"
 */
export async function resolveTraceability(
    sourceRequirementId: string,
    targetFrameworkKey: string,
    loadEdges: MappingEdgeLoader,
    options: { maxDepth?: number; frameworks?: FrameworkIdentityRegistry } = {},
): Promise<TraceabilityReport> {
    const trace = await resolveMapping(
        {
            sourceRequirementId,
            // Every key in the family, not just the one asked for — the BFS
            // discards non-matching targets before this function sees them.
            targetFrameworkKeys: frameworkFamilyKeys(targetFrameworkKey, options.frameworks),
            maxDepth: options.maxDepth,
        },
        loadEdges,
    );

    return buildTraceabilityReport(trace, targetFrameworkKey, options.frameworks);
}

// ─── Gap Analysis Service ────────────────────────────────────────────

/**
 * Determine the gap status for a target requirement based on its
 * best mapping from any source.
 */
export function determineGapStatus(bestConfidence: CoverageConfidence): GapStatus {
    switch (bestConfidence) {
        case 'FULL':
        case 'HIGH':
            return 'COVERED';
        case 'PARTIAL':
        case 'OVERLAP':
            return 'PARTIALLY_COVERED';
        case 'INFORMATIONAL':
            return 'REVIEW_NEEDED';
        case 'NONE':
        default:
            return 'NOT_COVERED';
    }
}

/**
 * Generate a human-readable explanation for a gap status.
 */
function gapStatusExplanation(status: GapStatus, bestConfidence: CoverageConfidence, sourceCount: number): string {
    switch (status) {
        case 'COVERED':
            return bestConfidence === 'FULL'
                ? `Fully covered by ${sourceCount} equivalent requirement(s).`
                : `Likely covered by ${sourceCount} source requirement(s) — verify scope.`;
        case 'PARTIALLY_COVERED':
            return `Partially covered by ${sourceCount} source requirement(s) — additional work may be needed.`;
        case 'REVIEW_NEEDED':
            return `${sourceCount} related requirement(s) found — requires manual compliance review.`;
        case 'NOT_COVERED':
            return 'No applicable mapping found. This requirement needs independent attention.';
    }
}

/**
 * Perform cross-framework gap analysis.
 *
 * For each target requirement, resolves all mappings from the source
 * framework and determines whether the target requirement is covered,
 * partially covered, or uncovered.
 *
 * @param sourceRequirementIds - All requirement IDs from the source framework
 * @param targetRequirements - All requirements from the target framework
 * @param sourceFrameworkKey - Source framework key (for reporting)
 * @param targetFrameworkKey - Target framework key (for filtering)
 * @param loadEdges - Edge loader function
 * @param options - `maxDepth`, plus the `frameworks` identity registry that
 *                  lets the target framework be matched as a FAMILY rather
 *                  than a single `Framework.key` (see above)
 * @returns Gap analysis result with per-requirement status
 */
export async function analyzeGaps(
    sourceRequirementIds: readonly string[],
    targetRequirements: ReadonlyArray<{
        requirementId: string;
        requirementCode: string;
        requirementTitle: string;
        frameworkKey: string;
        frameworkName: string;
    }>,
    sourceFrameworkKey: string,
    targetFrameworkKey: string,
    loadEdges: MappingEdgeLoader,
    options: { maxDepth?: number; frameworks?: FrameworkIdentityRegistry } = {},
): Promise<GapAnalysisResult> {
    const targetFamily = familyOf(targetFrameworkKey, options.frameworks);

    /**
     * The obligation a requirement code names, independent of which
     * representation spelled it. Both sides below are already filtered to
     * `targetFamily`, so one canonicalisation settles the join.
     */
    const obligationOf = (code: string) => canonicalRequirementCode(targetFamily, code);

    // The whole family — the BFS filters by target framework KEY, so passing
    // only the requested key discards the paths that reach the other
    // representation of it before this function can look at them.
    const targetFrameworkKeys = frameworkFamilyKeys(targetFrameworkKey, options.frameworks);

    // Resolve all mappings from source requirements
    const queries: TraceabilityQuery[] = sourceRequirementIds.map(id => ({
        sourceRequirementId: id,
        targetFrameworkKeys,
        maxDepth: options.maxDepth,
    }));

    const traces = await resolveMappingBatch(queries, loadEdges);

    // Build a map: target OBLIGATION → best coverage info. Keyed by canonical
    // code rather than requirement id: a mapping authored against the library
    // representation lands on ITS requirement rows, which carry different ids
    // (and, for ISO 27001 Annex A, a different spelling) from the ones the
    // caller is reporting on.
    const targetCoverage = new Map<string, {
        bestConfidence: CoverageConfidence;
        bestStrength: MappingStrengthValue;
        bestSource: TraceabilityFinding['source'] | null;
        isDirect: boolean;
        sourceCount: number;
    }>();

    for (const trace of traces) {
        for (const path of trace.paths) {
            if (familyOf(path.target.frameworkKey, options.frameworks) !== targetFamily) continue;

            const obligation = obligationOf(path.target.requirementCode);
            const confidence = strengthToConfidence(path.effectiveStrength);
            const existing = targetCoverage.get(obligation);

            if (!existing || CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.bestConfidence]) {
                targetCoverage.set(obligation, {
                    bestConfidence: confidence,
                    bestStrength: path.effectiveStrength,
                    bestSource: trace.source,
                    isDirect: path.isDirect,
                    sourceCount: (existing?.sourceCount ?? 0) + 1,
                });
            } else {
                targetCoverage.set(obligation, {
                    ...existing,
                    sourceCount: existing.sourceCount + 1,
                });
            }
        }
    }

    // Build gap analysis entries for each target requirement
    const entries: GapAnalysisEntry[] = targetRequirements.map(target => {
        const coverage = targetCoverage.get(obligationOf(target.requirementCode));

        if (!coverage) {
            return {
                targetRequirement: target,
                status: 'NOT_COVERED' as GapStatus,
                bestConfidence: 'NONE' as CoverageConfidence,
                sourceCount: 0,
                bestSource: null,
                explanation: gapStatusExplanation('NOT_COVERED', 'NONE', 0),
            };
        }

        const status = determineGapStatus(coverage.bestConfidence);

        return {
            targetRequirement: target,
            status,
            bestConfidence: coverage.bestConfidence,
            sourceCount: coverage.sourceCount,
            bestSource: coverage.bestSource ? {
                requirementId: coverage.bestSource.requirementId,
                requirementCode: coverage.bestSource.requirementCode,
                frameworkKey: coverage.bestSource.frameworkKey,
                strength: coverage.bestStrength,
                confidence: coverage.bestConfidence,
                isDirect: coverage.isDirect,
            } : null,
            explanation: gapStatusExplanation(status, coverage.bestConfidence, coverage.sourceCount),
        };
    });

    // Sort: NOT_COVERED first, then PARTIALLY_COVERED, etc. (gaps first)
    entries.sort((a, b) => {
        const statusOrder: Record<GapStatus, number> = {
            NOT_COVERED: 0,
            REVIEW_NEEDED: 1,
            PARTIALLY_COVERED: 2,
            COVERED: 3,
        };
        const statusDiff = statusOrder[a.status] - statusOrder[b.status];
        if (statusDiff !== 0) return statusDiff;
        return a.targetRequirement.requirementCode.localeCompare(b.targetRequirement.requirementCode);
    });

    // Summary
    const covered = entries.filter(e => e.status === 'COVERED').length;
    const partiallyCovered = entries.filter(e => e.status === 'PARTIALLY_COVERED').length;
    const notCovered = entries.filter(e => e.status === 'NOT_COVERED').length;
    const reviewNeeded = entries.filter(e => e.status === 'REVIEW_NEEDED').length;
    const total = entries.length;

    return {
        sourceFramework: sourceFrameworkKey,
        targetFramework: targetFrameworkKey,
        entries,
        summary: {
            totalTargetRequirements: total,
            covered,
            partiallyCovered,
            notCovered,
            reviewNeeded,
            coveragePercent: total > 0 ? Math.round((covered / total) * 100) : 0,
            inclusiveCoveragePercent: total > 0 ? Math.round(((covered + partiallyCovered) / total) * 100) : 0,
        },
    };
}
