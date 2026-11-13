/**
 * #5080 — recompute the risk scores that were clamped to 5x5.
 *
 * Owner decision 2026-11-13: recompute, audited. The forward fix (#5522) made
 * the scoring path read the tenant's configured grid per axis; this corrects
 * the rows written before it.
 *
 * ## Why this is a correction, not a reassessment
 *
 * The server scored every risk with `tenant.maxRiskScale || 5`, and nothing in
 * `src/` ever wrote that column. So on a 6x6 grid a risk at L6xI6 was stored
 * with likelihood 6, impact 6 and inherentScore 25.
 *
 * The stored likelihood and impact were always correct — a person chose them.
 * Only the DERIVED product was wrong. This recomputes that product from the
 * row's own dimensions and never changes a likelihood, an impact, or anybody's
 * judgement.
 *
 * ## Audited through the score ledger
 *
 * Every change appends a `RiskScoreEvent` in the SAME transaction as the score
 * — that pairing is what `tests/guardrails/risk-score-provenance.test.ts`
 * exists to protect, and a corrected score with no provenance event is exactly
 * what it forbids. The source is `MIGRATION`, the vocabulary the schema already
 * documents for an event with no acting user (`createdByUserId` is nullable:
 * "PLAN/MIGRATION events may have no acting user").
 *
 * No `AuditLog` row: those pin an acting user, a batch correction has none, and
 * inventing one would misattribute the change. The ledger is the score-specific
 * trail and is the honest place for it.
 *
 * The client is a PARAMETER, so this is testable against a real database
 * without a CLI and carries no Prisma import of its own.
 */
import { calculateRiskScore } from '@/lib/risk-scoring';
import { DEFAULT_RISK_MATRIX_CONFIG } from '@/lib/risk-matrix/defaults';

export interface ScoreCorrection {
    readonly riskId: string;
    readonly tenantId: string;
    readonly kind: 'INHERENT' | 'RESIDUAL';
    readonly likelihood: number;
    readonly impact: number;
    readonly from: number;
    readonly to: number;
}

type RiskRow = {
    id: string;
    tenantId: string;
    likelihood: number | null;
    impact: number | null;
    inherentScore: number | null;
    residualLikelihood: number | null;
    residualImpact: number | null;
    residualScore: number | null;
};

/** Narrow enough that the real client and a transaction both satisfy it. */
export interface RecomputeClient {
    riskMatrixConfig: {
        findMany(args: unknown): Promise<
            Array<{ tenantId: string; likelihoodLevels: number; impactLevels: number }>
        >;
    };
    risk: {
        findMany(args: unknown): Promise<RiskRow[]>;
        update(args: unknown): Promise<unknown>;
    };
    riskScoreEvent: { create(args: unknown): Promise<unknown> };
    $transaction<T>(fn: (tx: RecomputeClient) => Promise<T>): Promise<T>;
}

const DEFAULT_SCALE = {
    l: DEFAULT_RISK_MATRIX_CONFIG.likelihoodLevels,
    i: DEFAULT_RISK_MATRIX_CONFIG.impactLevels,
};

const PAGE = 500;

/** Every tenant's grid in ONE read, so the scan is not an N+1 over tenants. */
async function scalesByTenant(db: RecomputeClient): Promise<Map<string, { l: number; i: number }>> {
    const rows = await db.riskMatrixConfig.findMany({
        select: { tenantId: true, likelihoodLevels: true, impactLevels: true },
    });
    return new Map(rows.map((r) => [r.tenantId, { l: r.likelihoodLevels, i: r.impactLevels }]));
}

/** Rows whose stored score disagrees with their OWN dimensions. */
export async function findClampedScores(db: RecomputeClient): Promise<ScoreCorrection[]> {
    const scales = await scalesByTenant(db);
    const out: ScoreCorrection[] = [];
    let cursor: string | undefined;

    // Keyset pagination on id: a corrected row still matches the same filter,
    // so the predicate cannot mark progress and re-reading from the top would
    // return the same page for ever.
    for (;;) {
        const risks = await db.risk.findMany({
            where: { deletedAt: null },
            select: {
                id: true, tenantId: true,
                likelihood: true, impact: true, inherentScore: true,
                residualLikelihood: true, residualImpact: true, residualScore: true,
            },
            orderBy: { id: 'asc' },
            take: PAGE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (risks.length === 0) break;

        for (const r of risks) {
            const scale = scales.get(r.tenantId) ?? DEFAULT_SCALE;

            if (r.likelihood !== null && r.impact !== null && r.inherentScore !== null) {
                const correct = calculateRiskScore(r.likelihood, r.impact, scale.l, scale.i);
                if (correct !== r.inherentScore) {
                    out.push({
                        riskId: r.id, tenantId: r.tenantId, kind: 'INHERENT',
                        likelihood: r.likelihood, impact: r.impact,
                        from: r.inherentScore, to: correct,
                    });
                }
            }

            if (
                r.residualLikelihood !== null && r.residualImpact !== null
                && r.residualScore !== null
            ) {
                const correct = calculateRiskScore(
                    r.residualLikelihood, r.residualImpact, scale.l, scale.i,
                );
                if (correct !== r.residualScore) {
                    out.push({
                        riskId: r.id, tenantId: r.tenantId, kind: 'RESIDUAL',
                        likelihood: r.residualLikelihood, impact: r.residualImpact,
                        from: r.residualScore, to: correct,
                    });
                }
            }
        }

        cursor = risks[risks.length - 1].id;
        if (risks.length < PAGE) break;
    }
    return out;
}

/** One correction, with its ledger event, atomically. */
export async function applyScoreCorrection(
    db: RecomputeClient,
    change: ScoreCorrection,
): Promise<void> {
    await db.$transaction(async (tx) => {
        await tx.risk.update({
            where: { id: change.riskId },
            data: change.kind === 'INHERENT'
                ? { inherentScore: change.to }
                : { residualScore: change.to },
        });
        await tx.riskScoreEvent.create({
            data: {
                tenantId: change.tenantId,
                riskId: change.riskId,
                kind: change.kind,
                likelihood: change.likelihood,
                impact: change.impact,
                score: change.to,
                source: 'MIGRATION',
                justification:
                    `#5080: recomputed from the tenant's configured matrix. The stored score `
                    + `was clamped by Tenant.maxRiskScale, which nothing wrote. `
                    + `${change.from} -> ${change.to}; likelihood and impact unchanged.`,
                createdByUserId: null,
            },
        });
    });
}

export interface RecomputeOutcome {
    readonly found: number;
    readonly applied: number;
    readonly failed: number;
    readonly byTenant: ReadonlyMap<string, number>;
    readonly corrections: readonly ScoreCorrection[];
}

export async function recomputeClampedRiskScores(
    db: RecomputeClient,
    opts: { execute: boolean },
): Promise<RecomputeOutcome> {
    const corrections = await findClampedScores(db);
    const byTenant = new Map<string, number>();
    for (const c of corrections) byTenant.set(c.tenantId, (byTenant.get(c.tenantId) ?? 0) + 1);

    if (!opts.execute) {
        return { found: corrections.length, applied: 0, failed: 0, byTenant, corrections };
    }

    let applied = 0;
    let failed = 0;
    for (const change of corrections) {
        try {
            await applyScoreCorrection(db, change);
            applied++;
        } catch {
            // Counted, not swallowed: the caller reports it and exits non-zero.
            // One unwritable row must not leave the register half-corrected
            // with no report of how far it got.
            failed++;
        }
    }
    return { found: corrections.length, applied, failed, byTenant, corrections };
}
