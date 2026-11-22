/**
 * Each axis of a risk score is bounded by its own matrix dimension (#5080).
 */
import { calculateRiskScore } from '@/lib/risk-scoring';
import { suggestResidual } from '@/lib/risk-residual';
import { readRiskMatrixAxes, smallerAxis, largerAxis } from '@/app-layer/usecases/risk-matrix-axes';

describe('risk scores on a non-square matrix', () => {
    it('clamps likelihood and impact to their own levels', () => {
        // 3 likelihood levels x 6 impact levels.
        expect(calculateRiskScore(5, 6, 3, 6)).toBe(18);
        expect(calculateRiskScore(2, 9, 3, 6)).toBe(12);
    });

    it('keeps the square behaviour when only one bound is given', () => {
        expect(calculateRiskScore(6, 6, 5)).toBe(25);
        expect(calculateRiskScore(6, 6, 6)).toBe(36);
    });

    it('bounds a residual suggestion per axis', () => {
        const s = suggestResidual(3, 6, { likelihoodReduction: 0, impactReduction: 0 }, 3, 6);
        expect(s).toMatchObject({ residualLikelihood: 3, residualImpact: 6, residualScore: 18 });
    });
});

describe('readRiskMatrixAxes', () => {
    const dbWith = (row: unknown) =>
        ({ riskMatrixConfig: { findUnique: jest.fn().mockResolvedValue(row) } }) as never;

    it('reads the saved levels', async () => {
        await expect(readRiskMatrixAxes(dbWith({ likelihoodLevels: 4, impactLevels: 7 }), 't1')).resolves.toEqual({
            likelihoodLevels: 4,
            impactLevels: 7,
        });
    });

    it('falls back to the default 5x5 when nothing is saved', async () => {
        await expect(readRiskMatrixAxes(dbWith(null), 't1')).resolves.toEqual({ likelihoodLevels: 5, impactLevels: 5 });
    });

    it('names the smaller and larger axis', () => {
        expect(smallerAxis({ likelihoodLevels: 4, impactLevels: 7 })).toBe(4);
        expect(largerAxis({ likelihoodLevels: 4, impactLevels: 7 })).toBe(7);
    });
});
