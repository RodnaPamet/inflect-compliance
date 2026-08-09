/**
 * RQ2-9 — inherent → residual movement arrows for the risk matrix.
 *
 * Extracted from an inline `useMemo` in `RisksClient` so the admission rule
 * can be tested directly. It used to be covered only by
 * `tests/guards/rq2-9-matrix-movement.test.ts`, which regex-matched the
 * enclosing file; that guard was retired in #1800 and the rendered overlay
 * test cannot reach this code, because it takes `movements` as a PROP.
 *
 * THE RULE, and why it is not merely defensive: a risk qualifies only when
 * BOTH decomposed residual dimensions are present. A legacy row carries a
 * rollup `residualScore` and no dimensions — and a score has no cell. 12
 * is 2×6, 3×4, 4×3 and 6×2, so there is no honest destination to draw an
 * arrow to. Admitting such a row means inventing coordinates and drawing a
 * line to a cell the risk was never assessed into, on the one view whose
 * entire claim is "this risk moved from here to there".
 */

/** The fields a movement needs. Structural, so callers keep their own row type. */
export interface MovementCandidate {
    id: string;
    title: string;
    likelihood: number;
    impact: number;
    residualLikelihood?: number | null;
    residualImpact?: number | null;
}

export interface MatrixMovement {
    riskId: string;
    title: string;
    from: { likelihood: number; impact: number };
    to: { likelihood: number; impact: number };
}

export function deriveMatrixMovements(
    risks: readonly MovementCandidate[],
): MatrixMovement[] {
    return risks
        .filter((r) => r.residualLikelihood != null && r.residualImpact != null)
        .map((r) => ({
            riskId: r.id,
            title: r.title,
            from: { likelihood: r.likelihood, impact: r.impact },
            to: {
                likelihood: r.residualLikelihood as number,
                impact: r.residualImpact as number,
            },
        }));
}
