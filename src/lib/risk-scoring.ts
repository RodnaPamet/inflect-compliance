/**
 * Risk scoring engine — legacy / non-UI consumers.
 *
 * Default: Likelihood (1-5) × Impact (1-5) = Inherent score (1-25).
 * Supports custom max scales per tenant.
 *
 * ## Scope (Epic 44)
 *
 * This module's `getRiskLevel` uses fixed percentage thresholds
 * (≤20% LOW, ≤48% MEDIUM, ≤72% HIGH, else CRITICAL) that pre-date
 * the configurable matrix. It's still consumed by:
 *   - `src/app-layer/usecases/risk.ts`     (server-side score recompute)
 *   - `src/app-layer/ai/risk-assessment/`  (LLM prompt builder + provider)
 *   - `src/app-layer/reports/pdf/`         (PDF risk-register exports)
 *
 * The UI / matrix-rendering path uses
 * `src/lib/risk-matrix/scoring.ts → resolveBandForScore` instead,
 * which reads bands from the tenant's `RiskMatrixConfig` and
 * therefore honours custom band layouts. Future work: collapse the
 * non-UI consumers onto the band-driven helper so a tenant's
 * configured bands flow through to PDFs and AI prompts as well.
 */
export function calculateRiskScore(
    likelihood: number,
    impact: number,
    maxLikelihood: number = 5,
    /**
     * PER AXIS, defaulting to the likelihood cap — #5080.
     *
     * One scalar cannot clamp a non-square matrix: a 6x4 grid with a single
     * cap either admits impact 6 (above its four levels) or clamps likelihood
     * to 4. `RiskMatrixConfig` carries `likelihoodLevels` and `impactLevels`
     * separately and allows 2..10 each, so the server reads both.
     *
     * Defaulted rather than required so every existing two- and three-argument
     * call keeps its exact previous behaviour: with one cap the two axes share
     * it, which is what this function always did.
     */
    maxImpact: number = maxLikelihood
): number {
    const clampedL = Math.max(1, Math.min(maxLikelihood, likelihood));
    const clampedI = Math.max(1, Math.min(maxImpact, impact));
    return clampedL * clampedI;
}

export function getRiskLevel(
    score: number,
    maxScale: number = 5
): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    const maxScore = maxScale * maxScale;
    const pct = score / maxScore;
    if (pct <= 0.2) return 'LOW';
    if (pct <= 0.48) return 'MEDIUM';
    if (pct <= 0.72) return 'HIGH';
    return 'CRITICAL';
}

export function getRiskColor(level: string): string {
    switch (level) {
        case 'LOW': return '#22c55e';
        case 'MEDIUM': return '#f59e0b';
        case 'HIGH': return '#ef4444';
        case 'CRITICAL': return '#7c2d12';
        default: return '#6b7280';
    }
}

/**
 * Generate heatmap data: a 2D matrix of risk counts for each (likelihood, impact) cell.
 */
export function generateHeatmapData(
    risks: Array<{ likelihood: number; impact: number }>,
    maxScale: number = 5
): number[][] {
    const matrix: number[][] = [];
    for (let l = 1; l <= maxScale; l++) {
        matrix[l - 1] = [];
        for (let i = 1; i <= maxScale; i++) {
            matrix[l - 1][i - 1] = risks.filter(
                (r) => r.likelihood === l && r.impact === i
            ).length;
        }
    }
    return matrix;
}
