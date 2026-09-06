/**
 * The ONE seam that reconciles the two representations of a framework, for
 * every surface that joins a tenant's `ControlRequirementLink` rows to a
 * framework's requirements.
 *
 * Every framework in this repo can exist TWICE in `Framework`: the row
 * `prisma/seed.ts` writes, and the row `library-importer.ts` writes from the
 * YAML in `src/data/libraries/`. Their `key` values MUST differ because
 * `Framework.key` is `@unique`, and a tenant's links hang off whichever
 * representation its database happened to get.
 *
 * The two disagree on TWO independent axes, and `domain/framework-representation.ts`
 * carries both halves: framework IDENTITY (`sourceUrn`, or
 * `LEGACY_KEY_FAMILY_URNS` for rows written before that convention) and the
 * requirement CODE NAMESPACE (ISO 27001 Annex A is `A.5.15` in the library and
 * `5.15` in the seed).
 *
 * WHY THIS IS A SHARED MODULE RATHER THAN A HELPER IN ONE FILE. Four surfaces
 * answer "which of this framework's requirements does this tenant cover?" from
 * the same links, and the same person reads them side by side:
 *
 *   `computeCoverage`         framework list page, JSON + CSV export, MCP tools
 *   `generateReadinessReport` readiness report and its export
 *   `getSoA`                  the Statement of Applicability and its export
 *   `getFrameworkTree`        the per-requirement compliance decoration
 *
 * Fixing a subset is WORSE than fixing none: the surfaces then contradict each
 * other about the same tenant at the same moment (coverage 100% beside an SoA
 * reporting every requirement unmapped) and neither says why. A fifth surface
 * that joins on `requirementId` alone belongs here too.
 *
 * The DENOMINATOR stays the requested framework's own requirements, on
 * purpose. A sibling representation can carry obligations the requested one
 * does not declare, and folding those in would inflate the total with
 * requirements nobody asked about. Only the NUMERATOR expands.
 */
import type { PrismaTx } from '@/lib/db-context';

import {
    canonicalRequirementCode,
    frameworkFamilyId,
    type FrameworkIdentity,
} from '../domain/framework-representation';

/** The framework catalogue is a small GLOBAL table (tens of rows, no tenantId). */
const FRAMEWORK_CATALOGUE_CAP = 500;

/**
 * Bound on the sibling requirement rows read for the alias map. The largest
 * framework shipped is ISO 27001 at ~100 rows across both representations, so
 * this cap is two orders of magnitude clear of the data; it exists so a
 * malformed catalogue cannot turn one page render into an unbounded read.
 */
const SIBLING_REQUIREMENT_CAP = 5000;

export interface FamilyRequirementAliases {
    /** Every requirement id a tenant link may point at: this framework's rows and its siblings'. */
    readonly lookupIds: string[];
    /** Any family requirement id, mapped to the REQUESTED framework's row for the same obligation. */
    readonly toOwnRequirementId: ReadonlyMap<string, string>;
}

/**
 * Map every other representation's requirement rows onto this framework's own,
 * by (family, canonical code).
 *
 * Both halves matter and fixing one alone delivers nothing: collapsing the
 * family without canonicalising the code reaches the sibling framework and
 * then matches none of its Annex A rows, and canonicalising the code without
 * collapsing the family never reaches the sibling framework at all.
 *
 * Reads only GLOBAL tables (`Framework`, `FrameworkRequirement`), so a
 * caller's tenant transaction is a fine place to run it from, and taking the
 * client as an argument is what keeps this module out of `@/lib/prisma`.
 */
export async function resolveFamilyRequirementAliases(
    db: PrismaTx,
    fw: FrameworkIdentity & { id: string },
    requirements: readonly { id: string; code: string }[],
): Promise<FamilyRequirementAliases> {
    const toOwn = new Map<string, string>();
    for (const r of requirements) toOwn.set(r.id, r.id);
    const done = (): FamilyRequirementAliases => ({
        lookupIds: [...toOwn.keys()],
        toOwnRequirementId: toOwn,
    });

    const family = frameworkFamilyId(fw);

    // `frameworkFamilyId` degrades to `key:<key>` for a row that declares no
    // family, and `Framework.key` is `@unique`, so a family id of that shape
    // can only ever name THIS row. Skipping the catalogue read here is not an
    // optimisation traded against correctness: there is provably no sibling.
    if (family === `key:${fw.key}`) return done();

    const catalogue = await db.framework.findMany({
        select: { id: true, key: true, sourceUrn: true },
        take: FRAMEWORK_CATALOGUE_CAP,
    });
    const siblingFrameworkIds = catalogue
        .filter((f) => f.id !== fw.id && frameworkFamilyId(f) === family)
        .map((f) => f.id);
    if (siblingFrameworkIds.length === 0) return done();

    const ownByCanonicalCode = new Map<string, string>();
    for (const r of requirements) {
        ownByCanonicalCode.set(canonicalRequirementCode(family, r.code), r.id);
    }

    const siblings = await db.frameworkRequirement.findMany({
        where: { frameworkId: { in: siblingFrameworkIds }, deprecatedAt: null },
        select: { id: true, code: true },
        take: SIBLING_REQUIREMENT_CAP,
    });
    for (const s of siblings) {
        // A sibling obligation the requested framework does not declare is
        // dropped rather than added: see the denominator note above.
        const own = ownByCanonicalCode.get(canonicalRequirementCode(family, s.code));
        if (own) toOwn.set(s.id, own);
    }

    return done();
}

/** The least a link row must carry to be collapsed onto its own requirement. */
export interface CollapsibleLink {
    readonly requirementId: string;
    readonly control: { readonly id: string };
}

/**
 * Re-point every link at the REQUESTED framework's own requirement row, at
 * most ONE link per (requirement, control).
 *
 * The dedupe is not defensive tidying, it is required by the collapse.
 * `ControlRequirementLink` is `@@unique([controlId, requirementId])`, so
 * before the collapse a control could appear at most once per requirement and
 * every consumer was entitled to assume it. A control linked to BOTH
 * representations of one obligation is the only way that assumption breaks,
 * and it breaks visibly: two rows in `computeCoverage`'s `controlMappings` and
 * two identical lines in the coverage CSV, and — because
 * `ControlRequirementLink.applicability` is a PER-FRAMEWORK override that the
 * SoA and the readiness rollup both resolve — a control scoped out of THIS
 * framework arriving alongside a sibling link that says otherwise, and
 * counting as applicable. (`getFrameworkTree` reads `Control.applicability`,
 * its global column, so a duplicate cannot change its verdict today. The
 * dedupe is what keeps that true rather than something that surface relies
 * on.)
 *
 * The tie-break is not arbitrary either. `ControlRequirementLink.applicability`
 * is a PER-FRAMEWORK override, so when two links survive the collapse the one
 * written against the requested framework's OWN row is the one that names the
 * framework the caller asked about, and it wins. Between two sibling links
 * (three representations, none of them the requested one) the lower
 * requirement id wins: arbitrary in meaning, but STABLE, so the same tenant
 * cannot get a different answer from a different query plan.
 */
export function collapseLinksToOwnRequirements<L extends CollapsibleLink>(
    links: readonly L[],
    aliases: FamilyRequirementAliases,
): L[] {
    // The tie-break reads the requirement each link was WRITTEN against, which
    // is why the pre-collapse id is carried alongside the re-pointed row: read
    // it off the stored link instead and every held link looks like the own-row
    // one, because re-pointing is what the stored link has already had done to
    // it. That mistake is invisible in the collapse's output shape and shows up
    // only as the wrong `applicability` surviving.
    const byPair = new Map<string, { link: L; writtenAgainst: string }>();

    for (const link of links) {
        const requirementId = aliases.toOwnRequirementId.get(link.requirementId);
        // A link on a sibling obligation the requested framework does not
        // declare, dropped so the denominator is never inflated.
        if (!requirementId) continue;

        const key = `${requirementId} ${link.control.id}`;
        const held = byPair.get(key);
        if (held && !replacesHeldLink(link.requirementId, held.writtenAgainst, requirementId)) continue;
        byPair.set(key, { link: { ...link, requirementId }, writtenAgainst: link.requirementId });
    }

    return [...byPair.values()].map((entry) => entry.link);
}

/**
 * True when a link written against `candidate` should replace the one written
 * against `held`, for the same (requirement, control).
 */
function replacesHeldLink(candidate: string, held: string, ownRequirementId: string): boolean {
    if (held === ownRequirementId) return false;
    if (candidate === ownRequirementId) return true;
    return candidate < held;
}
