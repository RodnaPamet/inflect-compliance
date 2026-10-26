/**
 * Coverage a framework inherits from the tenant's OTHER frameworks.
 *
 * `computeCoverage` (coverage.ts) answers "which requirements have a control
 * linked to them". This answers the question beside it: for each requirement,
 * do the tenant's controls on another framework reach it through a curated
 * cross-framework mapping? It is how an ISO 42001 holder opening AIUC-1 sees
 * which requirements their existing controls already bear on, instead of fifty
 * blanks.
 *
 * INHERITED COVERAGE IS NEVER COVERAGE. A requirement reached only through a
 * mapping is at best `PARTIALLY_COVERED`, even over an EQUAL or SUPERSET edge,
 * for the reason `services/agent-risk-coverage.ts` gives for the same cap: a
 * mapping is Inflect's judgement that two obligations overlap, not the tenant
 * asserting that a control governs this one. Nothing here feeds
 * `coveragePercent`, and a requirement with a control of its own reads
 * `DIRECT` whatever else reaches it.
 *
 * WHY NOT `performGapAnalysis`. That usecase compares two framework CATALOGUES —
 * how much of B is mapped from A — with no tenant in it, so it cannot say what
 * THIS tenant's controls give them. This report is tenant-scoped and goes
 * through the same loader as per-agent risk coverage
 * (`services/inherited-requirement-coverage.ts`), so the two surfaces cannot
 * disagree about which controls reach a requirement.
 *
 * Read-only. No audit event: it reads links other seams wrote.
 */
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { assertCanViewFrameworks } from '../../policies/framework.policies';
import { MAPPING_STRENGTH_RANK } from '../../domain/requirement-mapping.types';
import {
    determineGapStatus,
    strengthToConfidence,
} from '../../services/cross-framework-traceability';
import { resolveFamilyRequirementAliases } from '../../services/framework-representation-aliases';
import {
    loadControlsByRequirement,
    loadFrameworkCatalogue,
    loadInheritedCoverage,
    type InheritedCoverage,
} from '../../services/inherited-requirement-coverage';
import type { RequestContext } from '../../types';

/** Bound on one framework's requirement rows; the largest shipped is in the hundreds. */
const REQUIREMENT_CAP = 2000;

export type InheritedRequirementStatus =
    /** The tenant holds a control linked to this requirement itself. */
    | 'DIRECT'
    /** No control of its own; reached by an INTERSECT-or-stronger route the tenant holds. */
    | 'PARTIALLY_COVERED'
    /** No control of its own; reached only by RELATED routes the tenant holds. */
    | 'REVIEW_NEEDED'
    /** No control of its own and no route the tenant holds. */
    | 'NOT_COVERED';

export interface InheritedRequirementEntry {
    readonly code: string;
    readonly title: string;
    readonly section: string | null;
    readonly status: InheritedRequirementStatus;
    /** Routes the tenant holds at least one control on, strongest first. */
    readonly routes: readonly InheritedCoverage[];
}

export interface InheritedCoverageReport {
    readonly framework: { readonly key: string; readonly name: string };
    /** Every non-deprecated requirement of the framework. */
    readonly total: number;
    readonly summary: {
        readonly direct: number;
        readonly partiallyCovered: number;
        readonly reviewNeeded: number;
        readonly notCovered: number;
    };
    /** The frameworks the tenant's controls reach this one from, and how many requirements each reaches. */
    readonly sourceFrameworks: readonly {
        readonly key: string;
        readonly name: string;
        readonly requirements: number;
    }[];
    /** Every requirement at least one held route reaches, in framework order. */
    readonly requirements: readonly InheritedRequirementEntry[];
    /**
     * TRUE when a read hit its cap, so the report is built from a subset and
     * its counts are lower bounds. A capped read cannot tell "N" from "the
     * first N of more", so the report says which it was.
     */
    readonly truncated: boolean;
}

const byStrengthThenSource = (a: InheritedCoverage, b: InheritedCoverage) =>
    MAPPING_STRENGTH_RANK[b.strength] - MAPPING_STRENGTH_RANK[a.strength] ||
    a.frameworkKey.localeCompare(b.frameworkKey) ||
    a.requirementCode.localeCompare(b.requirementCode);

/**
 * The status of one requirement, from whether it has a control of its own and
 * the routes the tenant holds (already sorted strongest first).
 */
function classifyRequirement(
    hasDirectControl: boolean,
    heldRoutes: readonly InheritedCoverage[],
): InheritedRequirementStatus {
    if (hasDirectControl) return 'DIRECT';
    if (heldRoutes.length === 0) return 'NOT_COVERED';
    const status = determineGapStatus(strengthToConfidence(heldRoutes[0].strength));
    // The cap — see the module header. COVERED never comes from a mapping.
    if (status === 'COVERED' || status === 'PARTIALLY_COVERED') return 'PARTIALLY_COVERED';
    if (status === 'REVIEW_NEEDED') return 'REVIEW_NEEDED';
    return 'NOT_COVERED';
}

export async function computeInheritedCoverage(
    ctx: RequestContext,
    frameworkKey: string,
): Promise<InheritedCoverageReport> {
    assertCanViewFrameworks(ctx);

    return runInTenantContext(ctx, async (db) => {
        const fw = await db.framework.findFirst({
            where: { key: frameworkKey },
            select: { id: true, key: true, name: true, sourceUrn: true },
        });
        if (!fw) throw notFound('Framework not found');

        const read = await db.frameworkRequirement.findMany({
            where: { frameworkId: fw.id, deprecatedAt: null },
            select: { id: true, code: true, title: true, section: true, category: true },
            orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
            take: REQUIREMENT_CAP + 1,
        });
        const requirementsTruncated = read.length > REQUIREMENT_CAP;
        const requirements = requirementsTruncated ? read.slice(0, REQUIREMENT_CAP) : read;

        // Every row, in either representation of this framework, that means
        // each requirement: the mapping edges land on library rows, a tenant
        // may be looking at the seeded one, and its own control links may sit
        // on either.
        const aliases = await resolveFamilyRequirementAliases(db, fw, requirements);
        const idsByOwnRequirement = new Map<string, string[]>();
        for (const [anyId, ownId] of aliases.toOwnRequirementId) {
            const bucket = idsByOwnRequirement.get(ownId);
            if (bucket) bucket.push(anyId);
            else idsByOwnRequirement.set(ownId, [anyId]);
        }

        const catalogue = await loadFrameworkCatalogue(db);
        const [directControls, inherited] = await Promise.all([
            loadControlsByRequirement(db, ctx, aliases.lookupIds),
            loadInheritedCoverage(
                db,
                ctx,
                catalogue,
                requirements.map((r) => ({
                    key: r.id,
                    requirementIds: idsByOwnRequirement.get(r.id) ?? [r.id],
                })),
            ),
        ]);

        const summary = { direct: 0, partiallyCovered: 0, reviewNeeded: 0, notCovered: 0 };
        const reachedBySource = new Map<string, { key: string; name: string; codes: Set<string> }>();
        const entries: InheritedRequirementEntry[] = [];

        for (const requirement of requirements) {
            const rowIds = idsByOwnRequirement.get(requirement.id) ?? [requirement.id];
            const hasDirectControl = rowIds.some((id) => (directControls.get(id)?.length ?? 0) > 0);
            // Only routes the tenant holds a control on: a mapping nobody has
            // implemented the other end of reaches nothing.
            const heldRoutes = (inherited.routes.get(requirement.id) ?? [])
                .filter((route) => route.controls.length > 0)
                .sort(byStrengthThenSource);

            const status = classifyRequirement(hasDirectControl, heldRoutes);
            if (status === 'DIRECT') summary.direct++;
            else if (status === 'PARTIALLY_COVERED') summary.partiallyCovered++;
            else if (status === 'REVIEW_NEEDED') summary.reviewNeeded++;
            else summary.notCovered++;

            if (heldRoutes.length === 0) continue;
            for (const route of heldRoutes) {
                const source = reachedBySource.get(route.frameworkKey) ?? {
                    key: route.frameworkKey,
                    name: route.frameworkName,
                    codes: new Set<string>(),
                };
                source.codes.add(requirement.code);
                reachedBySource.set(route.frameworkKey, source);
            }
            entries.push({
                code: requirement.code,
                title: requirement.title,
                section: requirement.section || requirement.category || null,
                status,
                routes: heldRoutes,
            });
        }

        return {
            framework: { key: fw.key, name: fw.name },
            total: requirements.length,
            summary,
            sourceFrameworks: [...reachedBySource.values()]
                .map((s) => ({ key: s.key, name: s.name, requirements: s.codes.size }))
                .sort((a, b) => b.requirements - a.requirements || a.key.localeCompare(b.key)),
            requirements: entries,
            truncated: requirementsTruncated || inherited.truncated,
        };
    });
}
