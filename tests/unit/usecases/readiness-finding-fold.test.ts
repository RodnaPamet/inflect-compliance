/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks + fake
 * Prisma tx shims mirror runtime contracts; per-line typing has poor
 * cost/benefit in test files (codebase-standard file-level disable). */
/**
 * feat/audit-cycle-unify — readiness folds REAL open Findings.
 *
 * Pre-this-change `computeReadiness` counted "open issues" only from
 * `Task` rows (type CONTROL_GAP / AUDIT_FINDING). This locks in the new
 * behaviour: an OPEN `Finding` raised on an audit that belongs to the
 * cycle (Audit.auditCycleId = cycleId) now raises the cycle's issue
 * count and therefore lowers readiness.
 *
 * Drives the GENERIC scoring path (custom framework key) with a fake
 * tenant-tx that exposes every method each stage touches, so the test
 * is insensitive to call ordering.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));
jest.mock('../../../src/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../src/app-layer/policies/audit-readiness.policies', () => ({
    assertCanViewPack: jest.fn(),
}));

import { computeReadiness, scoreReadiness } from '@/app-layer/usecases/audit-readiness/scoring';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<typeof runInTenantContext>;

function fakeTdb(findingCount: number, taskCount: number, frameworkKey = 'CUSTOMX') {
    return {
        auditCycle: {
            findFirst: jest.fn().mockResolvedValue({
                id: 'cyc1',
                tenantId: 't1',
                // CUSTOMX → GENERIC fallback; 'NIS2' → NIS2 profile.
                frameworkKey,
            }),
        },
        tenant: { findUnique: jest.fn().mockResolvedValue({ readinessWeightsJson: null }) },
        framework: { findFirst: jest.fn().mockResolvedValue(null) },
        frameworkRequirement: { findMany: jest.fn().mockResolvedValue([]) },
        controlRequirementLink: { findMany: jest.fn().mockResolvedValue([]) },
        control: { findMany: jest.fn().mockResolvedValue([]) },
        evidence: { findMany: jest.fn().mockResolvedValue([]) },
        policy: { findMany: jest.fn().mockResolvedValue([]) },
        // GENERIC uses task.count; NIS2 uses task.findMany.
        task: { count: jest.fn().mockResolvedValue(taskCount), findMany: jest.fn().mockResolvedValue([]) },
        finding: { count: jest.fn().mockResolvedValue(findingCount) },
        readinessSnapshot: { create: jest.fn().mockResolvedValue({}) },
    };
}

describe('computeReadiness folds open Findings into the issue count', () => {
    it('an open Finding on the cycle raises issues.open and lowers the issue score', async () => {
        const tdb = fakeTdb(/* findings */ 2, /* tasks */ 0);
        mockRunInTx.mockImplementation(async (_ctx: any, fn: any) => fn(tdb));

        const result = await computeReadiness(makeRequestContext('ADMIN'), 'cyc1');

        // 0 task issues + 2 open findings = 2 → issueScore = 100 - 2*5 = 90.
        expect(result.breakdown.issues.open).toBe(2);
        expect(result.breakdown.issues.score).toBe(90);

        // The finding count query targets open findings on the cycle's audits
        // (now via an OR so framework-scoped self-assessment findings can join).
        const whereArg = tdb.finding.count.mock.calls[0][0].where;
        expect(whereArg.status).toEqual({ not: 'CLOSED' });
        expect(whereArg.OR).toContainEqual({ audit: { auditCycleId: 'cyc1' } });
        // A non-NIS2 cycle does NOT broaden to sourceKind matching.
        expect(whereArg.OR).not.toContainEqual(
            expect.objectContaining({ sourceKind: 'NIS2_SELF_ASSESSMENT' }),
        );
    });

    it('zero findings leaves the issue score at 100 (no penalty)', async () => {
        const tdb = fakeTdb(0, 0);
        mockRunInTx.mockImplementation(async (_ctx: any, fn: any) => fn(tdb));

        const result = await computeReadiness(makeRequestContext('ADMIN'), 'cyc1');

        expect(result.breakdown.issues.open).toBe(0);
        expect(result.breakdown.issues.score).toBe(100);
    });

    it('a NIS2 cycle also counts NIS2 self-assessment findings (auditId null)', async () => {
        // feat/audit-cycle-unify — NIS2 gap-findings are materialised with no
        // fieldwork audit, so the count query must OR in a sourceKind match for
        // the NIS2 cycle. This is the NIS2-finding → readiness path.
        const tdb = fakeTdb(/* findings */ 1, /* tasks */ 0, 'NIS2');
        mockRunInTx.mockImplementation(async (_ctx: any, fn: any) => fn(tdb));

        const result = await computeReadiness(makeRequestContext('ADMIN'), 'cyc1');

        const whereArg = tdb.finding.count.mock.calls[0][0].where;
        expect(whereArg.OR).toContainEqual({ audit: { auditCycleId: 'cyc1' } });
        expect(whereArg.OR).toContainEqual({ auditId: null, sourceKind: 'NIS2_SELF_ASSESSMENT' });
        // The single open finding is folded into the NIS2 issue count.
        expect(result.breakdown.issues.open).toBe(1);
    });
});

/**
 * readiness-reconcile — NIS2 self-assessment is TENANT-WIDE, so it must
 * fold into exactly ONE canonical NIS2 cycle (the oldest). A second NIS2
 * cycle must NOT re-count the same self-assessment gaps, or two NIS2 cycles
 * would double-penalize identically.
 *
 * The fake's `auditCycle.findFirst` branches on the query: the canonical
 * lookup (`where.frameworkKey === 'NIS2'`, orderBy createdAt) always returns
 * the oldest cycle id; the cycle-load returns the requested id.
 */
function nis2FakeTdb(scoredCycleId: string, canonicalCycleId: string, findingCount = 3) {
    return {
        auditCycle: {
            findFirst: jest.fn().mockImplementation((args: any) => {
                if (args?.where?.frameworkKey === 'NIS2' && args?.orderBy) {
                    return Promise.resolve({ id: canonicalCycleId });
                }
                return Promise.resolve({ id: scoredCycleId, tenantId: 't1', frameworkKey: 'NIS2' });
            }),
        },
        tenant: { findUnique: jest.fn().mockResolvedValue({ readinessWeightsJson: null }) },
        framework: { findFirst: jest.fn().mockResolvedValue(null) },
        frameworkRequirement: { findMany: jest.fn().mockResolvedValue([]) },
        controlRequirementLink: { findMany: jest.fn().mockResolvedValue([]) },
        control: { findMany: jest.fn().mockResolvedValue([]) },
        evidence: { findMany: jest.fn().mockResolvedValue([]) },
        policy: { findMany: jest.fn().mockResolvedValue([]) },
        task: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]) },
        finding: { count: jest.fn().mockResolvedValue(findingCount) },
        readinessSnapshot: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
        },
    };
}

describe('NIS2 self-assessment folds into ONE canonical cycle only', () => {
    it('the canonical (oldest) NIS2 cycle folds the self-assessment findings', async () => {
        const tdb = nis2FakeTdb(/* scored */ 'canon', /* canonical */ 'canon');
        mockRunInTx.mockImplementation(async (_ctx: any, fn: any) => fn(tdb));

        await scoreReadiness(makeRequestContext('ADMIN'), 'canon');

        const whereArg = tdb.finding.count.mock.calls[0][0].where;
        expect(whereArg.OR).toContainEqual({ auditId: null, sourceKind: 'NIS2_SELF_ASSESSMENT' });
    });

    it('a SECOND (non-canonical) NIS2 cycle does NOT re-count the self-assessment', async () => {
        const tdb = nis2FakeTdb(/* scored */ 'cyc2', /* canonical */ 'canon');
        mockRunInTx.mockImplementation(async (_ctx: any, fn: any) => fn(tdb));

        await scoreReadiness(makeRequestContext('ADMIN'), 'cyc2');

        const whereArg = tdb.finding.count.mock.calls[0][0].where;
        // Fieldwork findings still scoped to THIS cycle...
        expect(whereArg.OR).toContainEqual({ audit: { auditCycleId: 'cyc2' } });
        // ...but the tenant-wide self-assessment is NOT folded here — it
        // belongs to the canonical cycle, so no double-penalty.
        expect(whereArg.OR).not.toContainEqual(
            expect.objectContaining({ sourceKind: 'NIS2_SELF_ASSESSMENT' }),
        );
    });
});

describe('compute vs persist — snapshot write is deliberate + deduped', () => {
    it('scoreReadiness computes WITHOUT persisting a snapshot', async () => {
        const tdb = fakeTdb(0, 0);
        mockRunInTx.mockImplementation(async (_ctx: any, fn: any) => fn(tdb));

        await scoreReadiness(makeRequestContext('ADMIN'), 'cyc1');

        expect((tdb.readinessSnapshot.create as jest.Mock)).not.toHaveBeenCalled();
    });

    it('computeReadiness persists a snapshot when the score moved', async () => {
        const tdb: any = fakeTdb(0, 0);
        // Latest snapshot holds a DIFFERENT score → movement → persist.
        tdb.readinessSnapshot.findFirst = jest.fn().mockResolvedValue({ score: 42 });
        mockRunInTx.mockImplementation(async (_ctx: any, fn: any) => fn(tdb));

        await computeReadiness(makeRequestContext('ADMIN'), 'cyc1');

        expect(tdb.readinessSnapshot.create).toHaveBeenCalledTimes(1);
    });

    it('computeReadiness DEDUPES — no snapshot when the score is unchanged', async () => {
        const tdb: any = fakeTdb(0, 0);
        mockRunInTx.mockImplementation(async (_ctx: any, fn: any) => fn(tdb));
        // First compute the score the dedup will compare against (0 findings +
        // 0 tasks → a stable score), then seed the latest snapshot with it.
        const computed = await scoreReadiness(makeRequestContext('ADMIN'), 'cyc1');
        tdb.readinessSnapshot.findFirst = jest.fn().mockResolvedValue({ score: computed.score });

        await computeReadiness(makeRequestContext('ADMIN'), 'cyc1');

        expect(tdb.readinessSnapshot.create).not.toHaveBeenCalled();
    });
});
