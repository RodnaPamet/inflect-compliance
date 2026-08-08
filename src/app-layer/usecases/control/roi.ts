/**
 * RQ3-8 — Mitigation ROI usecases.
 *
 * Two read paths:
 *
 *   getControlRoi(controlId) — single control verdict for the
 *     detail surface. Loads the control's annualCost +
 *     effectiveness + the inherent ALE of every linked risk, then
 *     calls the pure math in `@/lib/control-roi`.
 *
 *   getBestValueControls(limit) — portfolio ranking for the
 *     controls page. Single batched fetch (`findMany` over all
 *     applicable controls + their RiskControl join + each linked
 *     risk's ALE inputs), then in-memory rank.
 *
 * The portfolio loader is bounded by `limit` (the caller passes
 * 5–10) so the "Best-value controls" widget stays a leaderboard,
 * not a full register dump.
 */
import { RequestContext } from '../../types';
import { assertCanRead } from '../../policies/common';
import { runInTenantContext } from '@/lib/db-context';
import { notFound } from '@/lib/errors/types';
import { resolveALE } from '../fair-calculator';
import {
    computeControlRoi,
    rankByRoi,
    type ControlRoiVerdict,
} from '@/lib/control-roi';
import { computeControlEffectivenessMap } from './test-plans';

const BEST_VALUE_HARD_CAP = 25;

/** Where the effectiveness driving ROI came from — measured test history wins,
 *  else the declared scalar, else nothing. Mirrors the residual suggestion. */
export type EffectivenessSource = 'MEASURED' | 'DECLARED' | null;

export interface ControlRoiPayload {
    controlId: string;
    code: string | null;
    name: string;
    annualCost: number | null;
    effectiveness: number | null;
    effectivenessSource: EffectivenessSource;
    verdict: ControlRoiVerdict;
}

/** Risks are quantified via FAIR or SLE×ARO; we read both. */
interface RiskAleInputs {
    sleAmount: number | null;
    aroAmount: number | null;
    fairAle: number | null;
}

function aleFromRisk(r: RiskAleInputs): number | null {
    return resolveALE({
        fairAle: r.fairAle,
        sleAmount: r.sleAmount,
        aroAmount: r.aroAmount,
    });
}

export async function getControlRoi(
    ctx: RequestContext,
    controlId: string,
): Promise<ControlRoiPayload> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const control = await db.control.findFirst({
            where: { id: controlId, tenantId: ctx.tenantId },
            select: {
                id: true,
                code: true,
                name: true,
                annualCost: true,
                effectiveness: true,
                risks: {
                    select: {
                        risk: {
                            select: {
                                sleAmount: true,
                                aroAmount: true,
                                fairAle: true,
                            },
                        },
                    },
                },
            },
        });
        if (!control) throw notFound('Control not found');

        // MEASURED beats DECLARED — the same reconciliation the residual
        // suggestion uses. The measured pass rate (THE canonical signal) drives
        // ROI when there's test history; otherwise the editable declared
        // Control.effectiveness scalar is the fallback. (Previously ROI read
        // only the declared scalar, which nothing wrote → always NO_EFFECTIVENESS.)
        const measured = (await computeControlEffectivenessMap(db, ctx.tenantId, [control.id])).get(control.id);
        const useMeasured = !!measured && measured.total > 0 && measured.passRate !== null;
        const effectiveness = useMeasured ? measured!.passRate : control.effectiveness;
        const effectivenessSource: EffectivenessSource = useMeasured
            ? 'MEASURED'
            : control.effectiveness !== null
              ? 'DECLARED'
              : null;

        const riskAles = control.risks.map((rc) => aleFromRisk(rc.risk));
        const verdict = computeControlRoi({
            annualCost: control.annualCost,
            effectiveness,
            riskAles,
        });

        return {
            controlId: control.id,
            code: control.code,
            name: control.name,
            annualCost: control.annualCost,
            effectiveness,
            effectivenessSource,
            verdict,
        };
    });
}

export interface BestValueRow {
    controlId: string;
    code: string | null;
    name: string;
    annualCost: number;
    effectiveness: number;
    /** Where `effectiveness` came from — a MEASURED test pass rate or a
     *  DECLARED analyst estimate. Carried so a leaderboard RANK discloses
     *  whether it rests on measured tests or a declared guess (the same
     *  provenance the single-control ROI card shows). */
    effectivenessSource: EffectivenessSource;
    aleProtected: number;
    roiMultiple: number;
    quantifiedRiskCount: number;
    linkedRiskCount: number;
}

export async function getBestValueControls(
    ctx: RequestContext,
    limit: number,
): Promise<BestValueRow[]> {
    assertCanRead(ctx);
    const bounded = Math.max(1, Math.min(limit, BEST_VALUE_HARD_CAP));

    return runInTenantContext(ctx, async (db) => {
        // ONE batched load over all eligible controls — the rank
        // function drops un-priced / un-quantified rows so an
        // expensive `WHERE annualCost IS NOT NULL` filter buys
        // nothing and shrinks the "you have controls but nothing
        // qualifies" observability window.
        const controls = await db.control.findMany({
            where: {
                tenantId: ctx.tenantId,
                deletedAt: null,
                applicability: 'APPLICABLE',
            },
            select: {
                id: true,
                code: true,
                name: true,
                annualCost: true,
                effectiveness: true,
                risks: {
                    select: {
                        risk: {
                            select: {
                                sleAmount: true,
                                aroAmount: true,
                                fairAle: true,
                            },
                        },
                    },
                },
            },
            take: 500,
        });

        // MEASURED beats DECLARED for every ranked control (one batched
        // groupBy for the whole set — no N+1), same reconciliation as the
        // single-control ROI + the residual suggestion.
        const effMap = await computeControlEffectivenessMap(db, ctx.tenantId, controls.map((c) => c.id));

        const items = controls.map((c) => {
            const m = effMap.get(c.id);
            const useMeasured = !!m && m.total > 0 && m.passRate !== null;
            const effectiveness = useMeasured ? m!.passRate : c.effectiveness;
            // Same MEASURED-beats-DECLARED reconciliation as the single-control
            // path above — captured here so the rank can disclose its provenance.
            const effectivenessSource: EffectivenessSource = useMeasured
                ? 'MEASURED'
                : c.effectiveness !== null
                  ? 'DECLARED'
                  : null;
            return {
                control: { ...c, effectiveness, effectivenessSource },
                verdict: computeControlRoi({
                    annualCost: c.annualCost,
                    effectiveness,
                    riskAles: c.risks.map((rc) => aleFromRisk(rc.risk)),
                }),
            };
        });

        return rankByRoi(items, bounded).map(({ control, result }) => ({
            controlId: control.id,
            code: control.code,
            name: control.name,
            // After rankByRoi the verdict is ok, so these are non-null.
            annualCost: control.annualCost as number,
            effectiveness: control.effectiveness as number,
            effectivenessSource: control.effectivenessSource,
            aleProtected: result.aleProtected,
            roiMultiple: result.roiMultiple,
            quantifiedRiskCount: result.quantifiedRiskCount,
            linkedRiskCount: result.linkedRiskCount,
        }));
    });
}
