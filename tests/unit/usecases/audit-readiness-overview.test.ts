/**
 * Unit tests for src/app-layer/usecases/audit-readiness/overview.ts
 *
 * The overview orchestrator collapses the previous 1+N waterfall on
 * the readiness overview page into one server-side aggregation. The
 * load-bearing assertions:
 *
 *   1. Returns one entry in `scoresByCycleId` per cycle whose
 *      `computeReadiness` resolved.
 *   2. A failing cycle does NOT take the whole call down — its id
 *      is simply absent from `scoresByCycleId` (the page renders
 *      that cycle without a score, matching the prior client-side
 *      Promise.all + per-cycle try/catch behaviour).
 *   3. `listAuditCycles` and `scoreReadiness` are called via the
 *      orchestrator (delegated) — i.e. permission gates and other
 *      invariants from those functions still apply.
 *   4. The overview is a READ surface (visited on every list nav), so it
 *      must delegate to the COMPUTE-ONLY `scoreReadiness` — NOT the
 *      snapshot-persisting `computeReadiness`. Persisting per cycle on
 *      every overview visit was the write-amplification that polluted the
 *      readiness trend; the mock below asserts `computeReadiness` is not
 *      even imported into this path.
 */

jest.mock('../../../src/app-layer/usecases/audit-readiness/cycles', () => ({
    listAuditCycles: jest.fn(),
}));

// Mock BOTH: scoreReadiness is the compute-only path the overview must use;
// computeReadiness is the persist path it must NOT touch.
jest.mock('../../../src/app-layer/usecases/audit-readiness/scoring', () => ({
    scoreReadiness: jest.fn(),
    computeReadiness: jest.fn(),
}));

import { getReadinessOverview } from '@/app-layer/usecases/audit-readiness/overview';
import { listAuditCycles } from '@/app-layer/usecases/audit-readiness/cycles';
import { scoreReadiness, computeReadiness } from '@/app-layer/usecases/audit-readiness';
import { makeRequestContext } from '../../helpers/make-context';

const mockList = listAuditCycles as jest.MockedFunction<typeof listAuditCycles>;
const mockCompute = scoreReadiness as jest.MockedFunction<typeof scoreReadiness>;
const mockPersist = computeReadiness as jest.MockedFunction<typeof computeReadiness>;

beforeEach(() => {
    jest.clearAllMocks();
});

const cycle = (id: string, name = 'X') =>
    ({ id, name, frameworkKey: 'ISO27001', frameworkVersion: '2022' }) as Awaited<
        ReturnType<typeof listAuditCycles>
    >[number];

const score = (n: number) =>
    // Cast through unknown — the test fixture is a partial of the
    // full ReadinessResult; we only assert on `.score` so the rest
    // is intentionally minimal.
    ({
        score: n,
        breakdown: {
            coverage: { score: n, weight: 1, mapped: 0, total: 0 },
            evidence: { score: n, weight: 1, withEvidence: 0, total: 0 },
            issues: { score: n, weight: 1, open: 0 },
        },
        gaps: [],
        recommendations: [],
    }) as unknown as Awaited<ReturnType<typeof computeReadiness>>;

describe('getReadinessOverview', () => {
    it('returns cycles plus a score per cycle when all computations succeed', async () => {
        const ctx = makeRequestContext('ADMIN');
        const cycles = [cycle('a'), cycle('b')];
        mockList.mockResolvedValue(cycles);
        mockCompute.mockImplementation(async (_ctx, id) =>
            id === 'a' ? score(80) : score(60),
        );

        const out = await getReadinessOverview(ctx);

        expect(out.cycles).toBe(cycles);
        expect(Object.keys(out.scoresByCycleId).sort()).toEqual(['a', 'b']);
        expect(out.scoresByCycleId.a.score).toBe(80);
        expect(out.scoresByCycleId.b.score).toBe(60);
        // One scoreReadiness (compute-only) per cycle, in parallel (called
        // twice before any resolves — Promise.allSettled).
        expect(mockCompute).toHaveBeenCalledTimes(2);
        // Compute-without-persist: the overview NEVER calls the
        // snapshot-persisting computeReadiness — no write-amplification.
        expect(mockPersist).not.toHaveBeenCalled();
    });

    it('omits a cycle from scoresByCycleId when its computeReadiness rejects', async () => {
        const ctx = makeRequestContext('ADMIN');
        mockList.mockResolvedValue([cycle('a'), cycle('b'), cycle('c')]);
        mockCompute.mockImplementation(async (_ctx, id) => {
            if (id === 'b') throw new Error('boom');
            return score(70);
        });

        const out = await getReadinessOverview(ctx);

        expect(Object.keys(out.scoresByCycleId).sort()).toEqual(['a', 'c']);
        expect(out.scoresByCycleId.a.score).toBe(70);
        expect(out.scoresByCycleId.c.score).toBe(70);
        expect(out.scoresByCycleId.b).toBeUndefined();
    });

    it('returns an empty score map when there are no cycles', async () => {
        const ctx = makeRequestContext('ADMIN');
        mockList.mockResolvedValue([]);

        const out = await getReadinessOverview(ctx);

        expect(out.cycles).toEqual([]);
        expect(out.scoresByCycleId).toEqual({});
        expect(mockCompute).not.toHaveBeenCalled();
    });

    it('survives every cycle failing — returns the cycle list with an empty score map', async () => {
        const ctx = makeRequestContext('ADMIN');
        mockList.mockResolvedValue([cycle('a'), cycle('b')]);
        mockCompute.mockRejectedValue(new Error('all bad'));

        const out = await getReadinessOverview(ctx);

        expect(out.cycles).toHaveLength(2);
        expect(out.scoresByCycleId).toEqual({});
    });
});
