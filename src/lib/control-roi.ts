/**
 * RQ3-8 — Mitigation ROI (pure math).
 *
 * The decision-layer question every security program eventually
 * faces: "what does €1 of control buy?" This module turns a
 * control's declared effectiveness + its linked risks' quantified
 * ALE + its annual cost into a defensible €/€ ratio.
 *
 * Model — per linked risk where the risk carries a quantified ALE:
 *
 *   aleProtected_r = inherentAle_r × (effectiveness / 100)
 *
 * Total protected = Σ aleProtected_r over the participating linked
 * risks. ROI multiple = totalProtected / annualCost.
 *
 * The model is deliberately simple. It values the control as if it
 * were applied at its declared effectiveness on each quantified
 * linked risk — a per-control valuation, not a portfolio simulation.
 * That keeps the comparison across controls fair (no double-counting
 * from layering) and the number explainable on the surface ("X% of
 * Y risks' ALE divided by your annual cost").
 *
 * Honest-null is load-bearing: if the control has no cost, or no
 * effectiveness signal, or NO linked risk is quantified, the result
 * is `null` with a typed `reason` — never zero, never a fabricated
 * point estimate. The ratchet at
 * `tests/guards/rq3-8-mitigation-roi.test.ts` locks the contract.
 */

export type ControlRoiReason =
    | 'NO_COST'           // annualCost is null / ≤ 0
    | 'NO_EFFECTIVENESS'  // effectiveness is null
    | 'NO_QUANT_RISKS';   // every linked risk lacks an ALE

export interface ControlRoiInputs {
    /** Currency-unit annual cost. null / 0 → NO_COST. */
    annualCost: number | null;
    /** 0..100 declaration. null → NO_EFFECTIVENESS. */
    effectiveness: number | null;
    /** ALE per linked risk; null entries are unquantified and skipped. */
    riskAles: (number | null)[];
}

export interface ControlRoiResult {
    /** Sum of (inherentAle × effectiveness/100) over QUANTIFIED risks. */
    aleProtected: number;
    /** aleProtected / annualCost. */
    roiMultiple: number;
    /** How many of the linked risks contributed to the math. */
    quantifiedRiskCount: number;
    /** Total linked risks (quantified + un-quantified). */
    linkedRiskCount: number;
}

export type ControlRoiVerdict =
    | { ok: true; value: ControlRoiResult }
    | { ok: false; reason: ControlRoiReason; linkedRiskCount: number };

/**
 * Pure ROI verdict. Returns ok:false with a typed reason instead of
 * a fabricated zero when any input is missing.
 */
export function computeControlRoi(inputs: ControlRoiInputs): ControlRoiVerdict {
    const linkedRiskCount = inputs.riskAles.length;

    if (inputs.annualCost === null || inputs.annualCost <= 0) {
        return { ok: false, reason: 'NO_COST', linkedRiskCount };
    }
    if (inputs.effectiveness === null) {
        return { ok: false, reason: 'NO_EFFECTIVENESS', linkedRiskCount };
    }

    const quantified = inputs.riskAles.filter(
        (ale): ale is number => ale !== null && Number.isFinite(ale) && ale > 0,
    );
    if (quantified.length === 0) {
        return { ok: false, reason: 'NO_QUANT_RISKS', linkedRiskCount };
    }

    const eff = Math.min(Math.max(inputs.effectiveness, 0), 100) / 100;
    const aleProtected = quantified.reduce((sum, ale) => sum + ale * eff, 0);
    const roiMultiple = aleProtected / inputs.annualCost;

    return {
        ok: true,
        value: {
            aleProtected,
            roiMultiple,
            quantifiedRiskCount: quantified.length,
            linkedRiskCount,
        },
    };
}

/**
 * Sort a set of controls by ROI multiple, descending. Controls
 * without an ok verdict drop OUT of the ranking — never sorted in
 * with a synthetic zero, which would falsely rank an un-quantified
 * control beside a real one.
 *
 * Bounded by `limit` — the "best-value" widget is a leaderboard, not
 * a full register.
 */
export function rankByRoi<T>(
    items: { control: T; verdict: ControlRoiVerdict }[],
    limit: number,
): { control: T; result: ControlRoiResult }[] {
    return items
        .filter((i): i is { control: T; verdict: { ok: true; value: ControlRoiResult } } => i.verdict.ok)
        .map((i) => ({ control: i.control, result: i.verdict.value }))
        .sort((a, b) => b.result.roiMultiple - a.result.roiMultiple)
        .slice(0, limit);
}

/** The nudge a non-OK verdict shows, as a key under `controls.roi.gap`. */
export type RoiGapMessageKey = 'noCost' | 'noEffectiveness' | 'linkRiskFirst' | 'quantifyRisks';

/**
 * Which nudge a non-OK verdict earns. Used by the UI's honest-null
 * affordances, which render it through the catalog
 * (`controls.roi.gap.<key>`) so it reads in the viewer's language — this
 * module is shared with the server and holds no copy of its own.
 */
export function describeRoiGap(verdict: { ok: false; reason: ControlRoiReason; linkedRiskCount: number }): RoiGapMessageKey {
    switch (verdict.reason) {
        case 'NO_COST':
            return 'noCost';
        case 'NO_EFFECTIVENESS':
            return 'noEffectiveness';
        case 'NO_QUANT_RISKS':
            return verdict.linkedRiskCount === 0 ? 'linkRiskFirst' : 'quantifyRisks';
    }
}
