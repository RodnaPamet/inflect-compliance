/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks. */
/**
 * Unit tests for `src/app-layer/usecases/test-readiness.ts` —
 * framework-aware test coverage scoring.
 *
 * R4-P3 #1 — the rollup was collapsed from 1 + 3×N transactions into ONE
 * transaction with four batched queries: framework.findMany +
 * controlRequirementLink.findMany (cross-framework, nested requirement) +
 * controlTestPlan.groupBy + controlTestRun.groupBy. These tests stub that
 * shape and assert the computed FrameworkTestReadiness per scenario:
 *   - policy gate (assertCanReadTests)
 *   - framework skipped when no controls map (per-framework loop, in memory)
 *   - coverage / passRate formulas + their zero-denominator guards
 *   - PASS vs non-PASS aggregation
 *   - empty-frameworks fast path (returns [])
 */

const policyCalls: string[] = [];

jest.mock('@/app-layer/policies/test.policies', () => ({
    assertCanReadTests: jest.fn(() => policyCalls.push('read-tests')),
}));

const tenantDb: any = {
    framework: { findMany: jest.fn() },
    controlRequirementLink: { findMany: jest.fn() },
    controlTestPlan: { groupBy: jest.fn() },
    controlTestRun: { groupBy: jest.fn() },
};

jest.mock('@/lib/db-context', () => {
    const actual = jest.requireActual('@/lib/db-context');
    return {
        ...actual,
        runInTenantContext: jest.fn(async (_ctx: any, cb: any) => cb(tenantDb)),
    };
});

import { computeTestReadiness } from '@/app-layer/usecases/test-readiness';
import { assertCanReadTests } from '@/app-layer/policies/test.policies';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => {
    policyCalls.length = 0;
    tenantDb.framework.findMany.mockReset();
    tenantDb.controlRequirementLink.findMany.mockReset();
    tenantDb.controlTestPlan.groupBy.mockReset();
    tenantDb.controlTestRun.groupBy.mockReset();
    // Sensible empty defaults; individual tests override.
    tenantDb.controlTestPlan.groupBy.mockResolvedValue([]);
    tenantDb.controlTestRun.groupBy.mockResolvedValue([]);
});

const ctx = makeRequestContext('ADMIN');

/** Build a groupBy fixture for plans: one row per control with an ACTIVE plan. */
const planGroups = (controlIds: string[]) => controlIds.map((controlId) => ({ controlId }));
/** Build a groupBy fixture for runs: one row per (control, result) with a count. */
const runGroups = (runs: Array<{ controlId: string; result: 'PASS' | 'FAIL' | 'INCONCLUSIVE' }>) => {
    const acc = new Map<string, number>();
    for (const r of runs) {
        const k = `${r.controlId}|${r.result}`;
        acc.set(k, (acc.get(k) ?? 0) + 1);
    }
    return [...acc.entries()].map(([k, count]) => {
        const [controlId, result] = k.split('|');
        return { controlId, result, _count: { _all: count } };
    });
};

describe('computeTestReadiness — policy + empty paths', () => {
    it('invokes assertCanReadTests before any DB read', async () => {
        tenantDb.framework.findMany.mockResolvedValue([]);
        await computeTestReadiness(ctx);
        expect(assertCanReadTests).toHaveBeenCalledWith(ctx);
        expect(policyCalls).toEqual(['read-tests']);
    });

    it('returns [] when no frameworks exist', async () => {
        tenantDb.framework.findMany.mockResolvedValue([]);
        const out = await computeTestReadiness(ctx);
        expect(out).toEqual([]);
        // No mapping query when there are no frameworks.
        expect(tenantDb.controlRequirementLink.findMany).not.toHaveBeenCalled();
    });

    it('returns [] (and skips plan/run rollup) when no controls map to any framework', async () => {
        tenantDb.framework.findMany.mockResolvedValue([
            { id: 'fw-1', key: 'iso', name: 'ISO 27001' },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValue([]);
        const out = await computeTestReadiness(ctx);
        expect(out).toEqual([]);
        // Empty control set short-circuits before the groupBy rollups.
        expect(tenantDb.controlTestPlan.groupBy).not.toHaveBeenCalled();
        expect(tenantDb.controlTestRun.groupBy).not.toHaveBeenCalled();
    });
});

describe('computeTestReadiness — coverage formulas', () => {
    function setupFw(opts: {
        controlIds: string[];
        planControlIds: string[];
        runs: Array<{ controlId: string; result: 'PASS' | 'FAIL' | 'INCONCLUSIVE' }>;
        frameworkId?: string;
    }) {
        const fid = opts.frameworkId ?? 'fw-1';
        tenantDb.framework.findMany.mockResolvedValue([
            { id: fid, key: 'iso', name: 'ISO 27001' },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValue(
            opts.controlIds.map((id) => ({ controlId: id, requirement: { frameworkId: fid } })),
        );
        tenantDb.controlTestPlan.groupBy.mockResolvedValue(planGroups(opts.planControlIds));
        tenantDb.controlTestRun.groupBy.mockResolvedValue(runGroups(opts.runs));
    }

    it('happy path — 4 controls, 3 plans, 2 recent runs (1 PASS) yields proportional coverage', async () => {
        setupFw({
            controlIds: ['c1', 'c2', 'c3', 'c4'],
            planControlIds: ['c1', 'c2', 'c3'],
            runs: [
                { controlId: 'c1', result: 'PASS' },
                { controlId: 'c2', result: 'FAIL' },
            ],
        });
        const out = await computeTestReadiness(ctx);
        expect(out).toEqual([
            {
                frameworkKey: 'iso',
                frameworkName: 'ISO 27001',
                totalMappedControls: 4,
                withTestPlan: 3,
                testPlanCoverage: 75,
                withRecentRun: 2,
                testRunCoverage: 50,
                passRate: 50,
                recentRuns: 2,
                recentPasses: 1,
            },
        ]);
    });

    it('zero plans + zero runs yields 0% across the board', async () => {
        setupFw({ controlIds: ['c1', 'c2'], planControlIds: [], runs: [] });
        const out = await computeTestReadiness(ctx);
        expect(out[0]).toMatchObject({
            withTestPlan: 0,
            testPlanCoverage: 0,
            withRecentRun: 0,
            testRunCoverage: 0,
            passRate: 0,
            recentRuns: 0,
            recentPasses: 0,
        });
    });

    it('all runs PASS → passRate 100', async () => {
        setupFw({
            controlIds: ['c1'],
            planControlIds: ['c1'],
            runs: [
                { controlId: 'c1', result: 'PASS' },
                { controlId: 'c1', result: 'PASS' },
            ],
        });
        const out = await computeTestReadiness(ctx);
        expect(out[0].passRate).toBe(100);
        expect(out[0].recentPasses).toBe(2);
        expect(out[0].recentRuns).toBe(2);
    });

    it('no PASS results → passRate 0 (the PASS filter branch)', async () => {
        setupFw({
            controlIds: ['c1'],
            planControlIds: ['c1'],
            runs: [
                { controlId: 'c1', result: 'FAIL' },
                { controlId: 'c1', result: 'INCONCLUSIVE' },
            ],
        });
        const out = await computeTestReadiness(ctx);
        expect(out[0].passRate).toBe(0);
        expect(out[0].recentPasses).toBe(0);
        expect(out[0].recentRuns).toBe(2);
    });

    it('dedupes control IDs across multiple mapped requirements', async () => {
        tenantDb.framework.findMany.mockResolvedValue([
            { id: 'fw-1', key: 'iso', name: 'ISO 27001' },
        ]);
        tenantDb.controlRequirementLink.findMany.mockResolvedValue([
            { controlId: 'c1', requirement: { frameworkId: 'fw-1' } },
            { controlId: 'c1', requirement: { frameworkId: 'fw-1' } },
            { controlId: 'c2', requirement: { frameworkId: 'fw-1' } },
        ]);
        const out = await computeTestReadiness(ctx);
        expect(out[0].totalMappedControls).toBe(2);
    });

    it('rolls up plans only for ACTIVE plans, scoped to the mapped controls + tenant', async () => {
        setupFw({ controlIds: ['c1'], planControlIds: [], runs: [] });
        await computeTestReadiness(ctx);
        const call = tenantDb.controlTestPlan.groupBy.mock.calls[0][0];
        expect(call.by).toEqual(['controlId']);
        expect(call.where.status).toBe('ACTIVE');
        expect(call.where.tenantId).toBe('tenant-1');
        expect(call.where.controlId).toEqual({ in: ['c1'] });
    });

    it('rolls up runs only for COMPLETED status in the last 90 days', async () => {
        setupFw({ controlIds: ['c1'], planControlIds: [], runs: [] });
        await computeTestReadiness(ctx);
        const call = tenantDb.controlTestRun.groupBy.mock.calls[0][0];
        expect(call.by).toEqual(['controlId', 'result']);
        expect(call.where.status).toBe('COMPLETED');
        expect(call.where.executedAt.gte).toBeInstanceOf(Date);
        const cutoff = call.where.executedAt.gte as Date;
        const expected = new Date();
        expected.setDate(expected.getDate() - 90);
        const drift = Math.abs(cutoff.getTime() - expected.getTime());
        expect(drift).toBeLessThan(24 * 60 * 60 * 1000);
    });

    it('handles multiple frameworks, one of which has zero mapped controls', async () => {
        tenantDb.framework.findMany.mockResolvedValue([
            { id: 'fw-1', key: 'iso', name: 'ISO 27001' },
            { id: 'fw-2', key: 'soc2', name: 'SOC 2' },
        ]);
        // One cross-framework mapping query: fw-1 has c1, fw-2 has nothing.
        tenantDb.controlRequirementLink.findMany.mockResolvedValue([
            { controlId: 'c1', requirement: { frameworkId: 'fw-1' } },
        ]);
        tenantDb.controlTestPlan.groupBy.mockResolvedValue(planGroups(['c1']));
        tenantDb.controlTestRun.groupBy.mockResolvedValue([]);
        const out = await computeTestReadiness(ctx);
        expect(out.map((r) => r.frameworkKey)).toEqual(['iso']);
        expect(out[0].withTestPlan).toBe(1);
    });
});
