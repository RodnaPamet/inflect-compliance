/**
 * The tenant's per-axis matrix scale, read inside a caller's transaction —
 * #5080.
 *
 * ═══ WHY THIS IS IN `lib/risk-matrix/` AND NOT THE USECASE ═══
 *
 * It takes the client as a PARAMETER, so it needs no Prisma import of its own
 * — and must not acquire one. Living in `usecases/risk-matrix-config.ts` put
 * `rls-middleware` → `lib/prisma.ts` into the import chain of every module
 * that wanted the scale, which broke `risk-usecase.test.ts` outright: that
 * suite mocks `@/lib/soft-delete` partially, so building the real extended
 * client at import time threw `withSoftDeleteExtension is not a function`
 * before a single test ran. A scale reader is a pure projection of two
 * columns; it belongs beside the defaults it falls back to.
 *
 * Only the LEVELS. Banding is resolved separately from the config's own
 * `bands` by `resolveBandForScore` — nothing about bands belongs in computing
 * a score, which is a product of two capped axes.
 *
 * This replaces `Tenant.maxRiskScale`, which nothing in `src/` has ever
 * written (only a staging seed, hardcoded 5) and which cannot express a
 * non-square grid anyway.
 */
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

export interface RiskMatrixScale {
    readonly likelihoodLevels: number;
    readonly impactLevels: number;
}

/** A client narrow enough that any Prisma client or transaction satisfies it. */
interface ConfigReader {
    riskMatrixConfig: {
        findUnique(args: {
            where: { tenantId: string };
            select: { likelihoodLevels: true; impactLevels: true };
        }): Promise<{ likelihoodLevels: number; impactLevels: number } | null>;
    };
}

export async function readRiskMatrixScale(
    db: ConfigReader,
    tenantId: string,
): Promise<RiskMatrixScale> {
    const row = await db.riskMatrixConfig.findUnique({
        where: { tenantId },
        select: { likelihoodLevels: true, impactLevels: true },
    });
    // No row means the tenant has never saved a matrix, which is the
    // documented default grid — not "no limit" and not 5x5 by accident.
    return (
        row ?? {
            likelihoodLevels: DEFAULT_RISK_MATRIX_CONFIG.likelihoodLevels,
            impactLevels: DEFAULT_RISK_MATRIX_CONFIG.impactLevels,
        }
    );
}
