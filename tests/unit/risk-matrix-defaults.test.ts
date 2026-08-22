/**
 * Unit tests pinning the canonical risk-matrix default — Epic 44.
 *
 * The default is the contract every existing tenant resolves to
 * until an admin customises. A future PR that touched the constant
 * by accident (e.g. shipped a 7×7 default) would break every
 * tenant's UI silently — these tests are the regression guard.
 */

import {
    DEFAULT_BANDS,
    DEFAULT_RISK_MATRIX_CONFIG,
    DEFAULT_IMPACT_LABELS,
    DEFAULT_LIKELIHOOD_LABELS,
} from '@/lib/risk-matrix/defaults';

describe('DEFAULT_RISK_MATRIX_CONFIG', () => {
    it('is the canonical 5×5 shape that pre-Epic-44 UI assumed', () => {
        expect(DEFAULT_RISK_MATRIX_CONFIG.likelihoodLevels).toBe(5);
        expect(DEFAULT_RISK_MATRIX_CONFIG.impactLevels).toBe(5);
        expect(DEFAULT_RISK_MATRIX_CONFIG.axisLikelihoodLabel).toBe('Likelihood');
        expect(DEFAULT_RISK_MATRIX_CONFIG.axisImpactLabel).toBe('Impact');
    });

    it('exposes per-level labels matching the dimension counts', () => {
        // LITERAL ON PURPOSE — do not derive from `likelihoodLevels` /
        // `impactLevels`. These 5s are the claim that the DEFAULT matrix is
        // 5x5, not bookkeeping over the config: deriving them would make the
        // assertion true for any square matrix, including a 3x3 default that
        // nobody meant to ship. See the sweep in #2105 for the
        // bookkeeping-vs-domain-claim rule.
        expect(DEFAULT_RISK_MATRIX_CONFIG.levelLabels.likelihood).toHaveLength(5);
        expect(DEFAULT_RISK_MATRIX_CONFIG.levelLabels.impact).toHaveLength(5);
    });

    it('default likelihood vocabulary is the standard 5-tier scale', () => {
        expect([...DEFAULT_LIKELIHOOD_LABELS]).toEqual([
            'Rare',
            'Unlikely',
            'Possible',
            'Likely',
            'Almost Certain',
        ]);
    });

    it('default impact vocabulary is the standard 5-tier scale', () => {
        expect([...DEFAULT_IMPACT_LABELS]).toEqual([
            'Negligible',
            'Minor',
            'Moderate',
            'Major',
            'Severe',
        ]);
    });

    it('bands cover [1, 25] (the full 5×5 score range) without gaps', () => {
        const sorted = [...DEFAULT_BANDS].sort((a, b) => a.minScore - b.minScore);
        expect(sorted[0].minScore).toBe(1);
        expect(sorted[sorted.length - 1].maxScore).toBe(25);
        for (let i = 1; i < sorted.length; i += 1) {
            expect(sorted[i].minScore).toBe(sorted[i - 1].maxScore + 1);
        }
    });

    it('keeps the legacy Low/Medium/High/Critical 4-band layout', () => {
        expect(DEFAULT_BANDS.map((b) => b.name)).toEqual([
            'Low',
            'Medium',
            'High',
            'Critical',
        ]);
    });

    it('preserves the legacy thresholds 1-4 / 5-9 / 10-14 / 15-25', () => {
        expect(
            DEFAULT_BANDS.map((b) => [b.minScore, b.maxScore] as const),
        ).toEqual([
            [1, 4],
            [5, 9],
            [10, 14],
            [15, 25],
        ]);
    });

    it('every band carries a hex colour', () => {
        for (const band of DEFAULT_BANDS) {
            expect(band.color).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
    });
});
