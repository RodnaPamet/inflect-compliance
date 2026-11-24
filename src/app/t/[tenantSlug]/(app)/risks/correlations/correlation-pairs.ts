/** The correlation matrix's pairs, for the phone list (`page.tsx`). */

/** One pair above the diagonal: row `i`, column `j`, its figure `v`. */
export interface CorrelationPair { i: number; j: number; v: number }

/**
 * Every pair the matrix shows above its diagonal, split into the correlated
 * ones (strongest first, by absolute figure) and the rest. The phone list
 * reads this, so it lists exactly the pairs the grid does.
 */
export function correlationPairs(matrix: number[][]): { correlated: CorrelationPair[]; uncorrelated: CorrelationPair[] } {
    const pairs: CorrelationPair[] = [];
    for (let i = 0; i < matrix.length; i++) {
        for (let j = i + 1; j < matrix.length; j++) pairs.push({ i, j, v: matrix[i]?.[j] ?? 0 });
    }
    return {
        correlated: pairs
            .filter((p) => p.v !== 0)
            .sort((a, b) => Math.abs(b.v) - Math.abs(a.v) || a.i - b.i || a.j - b.j),
        uncorrelated: pairs.filter((p) => p.v === 0),
    };
}
