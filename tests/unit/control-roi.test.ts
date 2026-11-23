/**
 * RQ3-8 — Mitigation ROI pure-math suite.
 *
 * Pins the honest-null contract (no fabricated zeros), the
 * effectiveness lever, and the ranking bound.
 */
import {
    computeControlRoi,
    rankByRoi,
    describeRoiGap,
} from '@/lib/control-roi';

describe('computeControlRoi — honest-null contract', () => {
    it('a null annual cost returns NO_COST (never a fabricated 0 or ∞)', () => {
        const v = computeControlRoi({
            annualCost: null,
            effectiveness: 80,
            riskAles: [100_000],
        });
        expect(v).toEqual({ ok: false, reason: 'NO_COST', linkedRiskCount: 1 });
    });

    it('a zero or negative annual cost is also NO_COST (no divide-by-zero)', () => {
        expect(computeControlRoi({ annualCost: 0, effectiveness: 80, riskAles: [100_000] }))
            .toMatchObject({ ok: false, reason: 'NO_COST' });
        expect(computeControlRoi({ annualCost: -5_000, effectiveness: 80, riskAles: [100_000] }))
            .toMatchObject({ ok: false, reason: 'NO_COST' });
    });

    it('a null effectiveness returns NO_EFFECTIVENESS — not a 0 lever', () => {
        const v = computeControlRoi({
            annualCost: 25_000,
            effectiveness: null,
            riskAles: [100_000],
        });
        expect(v).toEqual({ ok: false, reason: 'NO_EFFECTIVENESS', linkedRiskCount: 1 });
    });

    it('zero linked risks → NO_QUANT_RISKS (no fake ranking)', () => {
        const v = computeControlRoi({ annualCost: 25_000, effectiveness: 80, riskAles: [] });
        expect(v).toEqual({ ok: false, reason: 'NO_QUANT_RISKS', linkedRiskCount: 0 });
    });

    it('linked but ALL un-quantified risks → NO_QUANT_RISKS (no fabrication)', () => {
        const v = computeControlRoi({
            annualCost: 25_000,
            effectiveness: 80,
            riskAles: [null, null, null],
        });
        expect(v).toEqual({ ok: false, reason: 'NO_QUANT_RISKS', linkedRiskCount: 3 });
    });
});

describe('computeControlRoi — the math', () => {
    it('roi = effectiveness × inherentAle / annualCost on one quantified risk', () => {
        const v = computeControlRoi({
            annualCost: 25_000,
            effectiveness: 80,
            riskAles: [100_000],
        });
        expect(v.ok).toBe(true);
        if (!v.ok) return;
        expect(v.value.aleProtected).toBe(80_000); // 100k × 0.8
        expect(v.value.roiMultiple).toBe(3.2);     // 80k / 25k
        expect(v.value.quantifiedRiskCount).toBe(1);
        expect(v.value.linkedRiskCount).toBe(1);
    });

    it('sums protected ALE across quantified risks; skips nulls without inflating', () => {
        const v = computeControlRoi({
            annualCost: 10_000,
            effectiveness: 50,
            riskAles: [100_000, null, 60_000, null],
        });
        expect(v.ok).toBe(true);
        if (!v.ok) return;
        // 0.5 × (100k + 60k) = 80k. ROI = 80k / 10k = 8.
        expect(v.value.aleProtected).toBe(80_000);
        expect(v.value.roiMultiple).toBe(8);
        expect(v.value.quantifiedRiskCount).toBe(2);
        expect(v.value.linkedRiskCount).toBe(4);
    });

    it('clamps effectiveness to [0,100] — a bad row never escapes the model', () => {
        const high = computeControlRoi({ annualCost: 10_000, effectiveness: 150, riskAles: [100_000] });
        const low = computeControlRoi({ annualCost: 10_000, effectiveness: -20, riskAles: [100_000] });
        expect(high.ok).toBe(true);
        if (high.ok) expect(high.value.roiMultiple).toBe(10); // clamped to 100 → 100k/10k
        expect(low.ok).toBe(true);
        if (low.ok) {
            expect(low.value.roiMultiple).toBe(0); // clamped to 0 → 0/10k
            expect(low.value.aleProtected).toBe(0);
        }
    });
});

describe('rankByRoi', () => {
    it('only verdicts that are ok participate in the ranking', () => {
        const items = [
            {
                control: { id: 'a' },
                verdict: computeControlRoi({ annualCost: 10_000, effectiveness: 50, riskAles: [100_000] }),
            },
            {
                control: { id: 'b' },
                verdict: computeControlRoi({ annualCost: null, effectiveness: 80, riskAles: [200_000] }),
            },
            {
                control: { id: 'c' },
                verdict: computeControlRoi({ annualCost: 5_000, effectiveness: 90, riskAles: [50_000] }),
            },
        ];
        const ranked = rankByRoi(items, 10);
        expect(ranked.map((r) => (r.control as { id: string }).id)).toEqual(['c', 'a']);
        // 'b' has NO_COST → dropped, not slotted at the bottom with a synthetic 0.
    });

    it('caps to the requested limit (board view is a leaderboard, not a register)', () => {
        const items = Array.from({ length: 20 }, (_, i) => ({
            control: { id: `c-${i}` },
            verdict: computeControlRoi({
                annualCost: 10_000,
                effectiveness: 50,
                riskAles: [(i + 1) * 10_000],
            }),
        }));
        const ranked = rankByRoi(items, 5);
        expect(ranked).toHaveLength(5);
        // Highest ROI first.
        expect((ranked[0].control as { id: string }).id).toBe('c-19');
    });
});

describe('describeRoiGap', () => {
    it.each([
        ['NO_COST', 0, 'noCost'],
        ['NO_EFFECTIVENESS', 1, 'noEffectiveness'],
        ['NO_QUANT_RISKS', 0, 'linkRiskFirst'],
        ['NO_QUANT_RISKS', 2, 'quantifyRisks'],
    ] as const)('reason=%s linkedCount=%d → %s', (reason, linkedRiskCount, key) => {
        expect(describeRoiGap({ ok: false, reason, linkedRiskCount })).toBe(key);
    });
});
