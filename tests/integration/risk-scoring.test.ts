/**
 * Integration Tests — Risk Scoring Correctness
 *
 * Proves that:
 * 1. calculateRiskScore(4, 5) = 20 (likelihood * impact)
 * 2. Values are clamped to [1, maxScale]
 * 3. getRiskLevel returns correct levels for boundary values
 * 4. generateHeatmapData produces correct matrix
 * 5. Custom maxScale works correctly
 * 6. Edge cases (0, negative, exceeding max) are clamped
 */
import {
    calculateRiskScore,
    getRiskLevel,
    getRiskColor,
    generateHeatmapData,
} from '@/lib/risk-scoring';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

describe('Risk Scoring — calculateRiskScore', () => {
    test('4 * 5 = 20 (standard case)', () => {
        expect(calculateRiskScore(4, 5)).toBe(20);
    });

    test('1 * 1 = 1 (minimum)', () => {
        expect(calculateRiskScore(1, 1)).toBe(1);
    });

    test('5 * 5 = 25 (maximum)', () => {
        expect(calculateRiskScore(5, 5)).toBe(25);
    });

    test('3 * 3 = 9 (default when no values provided)', () => {
        expect(calculateRiskScore(3, 3)).toBe(9);
    });

    test('values are clamped to maxScale (5 by default)', () => {
        // Exceeding 5 gets clamped to 5
        expect(calculateRiskScore(10, 10)).toBe(25); // 5 * 5
        expect(calculateRiskScore(0, 5)).toBe(5);    // 1 * 5 (0 clamped to 1)
        expect(calculateRiskScore(-1, 3)).toBe(3);   // 1 * 3 (negative clamped to 1)
    });

    test('custom maxScale works', () => {
        expect(calculateRiskScore(10, 10, 10)).toBe(100); // 10 * 10
        expect(calculateRiskScore(3, 3, 3)).toBe(9);      // 3 * 3
        expect(calculateRiskScore(5, 5, 3)).toBe(9);       // clamped to 3 * 3
    });

    test('result is always a positive integer', () => {
        for (let l = 0; l <= 7; l++) {
            for (let i = 0; i <= 7; i++) {
                const score = calculateRiskScore(l, i);
                expect(score).toBeGreaterThanOrEqual(1);
                expect(score).toBeLessThanOrEqual(25);
                expect(Number.isInteger(score)).toBe(true);
            }
        }
    });

    test('score updates when likelihood changes', () => {
        const score1 = calculateRiskScore(2, 4);
        const score2 = calculateRiskScore(4, 4);
        expect(score2).toBeGreaterThan(score1);
        expect(score1).toBe(8);  // 2 * 4
        expect(score2).toBe(16); // 4 * 4
    });

    test('score updates when impact changes', () => {
        const score1 = calculateRiskScore(3, 2);
        const score2 = calculateRiskScore(3, 5);
        expect(score2).toBeGreaterThan(score1);
        expect(score1).toBe(6);  // 3 * 2
        expect(score2).toBe(15); // 3 * 5
    });
});

describe('Risk Scoring — getRiskLevel', () => {
    test('score 1 = LOW (<=20% of max)', () => {
        expect(getRiskLevel(1)).toBe('LOW');
    });

    test('score 5 = LOW (20% of 25)', () => {
        expect(getRiskLevel(5)).toBe('LOW');
    });

    test('score 6 = MEDIUM (>20%, <=48%)', () => {
        expect(getRiskLevel(6)).toBe('MEDIUM');
    });

    test('score 12 = MEDIUM (48% of 25)', () => {
        expect(getRiskLevel(12)).toBe('MEDIUM');
    });

    test('score 13 = HIGH (>48%, <=72%)', () => {
        expect(getRiskLevel(13)).toBe('HIGH');
    });

    test('score 18 = HIGH (72% of 25)', () => {
        expect(getRiskLevel(18)).toBe('HIGH');
    });

    test('score 19 = CRITICAL (>72%)', () => {
        expect(getRiskLevel(19)).toBe('CRITICAL');
    });

    test('score 25 = CRITICAL (max)', () => {
        expect(getRiskLevel(25)).toBe('CRITICAL');
    });

    test('custom maxScale 10 — correctly computes levels', () => {
        // maxScore = 100, 20% = 20, 48% = 48, 72% = 72
        expect(getRiskLevel(10, 10)).toBe('LOW');
        expect(getRiskLevel(20, 10)).toBe('LOW');
        expect(getRiskLevel(21, 10)).toBe('MEDIUM');
        expect(getRiskLevel(48, 10)).toBe('MEDIUM');
        expect(getRiskLevel(49, 10)).toBe('HIGH');
        expect(getRiskLevel(72, 10)).toBe('HIGH');
        expect(getRiskLevel(73, 10)).toBe('CRITICAL');
    });
});

describe('Risk Scoring — getRiskColor', () => {
    test('returns correct colors for each level', () => {
        expect(getRiskColor('LOW')).toBe('#22c55e');
        expect(getRiskColor('MEDIUM')).toBe('#f59e0b');
        expect(getRiskColor('HIGH')).toBe('#ef4444');
        expect(getRiskColor('CRITICAL')).toBe('#7c2d12');
    });

    test('returns gray for unknown level', () => {
        expect(getRiskColor('UNKNOWN')).toBe('#6b7280');
        expect(getRiskColor('')).toBe('#6b7280');
    });
});

describe('Risk Scoring — generateHeatmapData', () => {
    test('empty risks → all zeros', () => {
        const matrix = generateHeatmapData([]);
        expect(matrix).toHaveLength(5);
        for (const row of matrix) {
            expect(row).toHaveLength(5);
            expect(row.every((v: number) => v === 0)).toBe(true);
        }
    });

    test('single risk at (3,4) → matrix[2][3] = 1', () => {
        const matrix = generateHeatmapData([{ likelihood: 3, impact: 4 }]);
        expect(matrix[2][3]).toBe(1);
        // All others should be 0
        let total = 0;
        for (const row of matrix) for (const v of row) total += v;
        expect(total).toBe(1);
    });

    test('multiple risks at same position → count accumulates', () => {
        const risks = [
            { likelihood: 2, impact: 3 },
            { likelihood: 2, impact: 3 },
            { likelihood: 2, impact: 3 },
        ];
        const matrix = generateHeatmapData(risks);
        expect(matrix[1][2]).toBe(3);
    });

    test('custom maxScale produces correct matrix size', () => {
        const matrix = generateHeatmapData([], 3);
        expect(matrix).toHaveLength(3);
        for (const row of matrix) expect(row).toHaveLength(3);
    });

    test('distributed risks fill correct cells', () => {
        const risks = [
            { likelihood: 1, impact: 1 },
            { likelihood: 3, impact: 3 },
            { likelihood: 5, impact: 5 },
        ];
        const matrix = generateHeatmapData(risks);
        expect(matrix[0][0]).toBe(1); // (1,1)
        expect(matrix[2][2]).toBe(1); // (3,3)
        expect(matrix[4][4]).toBe(1); // (5,5)
    });
});

describe('Risk Scoring — Integration with usecase', () => {
    test('createRisk usecase uses calculateRiskScore internally', () => {
        // Verify the usecase imports and uses risk-scoring
        const fs = require('fs');
        const path = require('path');
        const content = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/usecases/risk.ts'), 'utf-8'
        ));
        expect(content).toContain("import { calculateRiskScore } from '@/lib/risk-scoring'");
        expect(content).toContain('calculateRiskScore');
    });

    test('risk score is stored as inherentScore and score', () => {
        const fs = require('fs');
        const path = require('path');
        const content = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/usecases/risk.ts'), 'utf-8'
        ));
        expect(content).toContain('inherentScore');
        expect(content).toContain('score: inherentScore');
    });

    test('updateRisk recalculates score when likelihood and impact change', () => {
        const fs = require('fs');
        const path = require('path');
        const content = codeOf(fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/usecases/risk.ts'), 'utf-8'
        ));
        // updateRisk has conditional recalculation
        expect(content).toContain('data.likelihood && data.impact');
        expect(content).toContain('calculateRiskScore(data.likelihood, data.impact');
    });
});
