/**
 * Inherited requirement coverage — the shared loader.
 *
 * Answers one question: which of the tenant's controls, linked to a requirement
 * in ANOTHER framework, reach a given requirement through a cross-framework
 * mapping? Two surfaces ask it, and they share this one implementation:
 *
 *   `usecases/agent-coverage.ts`               per-agent OWASP ASI risk coverage
 *   `usecases/framework/inherited-coverage.ts` a framework's Coverage tab
 *
 * Sharing is the point, not tidiness. The family expansion below — two
 * representations of a framework, two spellings of a requirement code — is the
 * hard-won part, and a second copy would be a place where two compliance
 * surfaces disagree about what one tenant's controls cover.
 *
 * BOTH SIDES ARE RESOLVED AS A FAMILY. Mapping-set YAML resolves refs against
 * LIBRARY keys (`ISO42001-2023`), while a seeded tenant's controls hang off the
 * seed row (`ISO42001`), and the seed numbers ISO 27001 Annex A `5.15` where
 * the library numbers it `A.5.15`. The caller supplies every requirement id
 * that means a target obligation (both representations); this loader expands
 * every SOURCE requirement to all its family rows and spellings before looking
 * for the tenant's controls. Both reconciliations live in
 * `domain/framework-representation.ts`.
 *
 * Read-only, and tenant-scoped only where it touches tenant data: mappings and
 * the framework catalogue are GLOBAL tables, control links are filtered by
 * `ctx.tenantId` and run inside the caller's tenant transaction.
 */
import type { PrismaTx } from '@/lib/db-context';
import {
    MAPPING_STRENGTH_RANK,
    type MappingStrengthValue,
} from '../domain/requirement-mapping.types';
import {
    canonicalRequirementCode,
    frameworkFamilyId,
    requirementCodeSpellings,
} from '../domain/framework-representation';
import type { RequestContext } from '../types';

/** A tenant control that implements a requirement. */
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
 * One route in: a requirement in another framework that cross-maps onto the
 * target, with the tenant's controls on it (possibly none).
 */
export interface InheritedCoverage {
    readonly frameworkKey: string;
    readonly frameworkName: string;
    readonly requirementCode: string;
    readonly requirementTitle: string;
    readonly strength: MappingStrengthValue;
    readonly controls: readonly CoveringControl[];
}

/** One `Framework` row, as far as family resolution needs it. */
export interface FrameworkCatalogueEntry {
    readonly id: string;
    readonly key: string;
    readonly name: string;
    readonly sourceUrn: string | null;
}

/**
 * The framework catalogue is a small GLOBAL table (tens of rows, no tenantId,
 * no RLS). It is loaded whole and grouped in memory so the family expansion
 * costs one query rather than one per mapping edge.
 */
export const FRAMEWORK_CATALOGUE_CAP = 500;

/** Bound on the mapping edges landing on one call's targets. */
export const MAPPING_EDGE_CAP = 2000;

export async function loadFrameworkCatalogue(db: PrismaTx): Promise<FrameworkCatalogueEntry[]> {
    return db.framework.findMany({
        select: { id: true, key: true, name: true, sourceUrn: true },
        take: FRAMEWORK_CATALOGUE_CAP,
    });
}

/**
 * One obligation to find routes into. `key` is the caller's identifier for it
 * (a risk code, a requirement code); `requirementIds` is every row that means
 * it, across both representations.
 */
export interface InheritedCoverageTarget {
    readonly key: string;
    readonly requirementIds: readonly string[];
}

export interface InheritedCoverageResult {
    /** Target key → its routes in, strongest-edge-per-route. A key with no edges is absent. */
    readonly routes: ReadonlyMap<string, InheritedCoverage[]>;
    /**
     * TRUE when more edges landed on the targets than `MAPPING_EDGE_CAP`, so
     * `routes` is built from a subset. Held as a fact rather than inferred: a
     * read capped at N cannot tell "N edges" from "the first N of more".
     */
    readonly truncated: boolean;
}

/**
 * Tenant controls per requirement id. `control.deletedAt: null` for the reason
 * `usecases/framework/coverage.ts` gives on the same join: without it coverage
 * drifts UPWARD as controls are deleted.
 */
export async function loadControlsByRequirement(
    db: PrismaTx,
    ctx: RequestContext,
    requirementIds: string[],
): Promise<Map<string, CoveringControl[]>> {
    if (requirementIds.length === 0) return new Map();

    const links = await db.controlRequirementLink.findMany({
        where: {
            tenantId: ctx.tenantId,
            requirementId: { in: requirementIds },
            control: { deletedAt: null },
        },
        select: {
            requirementId: true,
            control: { select: { id: true, code: true, name: true, status: true } },
        },
    });

    const out = new Map<string, CoveringControl[]>();
    for (const link of links) {
        const control: CoveringControl = {
            id: link.control.id,
            code: link.control.code,
            name: link.control.name,
            status: String(link.control.status),
        };
        const bucket = out.get(link.requirementId);
        if (bucket) bucket.push(control);
        else out.set(link.requirementId, [control]);
    }
    return out;
}

/**
 * Inherited coverage: tenant controls on OTHER frameworks' requirements that
 * cross-map onto each target.
 *
 * Four queries, none of them in a loop. The family expansion in the middle is
 * what makes this work on a seeded database — see the module header.
 */
export async function loadInheritedCoverage(
    db: PrismaTx,
    ctx: RequestContext,
    catalogue: readonly FrameworkCatalogueEntry[],
    targets: readonly InheritedCoverageTarget[],
): Promise<InheritedCoverageResult> {
    const targetKeyByRequirementId = new Map<string, string>();
    for (const target of targets) {
        for (const id of target.requirementIds) targetKeyByRequirementId.set(id, target.key);
    }
    if (targetKeyByRequirementId.size === 0) return { routes: new Map(), truncated: false };

    const now = new Date();
    const read = await db.requirementMapping.findMany({
        where: {
            targetRequirementId: { in: [...targetKeyByRequirementId.keys()] },
            // Audit Coherence S9 temporal window — a superseded mapping must
            // not keep answering for a control set nobody re-examined.
            OR: [{ validTo: null }, { validTo: { gt: now } }],
        },
        select: {
            targetRequirementId: true,
            strength: true,
            sourceRequirement: {
                select: { id: true, code: true, title: true, frameworkId: true },
            },
        },
        // One past the cap, so truncation is a fact this function holds.
        take: MAPPING_EDGE_CAP + 1,
    });
    const truncated = read.length > MAPPING_EDGE_CAP;
    const edges = truncated ? read.slice(0, MAPPING_EDGE_CAP) : read;
    if (edges.length === 0) return { routes: new Map(), truncated };

    // Expand each mapping's source framework to its whole family, so a control
    // linked to the seeded representation satisfies a mapping authored against
    // the library one.
    const catalogueById = new Map(catalogue.map((f) => [f.id, f]));
    const wantedFamilies = new Set<string>();
    for (const edge of edges) {
        const fw = catalogueById.get(edge.sourceRequirement.frameworkId);
        if (fw) wantedFamilies.add(frameworkFamilyId(fw));
    }
    const familyFrameworkIds = catalogue
        .filter((f) => wantedFamilies.has(frameworkFamilyId(f)))
        .map((f) => f.id);

    // Ask for every SPELLING of each source code, not just the one the mapping
    // was authored with. ISO 27001 Annex A control 5.15 is `A.5.15` in the
    // library the mapping cites and `5.15` in the seed a tenant's controls hang
    // off; `code: { in: [...] }` on one spelling reaches neither the other
    // representation's rows nor, therefore, that tenant's controls.
    const sourceCodes = [
        ...new Set(
            edges.flatMap((e) => {
                const fw = catalogueById.get(e.sourceRequirement.frameworkId);
                if (!fw) return [e.sourceRequirement.code];
                return requirementCodeSpellings(frameworkFamilyId(fw), e.sourceRequirement.code);
            }),
        ),
    ];
    const siblingRows = await db.frameworkRequirement.findMany({
        where: {
            frameworkId: { in: familyFrameworkIds },
            code: { in: sourceCodes },
            deprecatedAt: null,
        },
        select: { id: true, code: true, frameworkId: true },
    });

    // (family, canonical code) → every requirement row that means the same
    // obligation, across both representations AND both spellings.
    const siblingsByFamilyCode = new Map<string, string[]>();
    for (const row of siblingRows) {
        const fw = catalogueById.get(row.frameworkId);
        if (!fw) continue;
        const family = frameworkFamilyId(fw);
        const key = `${family}::${canonicalRequirementCode(family, row.code)}`;
        const bucket = siblingsByFamilyCode.get(key);
        if (bucket) bucket.push(row.id);
        else siblingsByFamilyCode.set(key, [row.id]);
    }

    const controlsBySourceRequirement = await loadControlsByRequirement(
        db,
        ctx,
        siblingRows.map((r) => r.id),
    );

    // Collapse edges by (target, source family, source code): the same
    // obligation reached through two representations is ONE inherited route,
    // and it keeps the strongest strength either edge claimed.
    const byTargetKey = new Map<string, Map<string, InheritedCoverage>>();
    for (const edge of edges) {
        const targetKey = targetKeyByRequirementId.get(edge.targetRequirementId);
        const fw = catalogueById.get(edge.sourceRequirement.frameworkId);
        if (!targetKey || !fw) continue;

        const family = frameworkFamilyId(fw);
        const routeKey = `${family}::${canonicalRequirementCode(family, edge.sourceRequirement.code)}`;
        const controls = dedupeControls(
            (siblingsByFamilyCode.get(routeKey) ?? []).flatMap(
                (id) => controlsBySourceRequirement.get(id) ?? [],
            ),
        );

        const routes = byTargetKey.get(targetKey) ?? new Map<string, InheritedCoverage>();
        const existing = routes.get(routeKey);
        const strength = edge.strength as MappingStrengthValue;
        if (!existing || MAPPING_STRENGTH_RANK[strength] > MAPPING_STRENGTH_RANK[existing.strength]) {
            routes.set(routeKey, {
                frameworkKey: fw.key,
                frameworkName: fw.name,
                requirementCode: edge.sourceRequirement.code,
                requirementTitle: edge.sourceRequirement.title,
                strength,
                controls,
            });
        }
        byTargetKey.set(targetKey, routes);
    }

    const out = new Map<string, InheritedCoverage[]>();
    for (const [targetKey, routes] of byTargetKey) out.set(targetKey, [...routes.values()]);
    return { routes: out, truncated };
}

/** One control can implement several requirement rows for the same obligation. */
export function dedupeControls(controls: readonly CoveringControl[]): CoveringControl[] {
    const byId = new Map<string, CoveringControl>();
    for (const control of controls) if (!byId.has(control.id)) byId.set(control.id, control);
    // Sort by code, falling back to the name for controls that have none —
    // `Control.code` is optional, and an uncoded control would otherwise sort
    // as an empty string and clump at the top of an assessor-facing list ahead
    // of everything with a real identifier.
    return [...byId.values()].sort((a, b) =>
        (a.code ?? a.name).localeCompare(b.code ?? b.name),
    );
}
