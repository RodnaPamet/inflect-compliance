/**
 * `runExternalWriteDispatchJob` counts the per-tenant halves it isolated
 * (#5307).
 *
 * Each of the three halves — dispatch, reconcile, grant-expiry — runs in its
 * own try so one tenant's fault cannot stop the others. That isolation used to
 * be silent in the result: a sweep in which every tenant threw returned the
 * same shape as one in which nothing was due, and the executor reported it as
 * a success. `failedTenantPasses` is what the executor now turns into a failed
 * run; these tests hold that it counts every isolated throw and nothing else.
 */
jest.mock('@/lib/prisma', () => ({ prisma: {} }));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const runExternalWriteDispatch = jest.fn();
const tenantsWithPendingExternalWrites = jest.fn();
jest.mock('@/app-layer/usecases/external-write-dispatch', () => ({
    runExternalWriteDispatch: (...a: unknown[]) => runExternalWriteDispatch(...a),
    tenantsWithPendingExternalWrites: (...a: unknown[]) => tenantsWithPendingExternalWrites(...a),
}));

const reconcileAcceptedExternalWrites = jest.fn();
const verifyGrantExpiry = jest.fn();
jest.mock('@/app-layer/usecases/external-write-reconcile', () => ({
    reconcileAcceptedExternalWrites: (...a: unknown[]) => reconcileAcceptedExternalWrites(...a),
    tenantsWithAcceptedExternalWrites: jest.fn(async () => []),
    verifyGrantExpiry: (...a: unknown[]) => verifyGrantExpiry(...a),
    tenantsWithUnverifiedGrantExpiry: jest.fn(async () => []),
}));

import { runExternalWriteDispatchJob } from '@/app-layer/jobs/external-write-dispatch';

const dispatchOk = {
    scanned: 1, applied: 1, refused: 0, indeterminate: 0, inFlight: 0, accepted: 0,
};
const reconcileOk = {
    scanned: 0, promoted: 0, notYet: 0, unreadable: 0, unverifiable: 0, indeterminate: 0,
};
const expiryOk = {
    scanned: 0, confirmedExpired: 0, raised: 0, alreadyRaised: 0, unreadable: 0, raiseFailed: 0,
};

beforeEach(() => {
    jest.clearAllMocks();
    tenantsWithPendingExternalWrites.mockResolvedValue(['t1', 't2']);
    runExternalWriteDispatch.mockResolvedValue(dispatchOk);
    reconcileAcceptedExternalWrites.mockResolvedValue(reconcileOk);
    verifyGrantExpiry.mockResolvedValue(expiryOk);
});

describe('runExternalWriteDispatchJob — isolated failures are counted', () => {
    it('a clean sweep reports zero', async () => {
        const r = await runExternalWriteDispatchJob();
        expect(r.tenants).toBe(2);
        expect(r.applied).toBe(2);
        expect(r.failedTenantPasses).toBe(0);
    });

    it('every tenant throwing is counted, not reported as a quiet sweep', async () => {
        runExternalWriteDispatch.mockRejectedValue(new Error('shared dependency down'));
        const r = await runExternalWriteDispatchJob();
        // Still isolated: both tenants were attempted, and the other halves ran.
        expect(runExternalWriteDispatch).toHaveBeenCalledTimes(2);
        expect(reconcileAcceptedExternalWrites).toHaveBeenCalledTimes(2);
        expect(r.applied).toBe(0);
        expect(r.failedTenantPasses).toBe(2);
    });

    it('counts a throw in each half separately', async () => {
        tenantsWithPendingExternalWrites.mockResolvedValue(['t1']);
        reconcileAcceptedExternalWrites.mockRejectedValue(new Error('reconcile down'));
        verifyGrantExpiry.mockRejectedValue(new Error('expiry down'));
        const r = await runExternalWriteDispatchJob();
        expect(r.applied).toBe(1);
        expect(r.failedTenantPasses).toBe(2);
    });
});
