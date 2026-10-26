/**
 * Which of a framework's requirements a workspace has taken on.
 *
 * A framework that offers more than one pack is cut into options — EU drone
 * operations has one pack per operating subcategory — and a workspace installs
 * the ones it works in. The requirements those packs' templates cite are its
 * SCOPE. The rest belong to options it did not take: not gaps, and not counted
 * by coverage, the readiness report, audit-cycle readiness or the framework
 * tree, each of which lists them as outside the scope instead.
 *
 * Narrowed only when BOTH hold: the framework has more than one pack, and the
 * workspace has installed at least one of them (`TenantFrameworkPack`, written
 * by the pack install). Otherwise every requirement is in scope, which is what
 * every surface showed before the table existed. A single-pack framework is
 * never narrowed: its one pack may leave requirements uncovered on purpose, and
 * those ARE gaps.
 *
 * Membership is by requirement CODE, read off the requirements the chosen
 * packs' templates link. Codes are unique within a framework, and they stay
 * meaningful across the two-representation split
 * (`services/framework-representation-aliases.ts`) where ids do not.
 */
import type { PrismaTx } from '@/lib/db-context';

export type RequirementScope =
    | { kind: 'ALL' }
    | { kind: 'CHOSEN_PACKS'; packKeys: string[]; codes: ReadonlySet<string> };

/** The part of a scope a response carries; the codes stay server-side. */
export type RequirementScopeSummary =
    | { kind: 'ALL' }
    | { kind: 'CHOSEN_PACKS'; packKeys: string[] };

const ALL_REQUIREMENTS: RequirementScope = { kind: 'ALL' };

export async function resolveRequirementScope(
    tdb: PrismaTx,
    tenantId: string,
    frameworkId: string,
): Promise<RequirementScope> {
    const packCount = await tdb.frameworkPack.count({ where: { frameworkId } });
    if (packCount < 2) return ALL_REQUIREMENTS;

    const chosen = await tdb.tenantFrameworkPack.findMany({
        where: { tenantId, frameworkId },
        // One row per pack at most (`@@unique([tenantId, packId])`).
        take: packCount,
        select: {
            pack: {
                select: {
                    key: true,
                    templateLinks: {
                        select: {
                            template: {
                                select: {
                                    requirementLinks: {
                                        select: { requirement: { select: { code: true, frameworkId: true } } },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    });
    if (chosen.length === 0) return ALL_REQUIREMENTS;

    const codes = new Set<string>();
    for (const { pack } of chosen) {
        for (const { template } of pack.templateLinks) {
            for (const { requirement } of template.requirementLinks) {
                // A template may also cite another framework's requirements.
                if (requirement.frameworkId === frameworkId) codes.add(requirement.code);
            }
        }
    }
    return { kind: 'CHOSEN_PACKS', packKeys: chosen.map((c) => c.pack.key).sort(), codes };
}

export function partitionByScope<T extends { code: string }>(
    scope: RequirementScope,
    requirements: readonly T[],
): { inScope: T[]; outOfScope: T[] } {
    if (scope.kind === 'ALL') return { inScope: [...requirements], outOfScope: [] };
    const inScope: T[] = [];
    const outOfScope: T[] = [];
    for (const r of requirements) (scope.codes.has(r.code) ? inScope : outOfScope).push(r);
    return { inScope, outOfScope };
}

export function summariseScope(scope: RequirementScope): RequirementScopeSummary {
    return scope.kind === 'ALL' ? { kind: 'ALL' } : { kind: 'CHOSEN_PACKS', packKeys: scope.packKeys };
}
