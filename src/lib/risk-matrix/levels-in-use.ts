/**
 * The highest levels the workspace's risks already use (#4823).
 *
 * A risk keeps the likelihood and impact it was assessed with when the matrix
 * changes shape, so shrinking the grid leaves any risk scored above the new
 * edge with no cell on the heat map. The editor reads this to say how many
 * risks a smaller grid would leave outside it before anybody saves.
 *
 * Each entry is a group of risks, keyed by the highest likelihood and the
 * highest impact each one uses across its current and residual assessments.
 * Pure: no Prisma, so the client editor can import it.
 */

export interface RiskLevelsInUse {
    /** The highest likelihood these risks use (current or residual). */
    likelihood: number;
    /** The highest impact these risks use (current or residual). */
    impact: number;
    /** How many risks share that pair. */
    count: number;
}

/** One row as the database groups risks: current and residual levels. */
export interface RiskLevelGroup {
    likelihood: number;
    impact: number;
    residualLikelihood: number | null;
    residualImpact: number | null;
    count: number;
}

/** Fold the database's groups into one entry per (highest likelihood, highest impact). */
export function foldRiskLevelGroups(groups: readonly RiskLevelGroup[]): RiskLevelsInUse[] {
    const byPair = new Map<string, RiskLevelsInUse>();
    for (const g of groups) {
        const likelihood = Math.max(g.likelihood, g.residualLikelihood ?? 0);
        const impact = Math.max(g.impact, g.residualImpact ?? 0);
        const key = `${likelihood}:${impact}`;
        const entry = byPair.get(key);
        if (entry) entry.count += g.count;
        else byPair.set(key, { likelihood, impact, count: g.count });
    }
    return [...byPair.values()].sort((a, b) => a.likelihood - b.likelihood || a.impact - b.impact);
}

/** How many risks use a likelihood or an impact above a grid of this size. */
export function risksOutsideGrid(
    levels: readonly RiskLevelsInUse[],
    likelihoodLevels: number,
    impactLevels: number,
): number {
    let outside = 0;
    for (const l of levels) {
        if (l.likelihood > likelihoodLevels || l.impact > impactLevels) outside += l.count;
    }
    return outside;
}
