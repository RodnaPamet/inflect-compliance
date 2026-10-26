/**
 * Epic 46 — pure compliance-status computation.
 *
 * Everything here is a pure function. The DB query that feeds it
 * lives in the framework tree usecase; the rules are isolated so
 * they can be unit-tested without Prisma and so the same rules can
 * be reused (later) for the framework page header, the minimap
 * legend, and CSV export.
 *
 * Rules in one place — drift between server-side aggregation and
 * UI badges has been the canonical source of misleading dashboards
 * across compliance products. Keep the rule table here authoritative.
 */

import type {
    ComplianceStatus,
    FrameworkTreeNode,
} from './types';

// ─── Per-control inputs ────────────────────────────────────────────────

/**
 * The minimum a control must report to feed the rules. Aligns with
 * the columns the tree usecase selects from the `Control` model.
 */
export interface ControlForCompliance {
    status:
        | 'NOT_STARTED'
        | 'PLANNED'
        | 'IN_PROGRESS'
        | 'IMPLEMENTING'
        | 'IMPLEMENTED'
        | 'NEEDS_REVIEW'
        | 'NOT_APPLICABLE';
    applicability: 'APPLICABLE' | 'NOT_APPLICABLE';
}

// ─── Per-requirement compute ───────────────────────────────────────────

/**
 * Compute the compliance status of a single requirement from the
 * controls mapped to it.
 *
 * Rule table:
 *
 *   No mapped controls                          → 'gap'
 *   All mapped controls NOT_APPLICABLE          → 'na'
 *   (Considering only APPLICABLE controls:)
 *     All IMPLEMENTED                            → 'compliant'
 *     Some IMPLEMENTED, some not                 → 'partial'
 *     None IMPLEMENTED                           → 'gap'
 *
 * `Control.applicability === NOT_APPLICABLE` always wins over
 * `Control.status` — an N/A control never causes "partial" or
 * "gap" by being un-implemented; that's the whole point of the
 * applicability flag.
 */
export function computeRequirementComplianceStatus(
    controls: ReadonlyArray<ControlForCompliance>,
): ComplianceStatus {
    if (controls.length === 0) return 'gap';

    const applicable = controls.filter((c) => c.applicability !== 'NOT_APPLICABLE');
    if (applicable.length === 0) return 'na';

    let implemented = 0;
    for (const c of applicable) if (c.status === 'IMPLEMENTED') implemented += 1;

    if (implemented === applicable.length) return 'compliant';
    if (implemented === 0) return 'gap';
    return 'partial';
}

// ─── Per-section aggregation ───────────────────────────────────────────

/**
 * Aggregate descendant requirement statuses into a single section
 * verdict.
 *
 * Rule table:
 *
 *   No descendant statuses                        → 'unknown'
 *   All descendants 'na'                           → 'na'
 *   All descendants 'compliant' (or 'na')          → 'compliant'
 *   All descendants 'gap' (or 'na')                → 'gap'
 *   Otherwise (mixed)                              → 'partial'
 *
 * `na` is treated as "ignore" in the aggregation — a section
 * containing 5 compliant + 2 N/A reads as `compliant`, not
 * `partial`. This matches how compliance audit reporting treats
 * deliberate scope-outs.
 */
export function aggregateComplianceStatus(
    children: ReadonlyArray<ComplianceStatus>,
): ComplianceStatus {
    if (children.length === 0) return 'unknown';
    let allNa = true;
    let allCompliant = true;
    let allGap = true;
    for (const s of children) {
        if (s !== 'na') allNa = false;
        if (s === 'na') continue; // skip in compliant/gap checks
        if (s !== 'compliant') allCompliant = false;
        if (s !== 'gap') allGap = false;
    }
    if (allNa) return 'na';
    if (allCompliant) return 'compliant';
    if (allGap) return 'gap';
    return 'partial';
}

// ─── Tree decoration ───────────────────────────────────────────────────

/**
 * Walk a built tree and decorate every node with
 * `complianceStatus` + `statusCounts`. Requirements pull their
 * status from the supplied `controlsByRequirementId` lookup;
 * sections aggregate from their descendants.
 *
 * Returns a new array of root nodes — the input is not mutated.
 * Children references that didn't change are preserved structurally
 * so downstream `useMemo` in the explorer doesn't blow up its
 * dependencies on every render.
 */
export function decorateTreeWithCompliance(
    nodes: ReadonlyArray<FrameworkTreeNode>,
    controlsByRequirementId: ReadonlyMap<string, ReadonlyArray<ControlForCompliance>>,
    /**
     * Requirement ids outside the packs the workspace chose. Each reads as
     * `na` whatever is mapped to it, so it is neither a gap nor counted as
     * covered, and is flagged `outOfScope` for the explorer's label.
     */
    outOfScopeRequirementIds: ReadonlySet<string> = new Set(),
): FrameworkTreeNode[] {
    function emptyCounts() {
        return { compliant: 0, partial: 0, gap: 0, na: 0, unknown: 0 };
    }
    function bump(
        counts: ReturnType<typeof emptyCounts>,
        status: ComplianceStatus,
    ) {
        counts[status] += 1;
    }

    function visit(node: FrameworkTreeNode): FrameworkTreeNode {
        const children = node.children.map(visit);
        const counts = emptyCounts();

        let status: ComplianceStatus;
        const outOfScope = node.kind === 'requirement' && outOfScopeRequirementIds.has(node.id);
        if (node.kind === 'requirement') {
            const ownControls = controlsByRequirementId.get(node.id) ?? [];
            status = outOfScope ? 'na' : computeRequirementComplianceStatus(ownControls);
            bump(counts, status);
            // Descendant requirement counts (sub-requirements)
            for (const c of children) {
                if (c.statusCounts) {
                    counts.compliant += c.statusCounts.compliant;
                    counts.partial += c.statusCounts.partial;
                    counts.gap += c.statusCounts.gap;
                    counts.na += c.statusCounts.na;
                    counts.unknown += c.statusCounts.unknown;
                }
            }
        } else {
            // Section — never has its own controls; aggregates from
            // descendant requirement statuses.
            const descendantStatuses: ComplianceStatus[] = [];
            for (const c of children) {
                if (c.statusCounts) {
                    counts.compliant += c.statusCounts.compliant;
                    counts.partial += c.statusCounts.partial;
                    counts.gap += c.statusCounts.gap;
                    counts.na += c.statusCounts.na;
                    counts.unknown += c.statusCounts.unknown;
                }
                if (c.complianceStatus) {
                    descendantStatuses.push(c.complianceStatus);
                }
            }
            // Use INDIVIDUAL requirement statuses (not just direct
            // children) so a section reflects every leaf, not just
            // the next level.
            const flatLeafStatuses: ComplianceStatus[] = [];
            collectLeafStatuses(children, flatLeafStatuses);
            status = aggregateComplianceStatus(
                flatLeafStatuses.length ? flatLeafStatuses : descendantStatuses,
            );
        }

        return {
            ...node,
            children,
            complianceStatus: status,
            statusCounts: counts,
            ...(outOfScope ? { outOfScope: true } : {}),
        };
    }

    return nodes.map(visit);
}

function collectLeafStatuses(
    nodes: ReadonlyArray<FrameworkTreeNode>,
    out: ComplianceStatus[],
): void {
    for (const n of nodes) {
        if (n.kind === 'requirement' && n.children.length === 0) {
            if (n.complianceStatus) out.push(n.complianceStatus);
        } else {
            collectLeafStatuses(n.children, out);
        }
    }
}
