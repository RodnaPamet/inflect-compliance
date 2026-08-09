/**
 * RQ2-9 — which risks may draw an inherent → residual movement arrow.
 *
 * WHY THIS EXISTS: the rule lived in an inline `useMemo` in `RisksClient`
 * and was covered only by `tests/guards/rq2-9-matrix-movement.test.ts`,
 * which regex-matched the enclosing file. That guard was retired in #1800
 * and this was logged as an explicit coverage gap rather than dropped
 * silently — `tests/rendered/risk-matrix-movement.test.tsx` covers the
 * overlay, but it receives `movements` as a PROP, so it never exercises
 * the derivation that decides what goes in.
 *
 * THE RULE IS NOT DEFENSIVE PADDING. A legacy risk carries a rollup
 * `residualScore` and no decomposed dimensions — and a score has no cell.
 * 12 is 2×6, 3×4, 4×3 and 6×2. Admitting such a row means inventing
 * coordinates and drawing an arrow into a cell the risk was never assessed
 * into, on the one view whose whole claim is "this risk moved from here to
 * there". Silently wrong, and wrong in the direction of false confidence.
 */
import {
    deriveMatrixMovements,
    type MovementCandidate,
} from '@/app/t/[tenantSlug]/(app)/risks/_shared/matrix-movements';

const risk = (over: Partial<MovementCandidate> = {}): MovementCandidate => ({
    id: 'r1',
    title: 'A risk',
    likelihood: 4,
    impact: 5,
    residualLikelihood: 2,
    residualImpact: 3,
    ...over,
});

describe('deriveMatrixMovements', () => {
    it('maps a fully-assessed risk from its inherent cell to its residual cell', () => {
        expect(deriveMatrixMovements([risk()])).toEqual([
            {
                riskId: 'r1',
                title: 'A risk',
                from: { likelihood: 4, impact: 5 },
                to: { likelihood: 2, impact: 3 },
            },
        ]);
    });

    it('excludes a legacy row that has only a rollup residual score', () => {
        // The case the rule exists for: residualScore present, dimensions
        // absent. There is no destination cell to draw to.
        const legacy = risk({ residualLikelihood: null, residualImpact: null });
        expect(deriveMatrixMovements([legacy])).toEqual([]);
    });

    it.each([
        ['likelihood missing', { residualLikelihood: null }],
        ['impact missing', { residualImpact: null }],
        ['likelihood undefined', { residualLikelihood: undefined }],
        ['impact undefined', { residualImpact: undefined }],
    ])('excludes a half-assessed row (%s)', (_label, over) => {
        // BOTH dimensions are required. One alone still has no cell — and a
        // `!= null` check on only one field is the obvious way to get this
        // subtly wrong.
        expect(deriveMatrixMovements([risk(over as Partial<MovementCandidate>)])).toEqual([]);
    });

    it('keeps a residual of zero — 0 is a value, not an absence', () => {
        // `!r.residualLikelihood` would drop this; `!= null` keeps it. The
        // distinction matters because a residual driven to the bottom of
        // the scale is exactly the movement worth showing.
        const moved = deriveMatrixMovements([
            risk({ residualLikelihood: 0, residualImpact: 0 }),
        ]);
        expect(moved).toHaveLength(1);
        expect(moved[0].to).toEqual({ likelihood: 0, impact: 0 });
    });

    it('admits a risk that has not moved (same cell)', () => {
        // Whether to DRAW a same-cell arrow is the overlay's decision — it
        // skips them — not this function's. Filtering here as well would
        // split one rule across two layers.
        const stationary = risk({ residualLikelihood: 4, residualImpact: 5 });
        expect(deriveMatrixMovements([stationary])).toHaveLength(1);
    });

    it('preserves input order and admits only the qualifying rows', () => {
        const out = deriveMatrixMovements([
            risk({ id: 'a', title: 'first' }),
            risk({ id: 'b', title: 'legacy', residualLikelihood: null, residualImpact: null }),
            risk({ id: 'c', title: 'third' }),
        ]);
        expect(out.map((m) => m.riskId)).toEqual(['a', 'c']);
    });

    it('returns an empty list for an empty register', () => {
        expect(deriveMatrixMovements([])).toEqual([]);
    });
});
