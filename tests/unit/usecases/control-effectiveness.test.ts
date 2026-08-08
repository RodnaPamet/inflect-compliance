/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `computeControlEffectivenessMap` (Audit S2, 2026-05-22).
 *
 * Rolling pass-rate metric over a configurable window. Aggregates COMPLETED
 * runs grouped by `result` (PASS / FAIL / INCONCLUSIVE) and returns the
 * percentage with the count breakdown.
 *
 * PR-R — the `getControlEffectiveness(ctx, controlId)` gated single-control
 * wrapper was removed (zero prod callers). These tests now exercise the live
 * `computeControlEffectivenessMap(db, tenantId, controlIds[])` directly; the
 * read-permission gate lives at the real call sites (control-roi, control/health,
 * risk-residual-suggestion), not on this lower-level batched query.
 */
const tenantDb: any = {
    controlTestRun: { groupBy: jest.fn() },
};

import { computeControlEffectivenessMap } from '@/app-layer/usecases/control';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    tenantDb.controlTestRun.groupBy.mockReset();
});

const ctx = makeRequestContext('READER');
const effectivenessFor = async (controlId: string, windowDays?: number) => {
    const map = await computeControlEffectivenessMap(tenantDb, ctx.tenantId, [controlId], windowDays);
    return map.get(controlId)!;
};

describe('computeControlEffectivenessMap', () => {
    // PR-R — the read gate moved to the call sites; this lower-level batched
    // query is intentionally ungated, so there is no assertCanReadTests test here.

    it('returns passRate: null when no completed runs in window', async () => {
        tenantDb.controlTestRun.groupBy.mockResolvedValueOnce([]);
        const out = await effectivenessFor('c-1');
        expect(out).toEqual({
            controlId: 'c-1',
            passRate: null,
            total: 0,
            scored: 0,
            passes: 0,
            fails: 0,
            inconclusive: 0,
            windowDays: 90,
        });
    });

    it('excludes INCONCLUSIVE from the pass-rate denominator (PR-P)', async () => {
        // A no-verdict (INCONCLUSIVE) run must NOT drag the pass-rate down.
        // `total` still counts every completed run (for display), but the
        // pass-rate denominator is verdict-producing runs only (`scored`).
        // 7 PASS + 2 FAIL + 1 INCONCLUSIVE → 7/9, not 7/10.
        tenantDb.controlTestRun.groupBy.mockResolvedValueOnce([
            { controlId: 'c-1', result: 'PASS', _count: { _all: 7 } },
            { controlId: 'c-1', result: 'FAIL', _count: { _all: 2 } },
            { controlId: 'c-1', result: 'INCONCLUSIVE', _count: { _all: 1 } },
        ]);
        const out = await effectivenessFor('c-1');
        expect(out.passes).toBe(7);
        expect(out.fails).toBe(2);
        expect(out.inconclusive).toBe(1);
        expect(out.total).toBe(10);   // all completed runs
        expect(out.scored).toBe(9);   // PASS + FAIL only
        expect(out.passRate).toBe(78); // 7/9 = 77.8 → 78 (INCONCLUSIVE excluded)
    });

    it('all-INCONCLUSIVE window → passRate null (no verdict to score)', async () => {
        tenantDb.controlTestRun.groupBy.mockResolvedValueOnce([
            { controlId: 'c-1', result: 'INCONCLUSIVE', _count: { _all: 3 } },
        ]);
        const out = await effectivenessFor('c-1');
        expect(out.total).toBe(3);
        expect(out.scored).toBe(0);
        expect(out.passRate).toBeNull();
    });

    it('all PASS → passRate 100', async () => {
        tenantDb.controlTestRun.groupBy.mockResolvedValueOnce([
            { controlId: 'c-1', result: 'PASS', _count: { _all: 5 } },
        ]);
        const out = await effectivenessFor('c-1');
        expect(out.passRate).toBe(100);
    });

    it('no PASS → passRate 0', async () => {
        tenantDb.controlTestRun.groupBy.mockResolvedValueOnce([
            { controlId: 'c-1', result: 'FAIL', _count: { _all: 3 } },
            { controlId: 'c-1', result: 'INCONCLUSIVE', _count: { _all: 1 } },
        ]);
        const out = await effectivenessFor('c-1');
        expect(out.passRate).toBe(0);
    });

    it('rounds the percentage to the nearest integer', async () => {
        tenantDb.controlTestRun.groupBy.mockResolvedValueOnce([
            { controlId: 'c-1', result: 'PASS', _count: { _all: 2 } },
            { controlId: 'c-1', result: 'FAIL', _count: { _all: 1 } },
        ]);
        const out = await effectivenessFor('c-1');
        // 2/3 = 66.66… → 67
        expect(out.passRate).toBe(67);
    });

    it('respects the windowDays option (custom value surfaces in result)', async () => {
        tenantDb.controlTestRun.groupBy.mockResolvedValueOnce([]);
        const out = await effectivenessFor('c-1', 30);
        expect(out.windowDays).toBe(30);
        // The cutoff in the query is also derived from windowDays.
        const call = tenantDb.controlTestRun.groupBy.mock.calls[0][0];
        const cutoff = call.where.executedAt.gte as Date;
        const expected30 = new Date();
        expected30.setDate(expected30.getDate() - 30);
        const drift30 = Math.abs(cutoff.getTime() - expected30.getTime());
        expect(drift30).toBeLessThan(24 * 60 * 60 * 1000);
    });

    it('queries only COMPLETED runs for this tenant + control', async () => {
        tenantDb.controlTestRun.groupBy.mockResolvedValueOnce([]);
        await effectivenessFor('ctrl-X');
        const call = tenantDb.controlTestRun.groupBy.mock.calls[0][0];
        expect(call.where.status).toBe('COMPLETED');
        expect(call.where.tenantId).toBe('tenant-1');
        // Canonical batched shape: a one-element `in` list.
        expect(call.where.controlId.in).toEqual(['ctrl-X']);
    });

    it('default window is 90 days', async () => {
        tenantDb.controlTestRun.groupBy.mockResolvedValueOnce([]);
        const out = await effectivenessFor('c-1');
        expect(out.windowDays).toBe(90);
    });
});
