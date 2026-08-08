/* eslint-disable @typescript-eslint/no-explicit-any -- standard
 * test-mock pattern; per-line typing has poor cost/benefit ratio. */

/**
 * RQ3-8 — control-roi usecase suite. Pins the load shape (single
 * batched findMany on the portfolio path), the honest-null pass-
 * through, and the bounded ranking.
 */

const mockDb = {
    control: { findFirst: jest.fn(), findMany: jest.fn() },
    // MEASURED→DECLARED reconciliation now runs a batched groupBy for the
    // measured pass rate; an empty result means measured contributes nothing,
    // so ROI falls back to the DECLARED `effectiveness` scalar these cases seed.
    controlTestRun: { groupBy: jest.fn().mockResolvedValue([]) },
} as any;

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDb)),
}));

import { getControlRoi, getBestValueControls } from '@/app-layer/usecases/control';
import { makeRequestContext } from '../helpers/make-context';

const readerCtx = makeRequestContext('READER');

beforeEach(() => {
    jest.clearAllMocks();
});

describe('getControlRoi', () => {
    it('returns an ok verdict when cost + effectiveness + a quantified risk are present', async () => {
        mockDb.control.findFirst.mockResolvedValue({
            id: 'c-1', code: 'AC-1', name: 'MFA',
            annualCost: 10_000,
            effectiveness: 50,
            risks: [
                { risk: { sleAmount: 200_000, aroAmount: 0.5, fairAle: null } }, // ALE = 100k
                { risk: { sleAmount: null, aroAmount: null, fairAle: 60_000 } }, // ALE = 60k
            ],
        });
        const payload = await getControlRoi(readerCtx, 'c-1');
        expect(payload.verdict.ok).toBe(true);
        if (!payload.verdict.ok) return;
        // 0.5 × (100k + 60k) = 80k. ROI = 8.
        expect(payload.verdict.value.aleProtected).toBe(80_000);
        expect(payload.verdict.value.roiMultiple).toBe(8);
    });

    it('returns NO_QUANT_RISKS when no linked risk is quantified', async () => {
        mockDb.control.findFirst.mockResolvedValue({
            id: 'c-1', code: 'AC-1', name: 'MFA',
            annualCost: 10_000,
            effectiveness: 50,
            risks: [
                { risk: { sleAmount: null, aroAmount: null, fairAle: null } },
            ],
        });
        const payload = await getControlRoi(readerCtx, 'c-1');
        expect(payload.verdict).toMatchObject({ ok: false, reason: 'NO_QUANT_RISKS' });
    });

    it('returns NO_COST when annualCost is null — never a fabricated ratio', async () => {
        mockDb.control.findFirst.mockResolvedValue({
            id: 'c-1', code: 'AC-1', name: 'MFA',
            annualCost: null,
            effectiveness: 80,
            risks: [{ risk: { sleAmount: 100_000, aroAmount: 1, fairAle: null } }],
        });
        const payload = await getControlRoi(readerCtx, 'c-1');
        expect(payload.verdict).toMatchObject({ ok: false, reason: 'NO_COST' });
    });
});

describe('getBestValueControls', () => {
    it('issues ONE batched findMany over the controls register', async () => {
        mockDb.control.findMany.mockResolvedValue([]);
        await getBestValueControls(readerCtx, 5);
        expect(mockDb.control.findMany).toHaveBeenCalledTimes(1);
        const q = mockDb.control.findMany.mock.calls[0][0];
        // Bounded shape: `take` is set so a huge tenant cannot DoS
        // the ranking path.
        expect(q.take).toBeGreaterThan(0);
        // Only APPLICABLE / non-deleted controls participate.
        expect(q.where.applicability).toBe('APPLICABLE');
        expect(q.where.deletedAt).toBeNull();
    });

    it('ranks by roi multiple descending and drops un-priced rows (no synthetic zeros)', async () => {
        mockDb.control.findMany.mockResolvedValue([
            {
                id: 'a', code: 'A', name: 'A',
                annualCost: 10_000, effectiveness: 50,
                risks: [{ risk: { sleAmount: 100_000, aroAmount: 1, fairAle: null } }],
            },
            {
                id: 'b', code: 'B', name: 'B',
                annualCost: null, effectiveness: 80,
                risks: [{ risk: { sleAmount: 500_000, aroAmount: 1, fairAle: null } }],
            },
            {
                id: 'c', code: 'C', name: 'C',
                annualCost: 5_000, effectiveness: 90,
                risks: [{ risk: { sleAmount: 50_000, aroAmount: 1, fairAle: null } }],
            },
        ]);
        const rows = await getBestValueControls(readerCtx, 10);
        // c (90% × 50k / 5k = 9) > a (50% × 100k / 10k = 5). b dropped (NO_COST).
        expect(rows.map((r) => r.controlId)).toEqual(['c', 'a']);
        expect(rows[0].roiMultiple).toBe(9);
    });

    it('caps the result at the requested limit (board, not register)', async () => {
        const many = Array.from({ length: 30 }, (_, i) => ({
            id: `c-${i}`, code: null, name: `c-${i}`,
            annualCost: 10_000, effectiveness: 50,
            risks: [{ risk: { sleAmount: (i + 1) * 10_000, aroAmount: 1, fairAle: null } }],
        }));
        mockDb.control.findMany.mockResolvedValue(many);
        const rows = await getBestValueControls(readerCtx, 5);
        expect(rows).toHaveLength(5);
        // Highest ROI = highest ALE; c-29 is the largest.
        expect(rows[0].controlId).toBe('c-29');
    });

    it('clamps a caller-supplied limit to the hard cap (no DoS via giant limit)', async () => {
        const many = Array.from({ length: 30 }, (_, i) => ({
            id: `c-${i}`, code: null, name: `c-${i}`,
            annualCost: 10_000, effectiveness: 50,
            risks: [{ risk: { sleAmount: (i + 1) * 10_000, aroAmount: 1, fairAle: null } }],
        }));
        mockDb.control.findMany.mockResolvedValue(many);
        const rows = await getBestValueControls(readerCtx, 99999);
        expect(rows.length).toBeLessThanOrEqual(25); // BEST_VALUE_HARD_CAP
    });
});
