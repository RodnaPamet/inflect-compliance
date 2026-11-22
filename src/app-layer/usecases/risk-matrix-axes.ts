/**
 * The bounds a risk score is computed on: the tenant's own matrix (#5080).
 *
 * Every server-side score used to clamp each axis to `Tenant.maxRiskScale`.
 * Nothing in the product writes that column, so it was 5 for every tenant,
 * while the matrix editor allows 2 to 10 levels per axis and the risk forms
 * offer as many. On a 6x6 matrix a risk assessed at 6x6 was stored as 25 while
 * the form showed 36, and every reader of the stored score (register, heat
 * map band, KPIs, ledger, reports) read the clamped one.
 *
 * Owner decision (2026-11-13): clamp each axis to the tenant's
 * `RiskMatrixConfig` levels; `Tenant.maxRiskScale` is no longer the bound.
 * A tenant with no saved config resolves to the default matrix, as the risks
 * page does.
 *
 * Takes the caller's client so it runs inside the caller's tenant context and
 * transaction; it performs no authorization of its own.
 */
import type { PrismaTx } from '@/lib/db-context';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

export interface RiskMatrixAxes {
    readonly likelihoodLevels: number;
    readonly impactLevels: number;
}

export async function readRiskMatrixAxes(db: PrismaTx, tenantId: string): Promise<RiskMatrixAxes> {
    const row = await db.riskMatrixConfig.findUnique({
        where: { tenantId },
        select: { likelihoodLevels: true, impactLevels: true },
    });
    return {
        likelihoodLevels: row?.likelihoodLevels ?? DEFAULT_RISK_MATRIX_CONFIG.likelihoodLevels,
        impactLevels: row?.impactLevels ?? DEFAULT_RISK_MATRIX_CONFIG.impactLevels,
    };
}

/** The smaller axis: a single scale on which every value fits both axes. */
export function smallerAxis(axes: RiskMatrixAxes): number {
    return Math.min(axes.likelihoodLevels, axes.impactLevels);
}

/** The larger axis: the one bound a single-scale display can be given. */
export function largerAxis(axes: RiskMatrixAxes): number {
    return Math.max(axes.likelihoodLevels, axes.impactLevels);
}
