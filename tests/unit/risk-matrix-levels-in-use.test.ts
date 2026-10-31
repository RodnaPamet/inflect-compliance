/**
 * #4823 — the levels the risks already use, which the risk-matrix editor reads
 * to warn before a smaller grid leaves risks with no cell on the heat map.
 */
import { foldRiskLevelGroups, risksOutsideGrid } from '@/lib/risk-matrix/levels-in-use';

describe('foldRiskLevelGroups', () => {
    it('keys each risk by the higher of its current and residual levels', () => {
        expect(
            foldRiskLevelGroups([
                { likelihood: 2, impact: 3, residualLikelihood: 4, residualImpact: 1, count: 2 },
            ]),
        ).toEqual([{ likelihood: 4, impact: 3, count: 2 }]);
    });

    it('reads a missing residual assessment as no higher level', () => {
        expect(
            foldRiskLevelGroups([{ likelihood: 3, impact: 5, residualLikelihood: null, residualImpact: null, count: 1 }]),
        ).toEqual([{ likelihood: 3, impact: 5, count: 1 }]);
    });

    it('adds up groups that end on the same pair', () => {
        expect(
            foldRiskLevelGroups([
                { likelihood: 5, impact: 2, residualLikelihood: null, residualImpact: null, count: 1 },
                { likelihood: 3, impact: 2, residualLikelihood: 5, residualImpact: 1, count: 4 },
            ]),
        ).toEqual([{ likelihood: 5, impact: 2, count: 5 }]);
    });

    it('is empty for a workspace with no risks', () => {
        expect(foldRiskLevelGroups([])).toEqual([]);
    });
});

describe('risksOutsideGrid', () => {
    const levels = [
        { likelihood: 5, impact: 2, count: 2 },
        { likelihood: 2, impact: 4, count: 3 },
        { likelihood: 3, impact: 3, count: 7 },
    ];

    it('counts nothing when the grid holds every level', () => {
        expect(risksOutsideGrid(levels, 5, 5)).toBe(0);
    });

    it('counts a risk once when either level is above the grid', () => {
        expect(risksOutsideGrid(levels, 4, 5)).toBe(2);
        expect(risksOutsideGrid(levels, 5, 3)).toBe(3);
        expect(risksOutsideGrid(levels, 3, 3)).toBe(5);
        expect(risksOutsideGrid(levels, 2, 2)).toBe(12);
    });
});
